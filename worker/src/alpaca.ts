import { loadConfig } from './config.js';
import { log } from './log.js';
import type { AlpacaAccount, AlpacaPositionRow, NormalizedLeg } from './types.js';

function authHeaders() {
  const cfg = loadConfig();
  return {
    'APCA-API-KEY-ID': cfg.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': cfg.ALPACA_SECRET_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function alpacaFetch(base: 'trading' | 'data', path: string, init: RequestInit = {}) {
  const cfg = loadConfig();
  const root = base === 'trading' ? cfg.ALPACA_TRADING_BASE : cfg.ALPACA_DATA_BASE;
  const url = `${root}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alpaca ${res.status} ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export async function getAccount(): Promise<AlpacaAccount> {
  const j = (await alpacaFetch('trading', '/v2/account')) as {
    portfolio_value: string;
    buying_power: string;
    cash: string;
  };
  return {
    portfolioValue: parseFloat(j.portfolio_value),
    buyingPower: parseFloat(j.buying_power),
    cash: parseFloat(j.cash),
  };
}

export async function listPositions(): Promise<AlpacaPositionRow[]> {
  const rows = (await alpacaFetch('trading', '/v2/positions')) as Array<{
    symbol: string;
    asset_class: string;
    qty: string;
    avg_entry_price: string;
    current_price: string;
    market_value: string;
  }>;
  return rows
    .filter((r) => r.asset_class === 'us_option' || r.symbol.length > 6)
    .map((r) => ({
      symbol: r.symbol,
      qty: parseFloat(r.qty),
      avgEntryPrice: parseFloat(r.avg_entry_price),
      currentPrice: parseFloat(r.current_price),
      marketValue: parseFloat(r.market_value),
    }));
}

// Build the OCC 21-character option symbol used by Alpaca:
// ROOT (up to 6, padded) + YYMMDD + C/P + 8-digit strike (× 1000).
export function buildOccSymbol(leg: NormalizedLeg): string {
  const root = leg.underlying.toUpperCase().padEnd(6, ' ').trimEnd();
  const [yyyy, mm, dd] = leg.expiration.split('-');
  if (!yyyy || !mm || !dd) throw new Error(`bad expiration: ${leg.expiration}`);
  const yy = yyyy.slice(2);
  const cp = leg.right === 'call' ? 'C' : 'P';
  const strikeMicros = Math.round(leg.strike * 1000)
    .toString()
    .padStart(8, '0');
  return `${root}${yy}${mm}${dd}${cp}${strikeMicros}`;
}

export interface OptionQuote {
  bid: number;
  ask: number;
  mid: number;
}

export async function getOptionQuote(occSymbol: string): Promise<OptionQuote | null> {
  try {
    const j = (await alpacaFetch(
      'data',
      `/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(occSymbol)}`,
    )) as { quotes?: Record<string, { bp: number; ap: number }> };
    const q = j.quotes?.[occSymbol];
    if (!q) return null;
    const bid = q.bp ?? 0;
    const ask = q.ap ?? 0;
    if (bid <= 0 || ask <= 0) return null;
    return { bid, ask, mid: (bid + ask) / 2 };
  } catch (e) {
    log.warn('option quote failed', { occSymbol, error: (e as Error).message });
    return null;
  }
}

export interface SubmitOrderArgs {
  occSymbol: string;
  qty: number;
  side: 'buy' | 'sell';
  limitPrice: number;
  timeInForce?: 'day' | 'gtc';
}

export async function submitOptionOrder(args: SubmitOrderArgs): Promise<{ id: string }> {
  const body = {
    symbol: args.occSymbol,
    qty: String(args.qty),
    side: args.side,
    type: 'limit',
    time_in_force: args.timeInForce ?? 'day',
    limit_price: args.limitPrice.toFixed(2),
  };
  const j = (await alpacaFetch('trading', '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { id: string };
  return { id: j.id };
}

// ─── Multi-leg (MLEG) orders ───────────────────────────────────────────────
//
// Alpaca routes spreads as a single MLEG order, which avoids partial-fill
// risk between legs and gets you the broker's combo execution. We submit
// with the net price per spread:
//   limit_price > 0  → net debit  (you pay this)
//   limit_price < 0  → net credit (you receive this)
// Each leg has position_intent describing whether it opens or closes,
// and side (buy/sell) describing the direction of that leg.

export type PositionIntent =
  | 'buy_to_open'
  | 'buy_to_close'
  | 'sell_to_open'
  | 'sell_to_close';

export interface MlegLeg {
  occSymbol: string;
  ratioQty: number; // legs per spread (almost always 1)
  side: 'buy' | 'sell';
  positionIntent: PositionIntent;
}

export interface SubmitMlegArgs {
  qty: number; // number of *spread units*
  legs: MlegLeg[];
  netLimitPrice: number; // signed: + debit, - credit
  timeInForce?: 'day' | 'gtc';
}

export async function submitMlegOrder(args: SubmitMlegArgs): Promise<{ id: string }> {
  if (args.legs.length < 2 || args.legs.length > 4) {
    throw new Error(`MLEG requires 2-4 legs, got ${args.legs.length}`);
  }
  const body = {
    order_class: 'mleg',
    qty: String(args.qty),
    type: 'limit',
    time_in_force: args.timeInForce ?? 'day',
    limit_price: args.netLimitPrice.toFixed(2),
    legs: args.legs.map((l) => ({
      symbol: l.occSymbol,
      ratio_qty: String(l.ratioQty),
      side: l.side,
      position_intent: l.positionIntent,
    })),
  };
  const j = (await alpacaFetch('trading', '/v2/orders', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { id: string };
  return { id: j.id };
}

// List all currently-working orders. Filter to options-only since equities
// aren't routed through this worker. Returns enough detail to identify
// orders against specific OCC symbols (including the legs of MLEG orders).
export interface OpenOrder {
  id: string;
  symbol: string | null;
  orderClass: string;
  occSymbols: string[]; // every option contract this order touches
}

export async function listOpenOptionOrders(): Promise<OpenOrder[]> {
  const rows = (await alpacaFetch(
    'trading',
    '/v2/orders?status=open&nested=true&limit=500',
  )) as Array<{
    id: string;
    symbol: string | null;
    asset_class: string;
    order_class: string;
    legs?: Array<{ symbol: string; asset_class: string }>;
  }>;
  const out: OpenOrder[] = [];
  for (const r of rows) {
    const occ: string[] = [];
    if (r.asset_class === 'us_option' && r.symbol) occ.push(r.symbol);
    for (const leg of r.legs ?? []) {
      if (leg.asset_class === 'us_option') occ.push(leg.symbol);
    }
    if (occ.length === 0) continue;
    out.push({
      id: r.id,
      symbol: r.symbol,
      orderClass: r.order_class,
      occSymbols: occ,
    });
  }
  return out;
}

export async function cancelOrder(orderId: string): Promise<void> {
  await alpacaFetch('trading', `/v2/orders/${orderId}`, { method: 'DELETE' });
}

export async function closeOptionPosition(
  occSymbol: string,
  qty: number,
  currentSide: 'long' | 'short',
  fallbackMark?: number,
): Promise<{ id: string } | null> {
  const quote = await getOptionQuote(occSymbol);
  const side: 'buy' | 'sell' = currentSide === 'long' ? 'sell' : 'buy';
  let limit: number;
  if (quote) {
    limit = currentSide === 'long' ? quote.bid : quote.ask;
  } else if (fallbackMark && fallbackMark > 0) {
    // Cross the spread aggressively from the broker's live mark.
    limit = currentSide === 'long' ? fallbackMark * 0.7 : fallbackMark * 1.5;
    log.warn('single-leg close using fallback mark', { occSymbol, fallbackMark, limit });
  } else {
    log.error('cannot close — no quote and no fallback mark', { occSymbol });
    return null;
  }
  return submitOptionOrder({
    occSymbol,
    qty: Math.abs(qty),
    side,
    limitPrice: limit,
    timeInForce: 'day',
  });
}
