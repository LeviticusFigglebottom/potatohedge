/**
 * Unusual Whales API Provider
 *
 * Provides institutional-grade market data:
 * - Options flow (large blocks, sweeps, unusual activity)
 * - Dark pool prints
 * - Congressional trading
 * - Market Tide (net premium flow — the #1 institutional positioning signal)
 *
 * Set UNUSUAL_WHALES_API_KEY env var to activate.
 * Get an API key at: https://unusualwhales.com/public-api
 */

const UW_BASE = 'https://api.unusualwhales.com/api';
const FETCH_TIMEOUT = 8000;

function apiKey(): string {
  return process.env.UNUSUAL_WHALES_API_KEY || '';
}

export function isUWAvailable(): boolean {
  return !!apiKey();
}

async function uwFetch<T>(path: string): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;

  const res = await fetch(`${UW_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    console.log(`[UW] ${path}: ${res.status}`);
    return null;
  }

  return res.json();
}

// ─── Types ──────────────────────────────────────────────────

export interface MarketTide {
  netCallPremium: number;
  netPutPremium: number;
  netPremium: number;
  callVolume: number;
  putVolume: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

export interface FlowAlert {
  ticker: string;
  strike: number;
  expiry: string;
  contractType: 'call' | 'put';
  premium: number;
  volume: number;
  openInterest: number;
  tradeType: string; // sweep, block, split
  sentiment: string;
  timestamp: string;
}

export interface DarkPoolPrint {
  ticker: string;
  price: number;
  size: number;
  notional: number;
  date: string;
  timestamp: string;
}

export interface CongressTrade {
  politician: string;
  ticker: string;
  transactionType: string; // Purchase, Sale
  amount: string;
  transactionDate: string;
  disclosureDate: string;
  chamber: string;
}

// ─── Cache ──────────────────────────────────────────────────
interface UWCache<T> { data: T; timestamp: number }
let tideCache: UWCache<MarketTide | null> | null = null;
let flowCache: UWCache<FlowAlert[]> | null = null;
let darkPoolCache: UWCache<DarkPoolPrint[]> | null = null;
let congressCache: UWCache<CongressTrade[]> | null = null;
const TIDE_TTL = 300_000;       // 5 min (real-time signal)
const FLOW_TTL = 300_000;       // 5 min
const DARKPOOL_TTL = 600_000;   // 10 min
const CONGRESS_TTL = 3600_000;  // 1 hour (updates daily)

// ─── Market Tide ────────────────────────────────────────────

export async function getMarketTide(): Promise<MarketTide | null> {
  if (!isUWAvailable()) return null;
  if (tideCache && Date.now() - tideCache.timestamp < TIDE_TTL) return tideCache.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = await uwFetch('/market/tide');
    if (!raw?.data) return null;

    const d = raw.data;
    const netCall = Number(d.net_call_premium ?? d.call_premium ?? 0);
    const netPut = Number(d.net_put_premium ?? d.put_premium ?? 0);
    const net = netCall + netPut;
    const callVol = Number(d.call_volume ?? d.total_call_volume ?? 0);
    const putVol = Number(d.put_volume ?? d.total_put_volume ?? 0);

    const tide: MarketTide = {
      netCallPremium: netCall,
      netPutPremium: netPut,
      netPremium: net,
      callVolume: callVol,
      putVolume: putVol,
      sentiment: net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral',
    };

    console.log(`[UW] Market Tide: ${tide.sentiment} (net: $${(net / 1e6).toFixed(0)}M)`);
    tideCache = { data: tide, timestamp: Date.now() };
    return tide;
  } catch (err) {
    console.log('[UW] Market Tide error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── Options Flow Alerts ────────────────────────────────────

export async function getFlowAlerts(limit: number = 50): Promise<FlowAlert[]> {
  if (!isUWAvailable()) return [];
  if (flowCache && Date.now() - flowCache.timestamp < FLOW_TTL) return flowCache.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = await uwFetch(`/option-trades/flow-alerts?limit=${limit}`);
    if (!raw?.data || !Array.isArray(raw.data)) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alerts: FlowAlert[] = raw.data.map((d: any) => ({
      ticker: d.ticker || d.underlying_symbol || '',
      strike: Number(d.strike ?? d.strike_price ?? 0),
      expiry: d.expiry ?? d.expiration_date ?? d.expires ?? '',
      contractType: (d.contract_type ?? d.put_call ?? d.option_type ?? '').toLowerCase().includes('put') ? 'put' : 'call',
      premium: Number(d.premium ?? d.total_premium ?? d.cost_basis ?? 0),
      volume: Number(d.volume ?? d.size ?? 0),
      openInterest: Number(d.open_interest ?? d.oi ?? 0),
      tradeType: d.trade_type ?? d.option_activity_type ?? d.type ?? 'unknown',
      sentiment: d.sentiment ?? d.side ?? '',
      timestamp: d.timestamp ?? d.executed_at ?? d.date ?? '',
    })).filter((a: FlowAlert) => a.ticker && a.premium > 0);

    // Sort by premium descending (biggest trades first)
    alerts.sort((a: FlowAlert, b: FlowAlert) => b.premium - a.premium);

    console.log(`[UW] Flow Alerts: ${alerts.length} trades`);
    flowCache = { data: alerts, timestamp: Date.now() };
    return alerts;
  } catch (err) {
    console.log('[UW] Flow error:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ─── Dark Pool ──────────────────────────────────────────────

export async function getDarkPoolRecent(limit: number = 50): Promise<DarkPoolPrint[]> {
  if (!isUWAvailable()) return [];
  if (darkPoolCache && Date.now() - darkPoolCache.timestamp < DARKPOOL_TTL) return darkPoolCache.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = await uwFetch(`/darkpool/recent?limit=${limit}`);
    if (!raw?.data || !Array.isArray(raw.data)) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prints: DarkPoolPrint[] = raw.data.map((d: any) => ({
      ticker: d.ticker ?? d.symbol ?? '',
      price: Number(d.price ?? d.trade_price ?? 0),
      size: Number(d.size ?? d.shares ?? d.volume ?? 0),
      notional: Number(d.notional ?? d.market_value ?? 0) || (Number(d.price ?? 0) * Number(d.size ?? 0)),
      date: d.date ?? d.trade_date ?? '',
      timestamp: d.tracking_timestamp ?? d.timestamp ?? d.executed_at ?? '',
    })).filter((p: DarkPoolPrint) => p.ticker && p.size > 0);

    // Sort by notional descending
    prints.sort((a: DarkPoolPrint, b: DarkPoolPrint) => b.notional - a.notional);

    console.log(`[UW] Dark Pool: ${prints.length} prints`);
    darkPoolCache = { data: prints, timestamp: Date.now() };
    return prints;
  } catch (err) {
    console.log('[UW] Dark Pool error:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ─── Congressional Trading ──────────────────────────────────

export async function getCongressTrades(limit: number = 30): Promise<CongressTrade[]> {
  if (!isUWAvailable()) return [];
  if (congressCache && Date.now() - congressCache.timestamp < CONGRESS_TTL) return congressCache.data;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = await uwFetch(`/congress/recent-trades?limit=${limit}`);
    if (!raw?.data || !Array.isArray(raw.data)) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trades: CongressTrade[] = raw.data.map((d: any) => ({
      politician: d.politician ?? d.representative ?? d.name ?? '',
      ticker: d.ticker ?? d.asset_ticker ?? d.symbol ?? '',
      transactionType: d.transaction_type ?? d.type ?? d.trade_type ?? '',
      amount: d.amount ?? d.range ?? '',
      transactionDate: d.transaction_date ?? d.trade_date ?? '',
      disclosureDate: d.disclosure_date ?? d.filed_date ?? '',
      chamber: d.chamber ?? d.office ?? '',
    })).filter((t: CongressTrade) => t.politician && t.ticker);

    console.log(`[UW] Congress: ${trades.length} trades`);
    congressCache = { data: trades, timestamp: Date.now() };
    return trades;
  } catch (err) {
    console.log('[UW] Congress error:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Fetch all UW data in parallel. Returns null for any section that fails.
 */
export async function getAllUWData(): Promise<{
  tide: MarketTide | null;
  flow: FlowAlert[];
  darkPool: DarkPoolPrint[];
  congress: CongressTrade[];
}> {
  if (!isUWAvailable()) {
    return { tide: null, flow: [], darkPool: [], congress: [] };
  }

  const [tide, flow, darkPool, congress] = await Promise.allSettled([
    getMarketTide(),
    getFlowAlerts(50),
    getDarkPoolRecent(50),
    getCongressTrades(30),
  ]);

  return {
    tide: tide.status === 'fulfilled' ? tide.value : null,
    flow: flow.status === 'fulfilled' ? flow.value : [],
    darkPool: darkPool.status === 'fulfilled' ? darkPool.value : [],
    congress: congress.status === 'fulfilled' ? congress.value : [],
  };
}
