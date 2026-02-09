/**
 * FINRA Data Provider
 *
 * 1. Reg SHO Threshold List — daily list of securities with persistent FTDs
 *    Source: https://api.finra.org/data/group/otcMarket/name/ThresholdList
 *
 * 2. Short Interest — bi-monthly publication of short positions
 *    Source: https://api.finra.org/data/group/otcMarket/name/equityShortInterestStandardized
 *
 * No authentication required for Market Transparency APIs.
 */

export interface ShortInterestData {
  shortInterest: number;        // total shares short
  avgDailyVolume: number;       // for computing days-to-cover
  daysToCover: number;          // shortInterest / avgDailyVolume
  settlementDate: string;       // date of the SI report
  percentOfFloat?: number;      // if available
}

export interface RegSHOResult {
  tickers: Set<string>;
  asOf: string; // trade date of the data
}

export interface ShortInterestResult {
  data: Map<string, ShortInterestData>;
  asOf: string; // settlement date of the data
}

// ─── Caches ──────────────────────────────────────────────────
let regSHOCache: { result: RegSHOResult; timestamp: number } | null = null;
let shortInterestCache: { result: ShortInterestResult; timestamp: number } | null = null;
const REG_SHO_TTL = 3600_000;     // 1 hour
const SI_TTL = 3600_000 * 4;       // 4 hours (data only updates bi-monthly)

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
    if (dow !== 0 && dow !== 6) {
      days.push(candidate.toISOString().slice(0, 10));
    }
    if (i > 20) break;
  }
  return days;
}

// ─── Reg SHO Threshold List ──────────────────────────────────

/**
 * Fetch the current Reg SHO Threshold list from FINRA.
 * Tries the most recent business day first, then looks back up to 7 days.
 */
export async function fetchRegSHOThreshold(): Promise<Set<string>> {
  if (regSHOCache && Date.now() - regSHOCache.timestamp < REG_SHO_TTL) {
    return regSHOCache.result.tickers;
  }

  const recentDays = getRecentBusinessDays(3); // Only check last 3 business days

  // Try the FINRA API with correct dataset name: ThresholdList
  for (const tradeDate of recentDays) {
    try {
      const tickers = new Set<string>();

      const res = await fetch('https://api.finra.org/data/group/otcMarket/name/ThresholdList', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          fields: ['issueSymbolIdentifier', 'tradeDate'],
          limit: 5000,
          compareFilters: [
            {
              fieldName: 'tradeDate',
              fieldValue: tradeDate,
              compareType: 'EQUAL',
            },
          ],
        }),
        signal: AbortSignal.timeout(6000),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('json')) {
        console.log(`[FINRA] Reg SHO API: ${res.status} (${contentType}) for ${tradeDate}`);
        // If API returns non-JSON, it might be blocked. Try archive once.
        if (tradeDate === recentDays[0]) {
          const archiveTickers = await fetchRegSHOFromArchive(tradeDate);
          if (archiveTickers.size > 0) {
            regSHOCache = { result: { tickers: archiveTickers, asOf: tradeDate }, timestamp: Date.now() };
            console.log(`[FINRA] Reg SHO from archive: ${archiveTickers.size} securities (${tradeDate})`);
            return archiveTickers;
          }
        }
        continue;
      }

      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        for (const record of data) {
          const sym = (record.issueSymbolIdentifier || record.symbolCode || '').toUpperCase().trim();
          if (sym && sym.length <= 6 && /^[A-Z]+$/.test(sym)) tickers.add(sym);
        }
        if (tickers.size > 0) {
          regSHOCache = { result: { tickers, asOf: tradeDate }, timestamp: Date.now() };
          console.log(`[FINRA] Reg SHO threshold list: ${tickers.size} securities (${tradeDate})`);
          return tickers;
        }
      }
      // Empty result for this date — might be a holiday, try previous day
    } catch (err) {
      console.log(`[FINRA] Reg SHO error for ${tradeDate}:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log('[FINRA] No Reg SHO data found');
  const emptyResult: RegSHOResult = { tickers: new Set(), asOf: '' };
  regSHOCache = { result: emptyResult, timestamp: Date.now() };
  return new Set();
}

/**
 * Get the Reg SHO result with date info.
 */
export async function fetchRegSHOWithDate(): Promise<RegSHOResult> {
  await fetchRegSHOThreshold();
  return regSHOCache?.result ?? { tickers: new Set(), asOf: '' };
}

async function fetchRegSHOFromArchive(date: string): Promise<Set<string>> {
  const tickers = new Set<string>();
  const dateCompact = date.replace(/-/g, '');
  const url = `https://otce.finra.org/otce/RegSHOThreshold/download?fileDate=${dateCompact}`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'text/plain, text/csv' },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) return tickers;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('html')) return tickers;

    const text = await res.text();
    if (text.includes('<html') || text.includes('<!DOCTYPE')) return tickers;

    for (const line of text.split('\n')) {
      const parts = line.split('|');
      const sym = (parts[1] || parts[0] || '').trim().toUpperCase();
      if (sym && sym.length <= 6 && sym !== 'SYMBOL' && /^[A-Z]+$/.test(sym)) {
        tickers.add(sym);
      }
    }
  } catch { /* silent */ }

  return tickers;
}

// ─── Short Interest ──────────────────────────────────────────

/**
 * Fetch short interest data from FINRA using the standardized endpoint.
 * Returns a Map of ticker → ShortInterestData.
 * Data is bi-monthly — not real-time.
 *
 * FINRA API has a max of 100 records per request, so we paginate.
 */
export async function fetchShortInterest(): Promise<Map<string, ShortInterestData>> {
  if (shortInterestCache && Date.now() - shortInterestCache.timestamp < SI_TTL) {
    return shortInterestCache.result.data;
  }

  const map = new Map<string, ShortInterestData>();
  let asOf = '';

  // Try recent settlement dates (short interest publishes ~2x/month around 15th and end-of-month)
  // We look back up to 5 business days; if nothing found, fallback query without date
  const recentDays = getRecentBusinessDays(5);

  for (const settlementDate of recentDays) {
    try {
      const page = await fetchSIPage(settlementDate, 0);
      if (page.records.length === 0) continue;

      // Found data! Load all records for this date
      asOf = settlementDate;
      processSIRecords(page.records, map);

      // Paginate if needed (max 100 per request, cap at 10 pages = 1000 records)
      let offset = page.records.length;
      let pages = 1;
      while (page.records.length >= 100 && pages < 10) {
        const nextPage = await fetchSIPage(settlementDate, offset);
        if (nextPage.records.length === 0) break;
        processSIRecords(nextPage.records, map);
        offset += nextPage.records.length;
        pages++;
        if (nextPage.records.length < 100) break;
      }

      console.log(`[FINRA] Short interest: ${map.size} securities loaded (settlement: ${settlementDate})`);
      break; // found data, stop looking back
    } catch (err) {
      console.log(`[FINRA] SI error for ${settlementDate}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // If date-specific queries all failed, try without date filter to get whatever's latest
  if (map.size === 0) {
    try {
      const res = await fetch('https://api.finra.org/data/group/otcMarket/name/equityShortInterestStandardized', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          fields: ['issueSymbolIdentifier', 'currentShortPositionQuantity', 'averageDailyVolumeQuantity', 'daysToCoverQuantity', 'settlementDate'],
          limit: 100,
          sortFields: ['-settlementDate'],
        }),
        signal: AbortSignal.timeout(6000),
      });

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('json')) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          asOf = data[0]?.settlementDate || '';
          processSIRecords(data, map);
          console.log(`[FINRA] Short interest (no date filter): ${map.size} securities (latest: ${asOf})`);
        }
      }
    } catch { /* silent */ }
  }

  const result: ShortInterestResult = { data: map, asOf };
  shortInterestCache = { result, timestamp: Date.now() };
  return map;
}

/**
 * Get the short interest result with date info.
 */
export async function fetchShortInterestWithDate(): Promise<ShortInterestResult> {
  await fetchShortInterest();
  return shortInterestCache?.result ?? { data: new Map(), asOf: '' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchSIPage(settlementDate: string, offset: number): Promise<{ records: any[] }> {
  const res = await fetch('https://api.finra.org/data/group/otcMarket/name/equityShortInterestStandardized', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      fields: ['issueSymbolIdentifier', 'currentShortPositionQuantity', 'averageDailyVolumeQuantity', 'daysToCoverQuantity', 'settlementDate'],
      limit: 100,
      offset,
      compareFilters: [
        {
          fieldName: 'settlementDate',
          fieldValue: settlementDate,
          compareType: 'EQUAL',
        },
      ],
    }),
    signal: AbortSignal.timeout(6000),
  });

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('json')) return { records: [] };

  const data = await res.json();
  return { records: Array.isArray(data) ? data : [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processSIRecords(records: any[], map: Map<string, ShortInterestData>): void {
  for (const record of records) {
    const sym = (record.issueSymbolIdentifier || record.symbolCode || '').toUpperCase().trim();
    if (!sym || sym.length > 6 || !/^[A-Z]+$/.test(sym) || map.has(sym)) continue;

    const si = record.currentShortPositionQuantity || record.currentShortShareNumber || 0;
    const adv = record.averageDailyVolumeQuantity || record.averageShortShareNumber || 0;
    const dtc = record.daysToCoverQuantity || record.daysToCoverNumber || (adv > 0 ? si / adv : 0);
    const date = record.settlementDate || '';

    if (si > 0) {
      map.set(sym, {
        shortInterest: si,
        avgDailyVolume: adv,
        daysToCover: dtc,
        settlementDate: date,
      });
    }
  }
}

/**
 * Get short interest for a single ticker.
 */
export async function getShortInterestForTicker(symbol: string): Promise<ShortInterestData | null> {
  const map = await fetchShortInterest();
  return map.get(symbol.toUpperCase()) || null;
}
