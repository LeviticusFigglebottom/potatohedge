/**
 * Earnings Calendar Provider
 *
 * Detects upcoming earnings from multiple signals:
 * 1. Polygon reference API (ticker details — free tier)
 * 2. IV term structure analysis (backwardation = imminent event)
 * 3. IV rank spike detection (elevated pricing for known catalyst)
 *
 * To enable premium earnings data: set EARNINGS_API_KEY env var
 * (supports Financial Modeling Prep free tier — 250 req/day)
 */

const POLYGON_BASE = 'https://api.polygon.io';
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';
const FETCH_TIMEOUT = 6000;

function polygonKey(): string {
  return process.env.POLYGON_API_KEY || '';
}

function earningsKey(): string {
  return process.env.EARNINGS_API_KEY || '';
}

// ─── Types ──────────────────────────────────────────────────

export interface EarningsEvent {
  symbol: string;
  date: string;              // YYYY-MM-DD
  time: 'bmo' | 'amc' | 'unknown'; // Before Market Open / After Market Close
  confirmed: boolean;        // true = from API, false = estimated
  source: string;
  daysUntil: number;
}

export interface EarningsContext {
  nextEarnings: EarningsEvent | null;
  hasImminent: boolean;      // Earnings within 7 days
  ivSignals: {
    termStructureBackwardation: boolean;
    frontMonthIVPremium: number; // % premium of front month over back month
    ivRankElevated: boolean;
  };
}

// ─── Cache ──────────────────────────────────────────────────

const earningsCache = new Map<string, { data: EarningsEvent | null; timestamp: number }>();
const CACHE_TTL = 3600_000; // 1 hour

// ─── FMP Free Tier (if EARNINGS_API_KEY set) ────────────────

async function fetchFMPEarnings(symbol: string): Promise<EarningsEvent | null> {
  const key = earningsKey();
  if (!key) return null;

  try {
    const today = new Date();
    const from = today.toISOString().split('T')[0];
    const futureDate = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
    const to = futureDate.toISOString().split('T')[0];

    const url = `${FMP_BASE}/earning_calendar?from=${from}&to=${to}&apikey=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data)) return null;

    // Find this symbol
    const match = data.find(
      (e: { symbol: string }) => e.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    if (!match) return null;

    const earningsDate = new Date(match.date + 'T12:00:00');
    const daysUntil = Math.ceil((earningsDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    return {
      symbol: symbol.toUpperCase(),
      date: match.date,
      time: match.time === 'bmo' ? 'bmo' : match.time === 'amc' ? 'amc' : 'unknown',
      confirmed: true,
      source: 'FMP',
      daysUntil,
    };
  } catch {
    return null;
  }
}

// ─── Polygon Ticker Details ─────────────────────────────────

interface PolygonTickerDetail {
  name: string;
  market_cap: number;
  sic_code: string;
  description: string;
  primary_exchange: string;
  type: string;
}

let tickerDetailCache = new Map<string, { data: PolygonTickerDetail | null; ts: number }>();

export async function getTickerDetails(symbol: string): Promise<PolygonTickerDetail | null> {
  const cached = tickerDetailCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const key = polygonKey();
  if (!key) return null;

  try {
    const url = `${POLYGON_BASE}/v3/reference/tickers/${symbol.toUpperCase()}?apiKey=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.results || null;
    tickerDetailCache.set(symbol, { data: result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}

// ─── IV-Based Earnings Detection ────────────────────────────

/**
 * Detect if earnings are likely imminent from options data.
 * Uses three signals:
 * 1. Term structure backwardation (near > far IV)
 * 2. Front-month IV significantly elevated vs back-month
 * 3. IV Rank > 70 (elevated vol pricing)
 */
export function detectEarningsFromIV(
  termStructure: { dte: number; atmIV: number }[],
  ivRank: number,
  currentIV: number,
  hvCurrent: number,
): EarningsContext['ivSignals'] & { estimatedDaysUntil: number | null } {
  const sorted = [...termStructure].filter(t => t.dte > 0 && t.atmIV > 0).sort((a, b) => a.dte - b.dte);

  let backwardation = false;
  let frontPremium = 0;

  if (sorted.length >= 2) {
    const front = sorted[0];
    const back = sorted[sorted.length - 1];
    backwardation = front.atmIV > back.atmIV * 1.05; // 5% threshold
    frontPremium = back.atmIV > 0
      ? ((front.atmIV - back.atmIV) / back.atmIV) * 100
      : 0;
  }

  const ivRankElevated = ivRank >= 70;
  const ivHvGap = hvCurrent > 0 ? currentIV / hvCurrent : 1;

  // Estimate days until earnings from term structure shape
  let estimatedDaysUntil: number | null = null;
  if (backwardation && frontPremium > 15 && sorted.length >= 2) {
    // Find the "kink" — where IV jumps, suggesting an event between two expirations
    for (let i = 0; i < sorted.length - 1; i++) {
      const drop = (sorted[i].atmIV - sorted[i + 1].atmIV) / sorted[i].atmIV;
      if (drop > 0.10) {
        // Event is likely between sorted[i].dte and sorted[i+1].dte
        estimatedDaysUntil = sorted[i].dte;
        break;
      }
    }
    if (!estimatedDaysUntil) {
      estimatedDaysUntil = sorted[0].dte;
    }
  }

  return {
    termStructureBackwardation: backwardation,
    frontMonthIVPremium: Math.round(frontPremium * 10) / 10,
    ivRankElevated,
    estimatedDaysUntil,
  };
}

// ─── Main Entry Point ───────────────────────────────────────

export async function getNextEarnings(symbol: string): Promise<EarningsEvent | null> {
  const cached = earningsCache.get(symbol.toUpperCase());
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  // Try FMP first (if key set)
  const fmp = await fetchFMPEarnings(symbol);
  if (fmp) {
    earningsCache.set(symbol.toUpperCase(), { data: fmp, timestamp: Date.now() });
    return fmp;
  }

  // No confirmed earnings date available
  earningsCache.set(symbol.toUpperCase(), { data: null, timestamp: Date.now() });
  return null;
}

/**
 * Full earnings context: combines API data + IV signals.
 * Used by the UI to show earnings warnings on volatility/analytics tabs.
 */
export function buildEarningsContext(
  apiEarnings: EarningsEvent | null,
  termStructure: { dte: number; atmIV: number }[],
  ivRank: number,
  currentIV: number,
  hvCurrent: number,
): EarningsContext {
  const ivSignals = detectEarningsFromIV(termStructure, ivRank, currentIV, hvCurrent);

  let nextEarnings = apiEarnings;

  // If no API data but IV signals strongly suggest earnings, create an estimate
  if (!nextEarnings && ivSignals.termStructureBackwardation && ivSignals.frontMonthIVPremium > 20) {
    const estDays = ivSignals.estimatedDaysUntil;
    if (estDays && estDays <= 14) {
      const estDate = new Date();
      estDate.setDate(estDate.getDate() + estDays);
      nextEarnings = {
        symbol: '',
        date: estDate.toISOString().split('T')[0],
        time: 'unknown',
        confirmed: false,
        source: 'IV-estimated',
        daysUntil: estDays,
      };
    }
  }

  const hasImminent = nextEarnings
    ? nextEarnings.daysUntil <= 7
    : (ivSignals.termStructureBackwardation && ivSignals.frontMonthIVPremium > 15);

  return {
    nextEarnings,
    hasImminent,
    ivSignals: {
      termStructureBackwardation: ivSignals.termStructureBackwardation,
      frontMonthIVPremium: ivSignals.frontMonthIVPremium,
      ivRankElevated: ivSignals.ivRankElevated,
    },
  };
}
