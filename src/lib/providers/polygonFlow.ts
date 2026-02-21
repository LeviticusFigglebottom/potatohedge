/**
 * Polygon Options Flow Detection Engine
 *
 * DIY institutional flow analysis from Polygon snapshot + trades data.
 * Scans major indices + mega-caps to detect:
 * - Market-wide net premium flow (the #1 institutional positioning signal)
 * - Unusual volume contracts (volume >> open interest)
 * - Large premium activity ($100K+ on a single contract line)
 * - Sweeps and blocks (auto-detected when Developer plan available)
 *
 * Works on Options Starter plan with automatic enhancement on Developer.
 */

import type { PolygonOptionSnapshot } from './polygon';

const BASE = 'https://api.polygon.io';
const FETCH_TIMEOUT = 8000;

function apiKey(): string {
  return process.env.POLYGON_API_KEY || '';
}

// Major indices + top mega-caps for broad market flow picture
// Reduced from 10 to 5 to stay under Vercel 2GB memory limit
const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'NVDA', 'TSLA'];

// ─── Types ──────────────────────────────────────────────────

export interface FlowAlert {
  ticker: string;
  optionsTicker: string;
  contractType: 'call' | 'put';
  strike: number;
  expiry: string;
  premium: number;
  volume: number;
  openInterest: number;
  volumeOIRatio: number;
  impliedVol: number;
  delta: number;
  tradeType: string;     // 'sweep' | 'block' | 'unusual_volume' | 'large_premium'
  sentiment: string;     // 'bullish' | 'bearish' | 'neutral'
  underlyingPrice: number;
}

export interface TickerFlow {
  ticker: string;
  netPremium: number;
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  contractsActive: number;
}

export interface MarketFlow {
  netCallPremium: number;
  netPutPremium: number;
  netPremium: number;
  totalCallVolume: number;
  totalPutVolume: number;
  putCallRatio: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  tickersScanned: number;
  contractsAnalyzed: number;
}

export interface FlowResult {
  flow: MarketFlow;
  alerts: FlowAlert[];
  perTickerFlow: TickerFlow[];
  isDeveloper: boolean;
  asOf: string;
}

// ─── Cache ──────────────────────────────────────────────────

let flowCache: { result: FlowResult; timestamp: number } | null = null;
const CACHE_TTL = 300_000; // 5 min

// Persists across requests within same serverless instance
let developerPlan: boolean | null = null;

// ─── Snapshot Fetching ──────────────────────────────────────

async function fetchSnapshotPage(ticker: string): Promise<PolygonOptionSnapshot[]> {
  const url = new URL(`${BASE}/v3/snapshot/options/${ticker}`);
  url.searchParams.set('apiKey', apiKey());
  url.searchParams.set('limit', '100');

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

// ─── Trades Fetching (Developer Plan) ───────────────────────

interface PolygonTrade {
  price: number;
  size: number;
  exchange: number;
  sip_timestamp: number;
}

async function fetchTrades(optionsTicker: string): Promise<PolygonTrade[] | null> {
  if (developerPlan === false) return null;

  const url = new URL(`${BASE}/v3/trades/${optionsTicker}`);
  url.searchParams.set('apiKey', apiKey());
  url.searchParams.set('limit', '200');
  url.searchParams.set('sort', 'timestamp');
  url.searchParams.set('order', 'desc');

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (res.status === 403 || res.status === 401) {
      developerPlan = false;
      return null;
    }

    if (!res.ok) return null;
    developerPlan = true;
    const data = await res.json();
    return data.results || [];
  } catch {
    return null;
  }
}

/**
 * Detect sweep or block from raw trade fills.
 * - Sweep: fills on 3+ exchanges within 2-second window
 * - Block: single fill >= 100 contracts
 */
function detectSweepOrBlock(trades: PolygonTrade[]): 'sweep' | 'block' | null {
  for (const t of trades) {
    if (t.size >= 100) return 'block';
  }

  if (trades.length >= 3) {
    const sorted = [...trades].sort((a, b) => a.sip_timestamp - b.sip_timestamp);
    for (let i = 0; i < sorted.length - 2; i++) {
      const windowEnd = sorted[i].sip_timestamp + 2_000_000_000; // 2s in nanoseconds
      const exchanges = new Set<number>();
      for (const t of sorted) {
        if (t.sip_timestamp >= sorted[i].sip_timestamp && t.sip_timestamp <= windowEnd) {
          exchanges.add(t.exchange);
        }
      }
      if (exchanges.size >= 3) return 'sweep';
    }
  }

  return null;
}

// ─── Per-Ticker Analysis ────────────────────────────────────

function analyzeTicker(
  ticker: string,
  snapshots: PolygonOptionSnapshot[],
): { alerts: FlowAlert[]; tickerFlow: TickerFlow } {
  const alerts: FlowAlert[] = [];
  let callPremium = 0, putPremium = 0;
  let callVolume = 0, putVolume = 0;
  let contractsActive = 0;

  for (const snap of snapshots) {
    const vol = snap.day?.volume ?? 0;
    if (vol === 0) continue;

    contractsActive++;
    const oi = snap.open_interest || 0;
    const vwap = snap.day?.vwap ?? snap.day?.close ?? 0;
    if (vwap === 0) continue;

    const multiplier = snap.details?.shares_per_contract || 100;
    const premium = vol * vwap * multiplier;
    const isCall = snap.details?.contract_type === 'call';

    if (isCall) { callPremium += premium; callVolume += vol; }
    else { putPremium += premium; putVolume += vol; }

    // Filter for noteworthy contracts
    const volumeOIRatio = oi > 0 ? vol / oi : (vol > 100 ? 10 : 0);
    const isUnusual = volumeOIRatio > 2.0 && vol > 100;
    const isLarge = premium > 100_000;
    const isHigh = vol > 500;

    if (!isUnusual && !isLarge && !isHigh) continue;

    // Estimate direction from contract price action
    const dayOpen = snap.day?.open ?? 0;
    const dayClose = snap.day?.close ?? 0;
    const priceUp = dayOpen > 0 && dayClose > dayOpen;
    const priceDown = dayOpen > 0 && dayClose < dayOpen;

    // Call price up = buying calls = bullish. Put price up = buying puts = bearish.
    let sentiment: string;
    if (isCall) {
      sentiment = priceUp ? 'bullish' : priceDown ? 'bearish' : 'neutral';
    } else {
      sentiment = priceUp ? 'bearish' : priceDown ? 'bullish' : 'neutral';
    }

    const tradeType = isLarge ? 'large_premium' : 'unusual_volume';

    alerts.push({
      ticker,
      optionsTicker: snap.details?.ticker || '',
      contractType: isCall ? 'call' : 'put',
      strike: snap.details?.strike_price || 0,
      expiry: snap.details?.expiration_date || '',
      premium,
      volume: vol,
      openInterest: oi,
      volumeOIRatio: Math.round(volumeOIRatio * 10) / 10,
      impliedVol: snap.implied_volatility || 0,
      delta: snap.greeks?.delta || 0,
      tradeType,
      sentiment,
      underlyingPrice: snap.underlying_asset?.price || 0,
    });
  }

  return {
    alerts,
    tickerFlow: {
      ticker,
      netPremium: callPremium - putPremium,
      callPremium,
      putPremium,
      callVolume,
      putVolume,
      contractsActive,
    },
  };
}

// ─── Single-Ticker Flow ──────────────────────────────────────

/**
 * Scan flow for a single ticker. Lighter weight than scanMarketFlow().
 * Reuses cached data if available (ticker is in watchlist and cache is fresh).
 */
export async function scanTickerFlow(ticker: string): Promise<{ tickerFlow: TickerFlow; alerts: FlowAlert[] }> {
  const empty = {
    tickerFlow: { ticker, netPremium: 0, callPremium: 0, putPremium: 0, callVolume: 0, putVolume: 0, contractsActive: 0 },
    alerts: [] as FlowAlert[],
  };

  if (!apiKey()) return empty;

  // Check market flow cache — if ticker is in watchlist and cache is fresh, reuse
  if (flowCache && Date.now() - flowCache.timestamp < CACHE_TTL) {
    const cached = flowCache.result.perTickerFlow.find(tf => tf.ticker === ticker.toUpperCase());
    if (cached) {
      return {
        tickerFlow: cached,
        alerts: flowCache.result.alerts.filter(a => a.ticker === ticker.toUpperCase()),
      };
    }
  }

  try {
    const snapshots = await fetchSnapshotPage(ticker);
    if (snapshots.length === 0) return empty;
    return analyzeTicker(ticker, snapshots);
  } catch {
    return empty;
  }
}

// ─── Main Entry Point ───────────────────────────────────────

export async function scanMarketFlow(): Promise<FlowResult> {
  if (flowCache && Date.now() - flowCache.timestamp < CACHE_TTL) {
    return flowCache.result;
  }

  if (!apiKey()) {
    return {
      flow: {
        netCallPremium: 0, netPutPremium: 0, netPremium: 0,
        totalCallVolume: 0, totalPutVolume: 0, putCallRatio: 0,
        sentiment: 'neutral', tickersScanned: 0, contractsAnalyzed: 0,
      },
      alerts: [],
      perTickerFlow: [],
      isDeveloper: false,
      asOf: '',
    };
  }

  // Fetch watchlist snapshots in small batches to limit peak memory
  const BATCH = 2;
  const results: PromiseSettledResult<PolygonOptionSnapshot[]>[] = [];
  for (let i = 0; i < WATCHLIST.length; i += BATCH) {
    const batch = await Promise.allSettled(
      WATCHLIST.slice(i, i + BATCH).map(t => fetchSnapshotPage(t))
    );
    results.push(...batch);
  }

  let totalCallPremium = 0, totalPutPremium = 0;
  let totalCallVolume = 0, totalPutVolume = 0;
  let allAlerts: FlowAlert[] = [];
  const perTickerFlow: TickerFlow[] = [];
  let contractsAnalyzed = 0;
  let tickersScanned = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || r.value.length === 0) continue;

    tickersScanned++;
    contractsAnalyzed += r.value.length;

    const { alerts, tickerFlow } = analyzeTicker(WATCHLIST[i], r.value);
    totalCallPremium += tickerFlow.callPremium;
    totalPutPremium += tickerFlow.putPremium;
    totalCallVolume += tickerFlow.callVolume;
    totalPutVolume += tickerFlow.putVolume;
    allAlerts.push(...alerts);
    perTickerFlow.push(tickerFlow);
  }

  // Sort alerts by premium descending, keep top 50
  // But cap per-ticker to avoid one name flooding the list (e.g., TSLA)
  allAlerts.sort((a, b) => b.premium - a.premium);
  const MAX_PER_TICKER = 5;
  const tickerCounts = new Map<string, number>();
  const cappedAlerts: FlowAlert[] = [];
  for (const alert of allAlerts) {
    const count = tickerCounts.get(alert.ticker) ?? 0;
    if (count >= MAX_PER_TICKER) continue;
    tickerCounts.set(alert.ticker, count + 1);
    cappedAlerts.push(alert);
    if (cappedAlerts.length >= 50) break;
  }
  allAlerts = cappedAlerts;

  // Sort per-ticker flow by absolute net premium
  perTickerFlow.sort((a, b) => Math.abs(b.netPremium) - Math.abs(a.netPremium));

  // Enhance top alerts with trade-level sweep/block detection (Developer plan)
  if (developerPlan !== false && allAlerts.length > 0) {
    const topTicker = allAlerts[0].optionsTicker;
    if (topTicker) {
      const testTrades = await fetchTrades(topTicker);
      if (testTrades && developerPlan === true) {
        // First alert
        const type0 = detectSweepOrBlock(testTrades);
        if (type0) allAlerts[0].tradeType = type0;

        // Enhance next 9 in parallel
        await Promise.allSettled(
          allAlerts.slice(1, 10).map(async (alert) => {
            if (!alert.optionsTicker) return;
            const trades = await fetchTrades(alert.optionsTicker);
            if (trades && trades.length > 0) {
              const t = detectSweepOrBlock(trades);
              if (t) alert.tradeType = t;
            }
          })
        );
      }
    }
  }

  const netPremium = totalCallPremium - totalPutPremium;
  const pcRatio = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0;

  const flowResult: FlowResult = {
    flow: {
      netCallPremium: totalCallPremium,
      netPutPremium: totalPutPremium,
      netPremium,
      totalCallVolume,
      totalPutVolume,
      putCallRatio: Math.round(pcRatio * 100) / 100,
      sentiment: netPremium > 0 ? 'bullish' : netPremium < 0 ? 'bearish' : 'neutral',
      tickersScanned,
      contractsAnalyzed,
    },
    alerts: allAlerts,
    perTickerFlow,
    isDeveloper: developerPlan === true,
    asOf: new Date().toISOString(),
  };

  flowCache = { result: flowResult, timestamp: Date.now() };
  return flowResult;
}
