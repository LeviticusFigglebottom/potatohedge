/**
 * DTCC Swap Data Provider
 *
 * Fetches equity swap maturity data from the DTCC Public Price Dissemination
 * (pddata.dtcc.com). SEC-mandated public data showing all open security-based
 * swaps including total return swaps on equities.
 *
 * Key insight: When swaps mature, dealers must unwind hedges — creating
 * directional flow pressure. Clusters of maturities = forced rebalancing.
 */

import { inflateRawSync } from 'zlib';

export interface SwapData {
  maturitiesToday: number;
  notionalToday: number;
  maturitiesWeek: number;
  notionalWeek: number;
  totalOpen: number;
  totalNotional: number;
}

// In-memory cache — swap data changes daily, no need to refetch intraday
let swapCache: { data: Map<string, SwapData>; timestamp: number } | null = null;
const CACHE_TTL = 3600_000; // 1 hour

/**
 * Minimal ZIP extractor using Node's built-in zlib.
 * Handles the common case: single deflate-compressed file in a ZIP archive.
 */
function extractFirstFileFromZip(buf: Buffer): string {
  // ZIP local file header signature: PK\x03\x04
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Not a ZIP file');
  }

  const compressionMethod = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const filenameLength = buf.readUInt16LE(26);
  const extraLength = buf.readUInt16LE(28);
  const dataOffset = 30 + filenameLength + extraLength;

  const compressedData = buf.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) {
    // Stored (no compression)
    return compressedData.toString('utf-8');
  } else if (compressionMethod === 8) {
    // Deflate
    return inflateRawSync(compressedData).toString('utf-8');
  } else {
    throw new Error(`Unsupported ZIP compression: ${compressionMethod}`);
  }
}

/**
 * Parse swap CSV and aggregate by underlier ticker.
 * DTCC SEC equity swap fields include:
 * - Underlier ID-Leg 1 (ticker/ISIN/CUSIP)
 * - Expiration Date
 * - Notional amount-Leg 1
 */
function parseSwapCSV(csv: string, today: string, weekEnd: string): Map<string, SwapData> {
  const map = new Map<string, SwapData>();
  const lines = csv.split('\n');
  if (lines.length < 2) return map;

  // Parse header to find column indices (DTCC column names vary by report version)
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

  // Process rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV split (handles most cases; DTCC data is generally clean)
    const fields = line.split(',').map(f => f.trim().replace(/"/g, ''));

    // Skip cancelled/terminated swaps
    if (actionIdx !== -1) {
      const action = fields[actionIdx]?.toUpperCase() || '';
      if (action === 'CANCEL' || action === 'TERMINATE') continue;
    }

    const underlier = (fields[underlierIdx] || '').toUpperCase().trim();
    const expDate = (fields[expirationIdx] || '').trim().slice(0, 10); // YYYY-MM-DD
    const notional = notionalIdx !== -1 ? Math.abs(parseFloat(fields[notionalIdx]) || 0) : 0;

    if (!underlier || !expDate) continue;

    // Normalize underlier to ticker format
    // DTCC may use ISIN, CUSIP, or ticker. If it's a ticker (short alphanumeric), use directly.
    // If it's ISIN (12 chars starting with US), skip for now — mapping would require a lookup table.
    if (underlier.length > 6 || underlier.includes('.')) continue; // skip ISINs/CUSIPs

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

export async function fetchSwapData(): Promise<Map<string, SwapData>> {
  // Return cache if fresh
  if (swapCache && Date.now() - swapCache.timestamp < CACHE_TTL) {
    return swapCache.data;
  }

  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = getWeekEnd(today);

  try {
    // Try the DTCC cumulative equity report
    // The SEC equity swap data is at the SEC dashboard endpoint
    const url = `https://pddata.dtcc.com/ppd/api/report/cumulative/sec/EQUITY`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.log(`[DTCC] Fetch failed: ${res.status}`);
      return new Map();
    }

    const contentType = res.headers.get('content-type') || '';
    let csvText: string;

    if (contentType.includes('json')) {
      // Some endpoints return JSON — try to handle
      const json = await res.json();
      console.log('[DTCC] Got JSON response, keys:', Object.keys(json).slice(0, 5));
      // If it's an array of records, convert to CSV-like processing
      if (Array.isArray(json)) {
        // Process as array of objects
        const map = new Map<string, SwapData>();
        for (const record of json) {
          const underlier = (
            record['Underlier ID-Leg 1'] ||
            record['underlier_id_leg_1'] ||
            record['UNDERLIER_ID'] ||
            ''
          ).toUpperCase().trim();
          const expDate = (
            record['Expiration Date'] ||
            record['expiration_date'] ||
            record['END_DATE'] ||
            ''
          ).trim().slice(0, 10);
          const notional = Math.abs(parseFloat(
            record['Notional amount-Leg 1'] ||
            record['notional_amount_leg_1'] ||
            record['NOTIONAL_AMOUNT'] ||
            '0'
          ) || 0);

          if (!underlier || !expDate || underlier.length > 6) continue;

          let entry = map.get(underlier);
          if (!entry) {
            entry = { maturitiesToday: 0, notionalToday: 0, maturitiesWeek: 0, notionalWeek: 0, totalOpen: 0, totalNotional: 0 };
            map.set(underlier, entry);
          }
          entry.totalOpen++;
          entry.totalNotional += notional;
          if (expDate === today) { entry.maturitiesToday++; entry.notionalToday += notional; }
          if (expDate >= today && expDate <= weekEnd) { entry.maturitiesWeek++; entry.notionalWeek += notional; }
        }
        swapCache = { data: map, timestamp: Date.now() };
        console.log(`[DTCC] Parsed ${json.length} JSON records → ${map.size} tickers`);
        return map;
      }
      return new Map();
    }

    // Binary response — likely ZIP
    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
      // ZIP file (PK header)
      csvText = extractFirstFileFromZip(buffer);
    } else {
      // Raw CSV
      csvText = buffer.toString('utf-8');
    }

    const map = parseSwapCSV(csvText, today, weekEnd);
    swapCache = { data: map, timestamp: Date.now() };
    console.log(`[DTCC] Parsed ${csvText.split('\n').length} rows → ${map.size} tickers with swap data`);
    return map;
  } catch (err) {
    console.error('[DTCC] Error fetching swap data:', err instanceof Error ? err.message : String(err));
    return new Map();
  }
}

/**
 * Get swap data for a single ticker. Returns null if no data available.
 */
export async function getSwapDataForTicker(symbol: string): Promise<SwapData | null> {
  const map = await fetchSwapData();
  return map.get(symbol.toUpperCase()) || null;
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
}> {
  const map = await fetchSwapData();
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
    if (data.maturitiesToday > 0) {
      perTicker.push({ symbol, count: data.maturitiesToday, notional: data.notionalToday });
    }
  }

  perTicker.sort((a, b) => b.notional - a.notional);

  return {
    totalMaturitiesToday,
    totalNotionalToday,
    totalMaturitiesWeek,
    totalNotionalWeek,
    topMaturities: perTicker.slice(0, 20),
  };
}
