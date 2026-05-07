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

export async function closeOptionPosition(occSymbol: string, qty: number, currentSide: 'long' | 'short'): Promise<{ id: string } | null> {
  const quote = await getOptionQuote(occSymbol);
  if (!quote) {
    log.warn('cannot close — no quote', { occSymbol });
    return null;
  }
  // Long → sell to close at bid (cross spread to exit reliably).
  // Short → buy to close at ask.
  const side: 'buy' | 'sell' = currentSide === 'long' ? 'sell' : 'buy';
  const limit = currentSide === 'long' ? quote.bid : quote.ask;
  return submitOptionOrder({
    occSymbol,
    qty: Math.abs(qty),
    side,
    limitPrice: limit,
    timeInForce: 'day',
  });
}
