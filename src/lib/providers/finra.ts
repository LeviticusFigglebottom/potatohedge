/**
 * FINRA Data Provider
 *
 * 1. Reg SHO Threshold List — daily list of securities with persistent FTDs
 *    Source: https://otce.finra.org/otce/RegSHOThreshold
 *
 * 2. Short Interest — bi-monthly publication of short positions
 *    Source: https://api.finra.org/data/group/otcMarket/name/EquityShortInterest
 */

export interface ShortInterestData {
  shortInterest: number;        // total shares short
  avgDailyVolume: number;       // for computing days-to-cover
  daysToCover: number;          // shortInterest / avgDailyVolume
  settlementDate: string;       // date of the SI report
  percentOfFloat?: number;      // if available
}

// ─── Caches ──────────────────────────────────────────────────
let regSHOCache: { data: Set<string>; timestamp: number } | null = null;
let shortInterestCache: { data: Map<string, ShortInterestData>; timestamp: number } | null = null;
const REG_SHO_TTL = 3600_000;     // 1 hour
const SI_TTL = 3600_000 * 4;       // 4 hours (data only updates bi-monthly)

// ─── Reg SHO Threshold List ──────────────────────────────────

/**
 * Fetch the current Reg SHO Threshold list from FINRA.
 * Returns a Set of ticker symbols that are on the threshold list.
 * Securities on this list have persistent failures-to-deliver (FTDs).
 */
export async function fetchRegSHOThreshold(): Promise<Set<string>> {
  if (regSHOCache && Date.now() - regSHOCache.timestamp < REG_SHO_TTL) {
    return regSHOCache.data;
  }

  const tickers = new Set<string>();

  try {
    // FINRA publishes the threshold list at their OTC transparency site
    // Try the API endpoint first
    const res = await fetch('https://api.finra.org/data/group/otcMarket/name/regShoThresholdList', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        fields: ['symbolCode'],
        limit: 5000,
        sortFields: ['-tradeReportDate'],
        domainFilters: [],
        compareFilters: [
          {
            fieldName: 'tradeReportDate',
            fieldValue: new Date().toISOString().slice(0, 10),
            compareType: 'EQUAL',
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const record of data) {
          const sym = (record.symbolCode || record.symbol || '').toUpperCase().trim();
          if (sym && sym.length <= 6) tickers.add(sym);
        }
      }
      console.log(`[FINRA] Reg SHO threshold list: ${tickers.size} securities`);
    } else {
      console.log(`[FINRA] Reg SHO API returned ${res.status}, trying archive...`);
      // Fallback: try the text archive
      await fetchRegSHOFromArchive(tickers);
    }
  } catch (err) {
    console.error('[FINRA] Reg SHO fetch error:', err instanceof Error ? err.message : String(err));
    // Try archive fallback
    try { await fetchRegSHOFromArchive(tickers); } catch { /* silent */ }
  }

  regSHOCache = { data: tickers, timestamp: Date.now() };
  return tickers;
}

async function fetchRegSHOFromArchive(tickers: Set<string>): Promise<void> {
  // FINRA publishes daily text files
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://otce.finra.org/otce/RegSHOThreshold/download?fileDate=${today}`;

  const res = await fetch(url, {
    headers: { 'Accept': 'text/plain, text/csv' },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return;

  const text = await res.text();
  for (const line of text.split('\n')) {
    const parts = line.split('|');
    const sym = (parts[1] || parts[0] || '').trim().toUpperCase();
    if (sym && sym.length <= 6 && sym !== 'SYMBOL' && !sym.includes(' ')) {
      tickers.add(sym);
    }
  }
  console.log(`[FINRA] Reg SHO from archive: ${tickers.size} securities`);
}

// ─── Short Interest ──────────────────────────────────────────

/**
 * Fetch short interest data from FINRA.
 * Returns a Map of ticker → ShortInterestData.
 * Data is bi-monthly — not real-time.
 */
export async function fetchShortInterest(): Promise<Map<string, ShortInterestData>> {
  if (shortInterestCache && Date.now() - shortInterestCache.timestamp < SI_TTL) {
    return shortInterestCache.data;
  }

  const map = new Map<string, ShortInterestData>();

  try {
    // FINRA's short interest API — fetch recent data
    const res = await fetch('https://api.finra.org/data/group/otcMarket/name/EquityShortInterest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        fields: ['symbolCode', 'currentShortPositionQuantity', 'averageDailyVolumeQuantity', 'daysToCoverQuantity', 'settlementDate'],
        limit: 10000,
        sortFields: ['-settlementDate'],
        domainFilters: [],
        // Get the most recent settlement date
        compareFilters: [],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.log(`[FINRA] Short interest API returned ${res.status}`);
      shortInterestCache = { data: map, timestamp: Date.now() };
      return map;
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      console.log('[FINRA] Unexpected SI response format');
      shortInterestCache = { data: map, timestamp: Date.now() };
      return map;
    }

    // Data may have multiple settlement dates; we want only the most recent per symbol
    const seen = new Set<string>();
    for (const record of data) {
      const sym = (record.symbolCode || '').toUpperCase().trim();
      if (!sym || sym.length > 6 || seen.has(sym)) continue;
      seen.add(sym);

      const si = record.currentShortPositionQuantity || 0;
      const adv = record.averageDailyVolumeQuantity || 0;
      const dtc = record.daysToCoverQuantity || (adv > 0 ? si / adv : 0);
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

    console.log(`[FINRA] Short interest: ${map.size} securities loaded`);
  } catch (err) {
    console.error('[FINRA] Short interest fetch error:', err instanceof Error ? err.message : String(err));
  }

  shortInterestCache = { data: map, timestamp: Date.now() };
  return map;
}

/**
 * Get short interest for a single ticker.
 */
export async function getShortInterestForTicker(symbol: string): Promise<ShortInterestData | null> {
  const map = await fetchShortInterest();
  return map.get(symbol.toUpperCase()) || null;
}
