/**
 * Polygon.io Data Provider (Options Starter tier)
 *
 * Provides:
 * - Full options snapshot (all contracts for a ticker)
 * - Historical equity OHLCV (for HV computation / IV rank)
 * - Options trade data (for flow detection later)
 */

import { logErr, logWarn } from '@/lib/errorLogger';

const BASE = 'https://api.polygon.io';

/** Hard timeout for every Polygon API call to prevent serverless function hangs */
const FETCH_TIMEOUT = 8000;

function apiKey(): string {
  return process.env.POLYGON_API_KEY || '';
}

function buildUrl(path: string, params: Record<string, string> = {}): string {
  const u = new URL(`${BASE}${path}`);
  u.searchParams.set('apiKey', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v) u.searchParams.set(k, v);
  }
  return u.toString();
}

// ─── Options Snapshot ──────────────────────────────────────

export interface PolygonOptionSnapshot {
  break_even_price: number;
  day: {
    change: number; change_percent: number; close: number;
    high: number; low: number; open: number; volume: number; vwap: number;
  };
  details: {
    contract_type: string; exercise_style: string;
    expiration_date: string; shares_per_contract: number;
    strike_price: number; ticker: string;
  };
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  implied_volatility: number;
  open_interest: number;
  underlying_asset: {
    change_to_break_even: number; last_updated: number;
    price: number; ticker: string; timeframe: string;
  };
}

export async function getOptionsSnapshot(
  ticker: string
): Promise<PolygonOptionSnapshot[]> {
  const allResults: PolygonOptionSnapshot[] = [];
  const firstUrl = buildUrl(
    `/v3/snapshot/options/${ticker.toUpperCase()}`,
    { limit: '250' }
  );

  // First request
  const firstRes: Response = await fetch(firstUrl, {
    next: { revalidate: 15 },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!firstRes.ok)
    throw new Error(`Polygon snapshot error: ${firstRes.status}`);
  let firstData;
  try {
    firstData = await firstRes.json();
  } catch (e) {
    logErr('polygon', `Snapshot JSON parse error for ${ticker}`, { ticker }, e);
    throw new Error(`Polygon snapshot JSON parse error: ${e instanceof Error ? e.message : 'malformed response'}`);
  }
  if (firstData.results) allResults.push(...firstData.results);

  // Pagination
  let cursor: string | undefined = firstData.next_url;
  while (cursor && allResults.length < 5000) {
    const pageUrl = `${cursor}&apiKey=${apiKey()}`;
    const pageRes: Response = await fetch(pageUrl, {
      next: { revalidate: 15 },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!pageRes.ok) break;
    let pageData;
    try {
      pageData = await pageRes.json();
    } catch {
      logWarn('polygon', `Pagination JSON parse error, returning ${allResults.length} results`, { cursor });
      break; // Malformed JSON on pagination — return what we have
    }
    if (pageData.results) allResults.push(...pageData.results);
    cursor = pageData.next_url;
  }

  return allResults;
}

// ─── Historical Equity Bars ────────────────────────────────

export interface PolygonBar {
  o: number; h: number; l: number; c: number;
  v: number; t: number; vw: number; n: number;
}

export async function getEquityHistory(
  ticker: string,
  multiplier: number,
  timespan: 'minute' | 'hour' | 'day' | 'week' | 'month',
  from: string,
  to: string
): Promise<PolygonBar[]> {
  const u = buildUrl(
    `/v2/aggs/ticker/${ticker.toUpperCase()}/range/${multiplier}/${timespan}/${from}/${to}`,
    { adjusted: 'true', sort: 'asc', limit: '50000' }
  );
  const res: Response = await fetch(u, { next: { revalidate: 60 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Polygon history error: ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    logErr('polygon', `History JSON parse error for ${ticker}`, { ticker, timespan, from, to }, e);
    throw new Error(`Polygon history JSON parse error: ${e instanceof Error ? e.message : 'malformed response'}`);
  }
  return data.results || [];
}

// ─── Previous Close ────────────────────────────────────────

export async function getPreviousClose(
  ticker: string
): Promise<PolygonBar | null> {
  const u = buildUrl(`/v2/aggs/ticker/${ticker.toUpperCase()}/prev`);
  const res: Response = await fetch(u, { next: { revalidate: 60 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null; // Malformed JSON from Polygon
  }
  return data.results?.[0] || null;
}

// ─── Short Interest (bi-monthly, all exchanges) ────────────

export interface PolygonShortInterestItem {
  ticker: string;
  short_interest: number;
  avg_daily_volume: number;
  days_to_cover: number;
  settlement_date: string;
}

/**
 * Fetch short interest data from Polygon.
 * Covers ALL US equities (NYSE, NASDAQ, OTC) — not just OTC like FINRA CDN.
 * Supports server-side filtering and pagination.
 */
export async function getShortInterestBulk(params?: {
  ticker?: string;
  daysToCoverGte?: number;
  avgDailyVolumeGte?: number;
  settlementDateGte?: string;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}): Promise<PolygonShortInterestItem[]> {
  const queryParams: Record<string, string> = {
    limit: String(params?.limit ?? 1000),
    sort: params?.sort ?? 'days_to_cover',
    order: params?.order ?? 'desc',
  };
  if (params?.ticker) queryParams.ticker = params.ticker;
  if (params?.daysToCoverGte) queryParams['days_to_cover.gte'] = String(params.daysToCoverGte);
  if (params?.avgDailyVolumeGte) queryParams['avg_daily_volume.gte'] = String(params.avgDailyVolumeGte);
  if (params?.settlementDateGte) queryParams['settlement_date.gte'] = params.settlementDateGte;

  const url = buildUrl('/stocks/v1/short-interest', queryParams);
  const res: Response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Polygon SI error: ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`Polygon SI JSON parse error: ${e instanceof Error ? e.message : 'malformed response'}`);
  }
  return (data.results || []).filter(
    (r: PolygonShortInterestItem) => r.ticker && r.short_interest > 0
  );
}

// ─── Short Volume (daily, all exchanges) ────────────────────

export interface PolygonShortVolumeItem {
  ticker: string;
  date: string;
  short_volume: number;
  total_volume: number;
  short_volume_ratio: number;
  exempt_volume: number;
}

/**
 * Fetch daily short sale volume from Polygon.
 * More granular than FINRA regShoDaily — includes venue breakdowns.
 */
export async function getShortVolumeBulk(params?: {
  ticker?: string;
  date?: string;
  dateGte?: string;
  shortVolumeRatioGte?: number;
  totalVolumeGte?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}): Promise<PolygonShortVolumeItem[]> {
  const queryParams: Record<string, string> = {
    limit: String(params?.limit ?? 1000),
    sort: params?.sort ?? 'short_volume_ratio',
    order: params?.order ?? 'desc',
  };
  if (params?.ticker) queryParams.ticker = params.ticker;
  if (params?.date) queryParams.date = params.date;
  if (params?.dateGte) queryParams['date.gte'] = params.dateGte;
  if (params?.shortVolumeRatioGte) queryParams['short_volume_ratio.gte'] = String(params.shortVolumeRatioGte);
  if (params?.totalVolumeGte) queryParams['total_volume.gte'] = String(params.totalVolumeGte);

  const url = buildUrl('/stocks/v1/short-volume', queryParams);
  const res: Response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`Polygon SV error: ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`Polygon SV JSON parse error: ${e instanceof Error ? e.message : 'malformed response'}`);
  }
  return (data.results || []).filter(
    (r: PolygonShortVolumeItem) => r.ticker && r.total_volume > 0
  );
}
