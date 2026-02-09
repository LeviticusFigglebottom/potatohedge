/**
 * FINRA Data Provider
 *
 * 1. Reg SHO Threshold List — daily list of securities with persistent FTDs
 *    Source: https://api.finra.org/data/group/otcMarket/name/ThresholdList
 *
 * 2. Short Sale Volume — daily short volume per ticker (no auth required)
 *    Source: https://api.finra.org/data/group/otcMarket/name/regShoDaily
 *
 * 3. Short Interest — bi-monthly positions via CDN CSV (no auth required)
 *    Source: https://cdn.finra.org/equity/otcmarket/biweekly/shrt{YYYYMMDD}.csv
 *
 * NOTE: The equityShortInterestStandardized API requires OAuth 2.0 since mid-2022.
 * It returns 200 OK with empty array without auth. We use CDN files + regShoDaily instead.
 */

export interface ShortInterestData {
  shortInterest: number;        // total shares short (current period)
  previousShortInterest: number; // previous period's short position
  changePercent: number;         // % change from previous period
  avgDailyVolume: number;       // for computing days-to-cover
  daysToCover: number;          // shortInterest / avgDailyVolume
  settlementDate: string;       // date of the SI report
}

/** Daily short sale volume data from regShoDaily (no auth required) */
export interface ShortVolumeData {
  symbol: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  shortRatio: number;           // shortVolume / totalVolume (0-1)
  tradeDate: string;
}

export interface RegSHOResult {
  tickers: Set<string>;
  asOf: string; // trade date of the data
}

export interface ShortInterestResult {
  data: Map<string, ShortInterestData>;
  asOf: string; // settlement date of the data
}

export interface ShortVolumeResult {
  data: Map<string, ShortVolumeData>;
  asOf: string;
}

// ─── Caches ──────────────────────────────────────────────────
let regSHOCache: { result: RegSHOResult; timestamp: number } | null = null;
let shortInterestCache: { result: ShortInterestResult; timestamp: number } | null = null;
let shortVolumeCache: { result: ShortVolumeResult; timestamp: number } | null = null;
const REG_SHO_TTL = 3600_000;     // 1 hour
const SI_TTL = 3600_000 * 4;       // 4 hours (data only updates bi-monthly)
const SV_TTL = 3600_000;           // 1 hour

/** Race a promise against a hard deadline. Returns fallback on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** Overall budget for each FINRA function (prevents serverless timeout) */
const TOTAL_BUDGET_MS = 6_000;

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
 * Tries the most recent business day first, then looks back up to 2 days.
 */
export async function fetchRegSHOThreshold(): Promise<Set<string>> {
  if (regSHOCache && Date.now() - regSHOCache.timestamp < REG_SHO_TTL) {
    return regSHOCache.result.tickers;
  }

  return withTimeout(fetchRegSHOThresholdInner(), TOTAL_BUDGET_MS, new Set<string>());
}

async function fetchRegSHOThresholdInner(): Promise<Set<string>> {
  const recentDays = getRecentBusinessDays(2);
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  for (const tradeDate of recentDays) {
    if (Date.now() > deadline - 1000) break;
    try {
      const tickers = new Set<string>();
      const remaining = Math.max(deadline - Date.now(), 1000);

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
        signal: AbortSignal.timeout(Math.min(3000, remaining)),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('json')) {
        console.log(`[FINRA] Reg SHO API: ${res.status} (${contentType}) for ${tradeDate}`);
        if (tradeDate === recentDays[0] && Date.now() < deadline - 1000) {
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
    } catch (err) {
      console.log(`[FINRA] Reg SHO error for ${tradeDate}:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log('[FINRA] No Reg SHO data found');
  const emptyResult: RegSHOResult = { tickers: new Set(), asOf: '' };
  regSHOCache = { result: emptyResult, timestamp: Date.now() };
  return new Set();
}

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
      signal: AbortSignal.timeout(3000),
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

// ─── Short Sale Volume (regShoDaily — no auth) ────────────────

/**
 * Fetch daily short sale volume data from regShoDaily API.
 * No authentication required. Returns short volume ratio per ticker.
 * This is daily SHORT SALE VOLUME (flow), not bi-monthly short INTEREST (positions).
 * High short volume ratio (>50%) indicates heavy short selling activity.
 */
export async function fetchShortSaleVolume(): Promise<Map<string, ShortVolumeData>> {
  if (shortVolumeCache && Date.now() - shortVolumeCache.timestamp < SV_TTL) {
    return shortVolumeCache.result.data;
  }

  return withTimeout(fetchShortSaleVolumeInner(), TOTAL_BUDGET_MS, new Map<string, ShortVolumeData>());
}

async function fetchShortSaleVolumeInner(): Promise<Map<string, ShortVolumeData>> {
  const map = new Map<string, ShortVolumeData>();
  const recentDays = getRecentBusinessDays(3);
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let asOf = '';

  for (const tradeDate of recentDays) {
    if (Date.now() > deadline - 1000) break;
    try {
      const remaining = Math.max(deadline - Date.now(), 1000);
      const res = await fetch('https://api.finra.org/data/group/otcMarket/name/regShoDaily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          fields: ['securitiesInformationProcessorSymbolIdentifier', 'shortVolume', 'shortExemptVolume', 'totalVolume', 'tradeReportDate'],
          limit: 5000,
          compareFilters: [{
            fieldName: 'tradeReportDate',
            fieldValue: tradeDate,
            compareType: 'EQUAL',
          }],
          sortFields: ['-totalVolume'],
        }),
        signal: AbortSignal.timeout(Math.min(4000, remaining)),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('json')) {
        console.log(`[FINRA] regShoDaily: ${res.status} (${contentType}) for ${tradeDate}`);
        continue;
      }

      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) continue;

      asOf = tradeDate;
      for (const record of data) {
        const sym = (record.securitiesInformationProcessorSymbolIdentifier || '').toUpperCase().trim();
        if (!sym || sym.length > 6 || !/^[A-Z]+$/.test(sym) || map.has(sym)) continue;

        const shortVol = record.shortVolume || 0;
        const exemptVol = record.shortExemptVolume || 0;
        const totalVol = record.totalVolume || 0;
        if (totalVol <= 0) continue;

        map.set(sym, {
          symbol: sym,
          shortVolume: shortVol + exemptVol,
          shortExemptVolume: exemptVol,
          totalVolume: totalVol,
          shortRatio: (shortVol + exemptVol) / totalVol,
          tradeDate,
        });
      }

      if (map.size > 0) {
        console.log(`[FINRA] regShoDaily: ${map.size} securities (${tradeDate})`);
        break;
      }
    } catch (err) {
      console.log(`[FINRA] regShoDaily error for ${tradeDate}:`, err instanceof Error ? err.message : String(err));
    }
  }

  const result: ShortVolumeResult = { data: map, asOf };
  shortVolumeCache = { result, timestamp: Date.now() };
  return map;
}

export async function fetchShortSaleVolumeWithDate(): Promise<ShortVolumeResult> {
  await fetchShortSaleVolume();
  return shortVolumeCache?.result ?? { data: new Map(), asOf: '' };
}

// ─── Short Interest (CDN biweekly CSV — no auth) ─────────────

/**
 * Fetch short interest data from FINRA CDN biweekly CSV files.
 * The equityShortInterestStandardized API requires OAuth 2.0 since 2022
 * and returns empty arrays without auth. CDN files are freely accessible.
 *
 * Settlement dates are typically around the 15th and last business day of each month.
 * Files are published ~8-9 business days after settlement.
 */
export async function fetchShortInterest(): Promise<Map<string, ShortInterestData>> {
  if (shortInterestCache && Date.now() - shortInterestCache.timestamp < SI_TTL) {
    return shortInterestCache.result.data;
  }

  return withTimeout(fetchShortInterestInner(), TOTAL_BUDGET_MS, new Map<string, ShortInterestData>());
}

async function fetchShortInterestInner(): Promise<Map<string, ShortInterestData>> {
  const map = new Map<string, ShortInterestData>();
  let asOf = '';
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  // Generate likely settlement dates: ~15th and last business day of each month, going back 3 months
  const candidateDates = generateSettlementDates();

  for (const settleDate of candidateDates) {
    if (Date.now() > deadline - 1500) break;
    const dateCompact = settleDate.replace(/-/g, '');
    const url = `https://cdn.finra.org/equity/otcmarket/biweekly/shrt${dateCompact}.csv`;

    try {
      const remaining = Math.max(deadline - Date.now(), 1000);
      const res = await fetch(url, {
        headers: { 'Accept': 'text/csv, text/plain' },
        signal: AbortSignal.timeout(Math.min(3000, remaining)),
      });

      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('html')) continue;

      const text = await res.text();
      if (text.length < 100 || text.includes('<html') || text.includes('<!DOCTYPE')) continue;

      // Parse CSV: headers are in the first line
      const lines = text.split('\n');
      if (lines.length < 2) continue;

      const header = lines[0].toLowerCase();
      const cols = header.split('|').map(c => c.trim());

      // Find column indices (pipe-delimited: 11 columns)
      const symIdx = cols.findIndex(c => c.includes('symbol'));
      const siIdx = cols.findIndex(c => c.includes('currentshort') || c.includes('current_short'));
      const prevIdx = cols.findIndex(c => c.includes('previousshort') || c.includes('previous_short'));
      const avgIdx = cols.findIndex(c => c.includes('average') || c.includes('avg'));
      const dtcIdx = cols.findIndex(c => c.includes('daystocover') || c.includes('days_to_cover'));

      if (symIdx === -1 || siIdx === -1) {
        // Try comma-separated format
        const commaCols = header.split(',').map(c => c.trim());
        const cSymIdx = commaCols.findIndex(c => c.includes('symbol'));
        const cSiIdx = commaCols.findIndex(c => c.includes('currentshort') || (c.includes('short') && c.includes('position')));
        const cAvgIdx = commaCols.findIndex(c => c.includes('average') || c.includes('avg'));
        const cDtcIdx = commaCols.findIndex(c => c.includes('daystocover') || c.includes('days_to_cover'));
        if (cSymIdx !== -1 && cSiIdx !== -1) {
          parseCSVLines(lines.slice(1), ',', cSymIdx, cSiIdx, -1, cAvgIdx, cDtcIdx, settleDate, map);
        }
      } else {
        parseCSVLines(lines.slice(1), '|', symIdx, siIdx, prevIdx, avgIdx, dtcIdx, settleDate, map);
      }

      if (map.size > 0) {
        asOf = settleDate;
        console.log(`[FINRA] Short interest from CDN: ${map.size} securities (settlement: ${settleDate})`);
        break;
      }
    } catch {
      // Try next date
    }
  }

  const result: ShortInterestResult = { data: map, asOf };
  shortInterestCache = { result, timestamp: Date.now() };
  return map;
}

function parseCSVLines(
  lines: string[],
  delimiter: string,
  symIdx: number,
  siIdx: number,
  prevIdx: number,
  avgIdx: number,
  dtcIdx: number,
  settleDate: string,
  map: Map<string, ShortInterestData>,
): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.split(delimiter).map(f => f.trim().replace(/"/g, ''));
    const sym = (fields[symIdx] || '').toUpperCase().trim();
    if (!sym || sym.length > 6 || !/^[A-Z]+$/.test(sym) || map.has(sym)) continue;

    // Skip foreign ordinary shares (F suffix) — irrelevant for US dashboard
    if (sym.length > 1 && sym.endsWith('F')) continue;

    const si = Math.abs(parseFloat(fields[siIdx]) || 0);
    if (si <= 0) continue;

    const adv = avgIdx >= 0 ? Math.abs(parseFloat(fields[avgIdx]) || 0) : 0;
    const prevSI = prevIdx >= 0 ? Math.abs(parseFloat(fields[prevIdx]) || 0) : 0;
    const changePct = prevSI > 0 ? ((si - prevSI) / prevSI) * 100 : 0;

    // Use CSV-provided DTC when available; 999.99 means avg vol = 0 (N/A)
    let dtc: number;
    if (dtcIdx >= 0) {
      const csvDtc = parseFloat(fields[dtcIdx]) || 0;
      dtc = csvDtc >= 999 ? 0 : csvDtc;
    } else {
      dtc = adv > 0 ? si / adv : 0;
    }

    // Filter: require minimum liquidity, cap DTC, require meaningful SI
    if (adv < 500) continue;          // Skip extremely illiquid stocks
    if (dtc <= 0 || dtc > 200) continue; // Skip zero or absurd DTC
    if (si < 10000) continue;          // Skip trivially small positions

    map.set(sym, {
      shortInterest: si,
      previousShortInterest: prevSI,
      changePercent: Math.round(changePct * 100) / 100,
      avgDailyVolume: adv,
      daysToCover: Math.min(dtc, 200),
      settlementDate: settleDate,
    });
  }
}

/** Generate likely FINRA settlement dates (15th and last business day) for past 3 months */
function generateSettlementDates(): string[] {
  const dates: string[] = [];
  const now = new Date();

  for (let monthsBack = 0; monthsBack < 3; monthsBack++) {
    const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);

    // End of month: last business day
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    while (lastDay.getDay() === 0 || lastDay.getDay() === 6) lastDay.setDate(lastDay.getDate() - 1);
    dates.push(lastDay.toISOString().slice(0, 10));

    // Mid-month: 15th (or nearest business day)
    const mid = new Date(d.getFullYear(), d.getMonth(), 15);
    while (mid.getDay() === 0 || mid.getDay() === 6) mid.setDate(mid.getDate() - 1);
    dates.push(mid.toISOString().slice(0, 10));
  }

  // Sort most recent first, filter out future dates
  const today = now.toISOString().slice(0, 10);
  return dates.filter(d => d <= today).sort((a, b) => b.localeCompare(a));
}

export async function fetchShortInterestWithDate(): Promise<ShortInterestResult> {
  await fetchShortInterest();
  return shortInterestCache?.result ?? { data: new Map(), asOf: '' };
}

export async function getShortInterestForTicker(symbol: string): Promise<ShortInterestData | null> {
  const map = await fetchShortInterest();
  return map.get(symbol.toUpperCase()) || null;
}
