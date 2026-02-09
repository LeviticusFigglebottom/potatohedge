/**
 * DTCC Swap Data Provider
 *
 * Fetches equity swap maturity data from DTCC's S3-hosted cumulative reports.
 * SEC-mandated public data showing all open security-based swaps including
 * total return swaps on equities.
 *
 * Key insight: When swaps mature, dealers must unwind hedges — creating
 * directional flow pressure. Clusters of maturities = forced rebalancing.
 *
 * Source: https://kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/
 * Proxy: Set DTCC_PROXY_URL env var to a Cloudflare Worker that proxies S3.
 *        See workers/dtcc-proxy/ for the worker code.
 */

export interface SwapData {
  maturitiesToday: number;
  notionalToday: number;
  maturitiesWeek: number;
  notionalWeek: number;
  totalOpen: number;
  totalNotional: number;
}

export interface SwapResult {
  data: Map<string, SwapData>;
  asOf: string; // YYYY-MM-DD of the report used
}

// In-memory cache — swap data changes daily, no need to refetch intraday
let swapCache: { result: SwapResult; timestamp: number } | null = null;
const CACHE_TTL = 3600_000; // 1 hour

/** Race a promise against a hard deadline. Returns fallback on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Overall budget for the entire fetchSwapData call (prevents serverless timeout).
 * Budget allows time for proxy attempt + S3 fallback. */
const TOTAL_BUDGET_MS = 6_000;

/**
 * Inflate raw deflate data using the Web API DecompressionStream.
 * Available in Node 18+ and all modern runtimes (Edge, Workers, browsers).
 * We avoid importing Node's zlib entirely because the bundler traces
 * even dynamic import('zlib') and fails on Vercel.
 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writer.write(data as any);
  writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Minimal ZIP extractor. Handles the common case: single deflate-compressed file in a ZIP archive.
 */
async function extractFirstFileFromZip(buf: Uint8Array): Promise<string> {
  // ZIP local file header signature: PK\x03\x04
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 30 || view.getUint32(0, true) !== 0x04034b50) {
    throw new Error('Not a ZIP file');
  }

  const compressionMethod = view.getUint16(8, true);
  const compressedSize = view.getUint32(18, true);
  const filenameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataOffset = 30 + filenameLength + extraLength;

  const compressedData = buf.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) {
    // Stored (no compression)
    return new TextDecoder().decode(compressedData);
  } else if (compressionMethod === 8) {
    // Deflate
    const decompressed = await inflateRaw(compressedData);
    return new TextDecoder().decode(decompressed);
  } else {
    throw new Error(`Unsupported ZIP compression: ${compressionMethod}`);
  }
}

/**
 * Parse swap CSV and aggregate by underlier ticker.
 */
function parseSwapCSV(csv: string, today: string, weekEnd: string): Map<string, SwapData> {
  const map = new Map<string, SwapData>();
  const lines = csv.split('\n');
  if (lines.length < 2) return map;

  const header = lines[0].toLowerCase();
  const cols = header.split(',').map(c => c.trim().replace(/"/g, ''));

  const underlierIdx = cols.findIndex(c =>
    c.includes('underlier') && c.includes('id') && c.includes('leg 1') && !c.includes('source')
  );
  const expirationIdx = cols.findIndex(c =>
    c.includes('expiration') || (c.includes('end') && c.includes('date')) || c.includes('maturity')
  );
  const notionalIdx = cols.findIndex(c =>
    c.includes('notional') && c.includes('leg 1') && !c.includes('currency')
  );
  const actionIdx = cols.findIndex(c =>
    c.includes('action') && c.includes('type')
  );

  if (underlierIdx === -1 || expirationIdx === -1) {
    console.log('[DTCC] Could not find required columns. Header:', cols.slice(0, 15).join(', '));
    return map;
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split(',').map(f => f.trim().replace(/"/g, ''));

    if (actionIdx !== -1) {
      const action = fields[actionIdx]?.toUpperCase() || '';
      if (action === 'CANCEL' || action === 'TERMINATE') continue;
    }

    const underlier = (fields[underlierIdx] || '').toUpperCase().trim();
    const expDate = (fields[expirationIdx] || '').trim().slice(0, 10); // YYYY-MM-DD
    const notional = notionalIdx !== -1 ? Math.abs(parseFloat(fields[notionalIdx]) || 0) : 0;

    if (!underlier || !expDate) continue;
    if (underlier.length > 6 || underlier.includes('.') || !/^[A-Z]+$/.test(underlier)) continue;

    let entry = map.get(underlier);
    if (!entry) {
      entry = { maturitiesToday: 0, notionalToday: 0, maturitiesWeek: 0, notionalWeek: 0, totalOpen: 0, totalNotional: 0 };
      map.set(underlier, entry);
    }

    entry.totalOpen++;
    entry.totalNotional += notional;

    if (expDate === today) {
      entry.maturitiesToday++;
      entry.notionalToday += notional;
    }
    if (expDate >= today && expDate <= weekEnd) {
      entry.maturitiesWeek++;
      entry.notionalWeek += notional;
    }
  }

  return map;
}

function getWeekEnd(today: string): string {
  const d = new Date(today + 'T12:00:00Z');
  const dayOfWeek = d.getUTCDay();
  const daysUntilFriday = dayOfWeek <= 5 ? 5 - dayOfWeek : 0;
  d.setUTCDate(d.getUTCDate() + daysUntilFriday);
  return d.toISOString().slice(0, 10);
}

/**
 * Get recent business days going back from today, most recent first.
 */
function getRecentBusinessDays(count: number): string[] {
  const days: string[] = [];
  const d = new Date();
  for (let i = 0; days.length < count; i++) {
    const candidate = new Date(d);
    candidate.setDate(d.getDate() - i);
    const dow = candidate.getDay();
    if (dow !== 0 && dow !== 6) { // skip weekends
      days.push(candidate.toISOString().slice(0, 10));
    }
    if (i > 14) break; // safety limit
  }
  return days;
}

/**
 * Format a YYYY-MM-DD date as YYYY_MM_DD for S3 file path.
 */
function formatS3Date(date: string): string {
  return date.replace(/-/g, '_');
}

export async function fetchSwapData(): Promise<SwapResult> {
  if (swapCache && Date.now() - swapCache.timestamp < CACHE_TTL) {
    return swapCache.result;
  }

  // Wrap entire fetch in a hard budget so we never block the serverless function
  const emptyResult: SwapResult = { data: new Map(), asOf: '' };
  return withTimeout(fetchSwapDataInner(), TOTAL_BUDGET_MS, emptyResult);
}

async function fetchSwapDataInner(): Promise<SwapResult> {
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = getWeekEnd(today);
  const recentDays = getRecentBusinessDays(2);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const proxyUrl = process.env.DTCC_PROXY_URL;

  // ── Try Cloudflare Worker proxy first (bypasses S3 IP blocking) ──
  if (proxyUrl) {
    for (const reportDate of recentDays) {
      if (Date.now() > deadline - 1000) break;
      try {
        const remaining = Math.max(deadline - Date.now(), 1000);
        const res = await fetch(`${proxyUrl}?date=${reportDate}`, {
          signal: AbortSignal.timeout(Math.min(2500, remaining)),
        });

        if (!res.ok) {
          console.log(`[DTCC] Proxy returned ${res.status} for ${reportDate}`);
          continue;
        }

        const buffer = new Uint8Array(await res.arrayBuffer());
        if (buffer.length < 100) continue;

        let csvText: string;
        if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
          csvText = await extractFirstFileFromZip(buffer);
        } else {
          csvText = new TextDecoder().decode(buffer);
        }

        if (csvText.length < 50 || csvText.includes('<html')) continue;

        const map = parseSwapCSV(csvText, today, weekEnd);
        if (map.size > 0) {
          const result: SwapResult = { data: map, asOf: reportDate };
          swapCache = { result, timestamp: Date.now() };
          console.log(`[DTCC] Proxy: ${csvText.split('\n').length} rows → ${map.size} tickers (${reportDate})`);
          return result;
        }
      } catch (err) {
        console.log(`[DTCC] Proxy error for ${reportDate}:`, err instanceof Error ? err.message : String(err));
      }
    }
    console.log('[DTCC] Proxy returned no data, trying S3 direct...');
  }

  // ── Fallback: Direct S3 (blocked from most cloud IPs) ──
  for (const reportDate of recentDays) {
    if (Date.now() > deadline - 1000) break;
    const s3Date = formatS3Date(reportDate);
    const remaining = Math.max(deadline - Date.now(), 1000);
    const perReqTimeout = Math.min(2000, remaining);

    const urls = [
      `https://kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_EQUITY_${s3Date}.zip`,
      `https://kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_EQUITIES_${s3Date}.zip`,
    ];

    const results = await Promise.allSettled(urls.map(async (url) => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': '*/*',
        },
        signal: AbortSignal.timeout(perReqTimeout),
      });

      if (!res.ok) throw new Error(`${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('html') || contentType.includes('text/plain')) {
        const preview = await res.text().catch(() => '');
        if (preview.includes('<html') || preview.includes('host_not_allowed') || preview.length < 100) {
          throw new Error('Non-data response');
        }
      }

      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.length < 100) throw new Error('Too small');

      let csvText: string;
      if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
        csvText = await extractFirstFileFromZip(buffer);
      } else {
        csvText = new TextDecoder().decode(buffer);
      }

      if (csvText.length < 50 || csvText.includes('<html')) throw new Error('Invalid content');
      return csvText;
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const map = parseSwapCSV(r.value, today, weekEnd);
      if (map.size > 0) {
        const result: SwapResult = { data: map, asOf: reportDate };
        swapCache = { result, timestamp: Date.now() };
        console.log(`[DTCC] S3 direct: ${r.value.split('\n').length} rows → ${map.size} tickers (${reportDate})`);
        return result;
      }
    }
  }

  console.log('[DTCC] No data found from proxy or S3');
  const emptyResult: SwapResult = { data: new Map(), asOf: '' };
  swapCache = { result: emptyResult, timestamp: Date.now() };
  return emptyResult;
}

/**
 * Get swap data for a single ticker. Returns null if no data available.
 */
export async function getSwapDataForTicker(symbol: string): Promise<SwapData | null> {
  const { data } = await fetchSwapData();
  return data.get(symbol.toUpperCase()) || null;
}

/**
 * Get aggregate swap maturity stats for the entire market.
 */
export async function getMarketSwapSummary(): Promise<{
  totalMaturitiesToday: number;
  totalNotionalToday: number;
  totalMaturitiesWeek: number;
  totalNotionalWeek: number;
  topMaturities: { symbol: string; count: number; notional: number }[];
  asOf: string;
}> {
  const { data: map, asOf } = await fetchSwapData();
  let totalMaturitiesToday = 0;
  let totalNotionalToday = 0;
  let totalMaturitiesWeek = 0;
  let totalNotionalWeek = 0;
  const perTicker: { symbol: string; count: number; notional: number }[] = [];

  for (const [symbol, data] of map) {
    totalMaturitiesToday += data.maturitiesToday;
    totalNotionalToday += data.notionalToday;
    totalMaturitiesWeek += data.maturitiesWeek;
    totalNotionalWeek += data.notionalWeek;
    if (data.maturitiesToday > 0 || data.maturitiesWeek > 0) {
      perTicker.push({
        symbol,
        count: data.maturitiesToday || data.maturitiesWeek,
        notional: data.notionalToday || data.notionalWeek,
      });
    }
  }

  perTicker.sort((a, b) => b.notional - a.notional);

  return {
    totalMaturitiesToday,
    totalNotionalToday,
    totalMaturitiesWeek,
    totalNotionalWeek,
    topMaturities: perTicker.slice(0, 20),
    asOf,
  };
}
