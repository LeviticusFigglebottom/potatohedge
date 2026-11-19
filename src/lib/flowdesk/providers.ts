/**
 * Flow Desk data providers (server-only).
 *
 * Interface:
 *   getChain(symbol)              → ChainSnapshot       (Tradier, else Polygon snapshot)
 *   getBars(symbol, interval)     → Bar[]               (Tradier timesales/history, Polygon for BTCUSD)
 *   getTrades(symbols, days)      → OptionTrade[]       (Polygon options trades + quotes)
 * Every call has a demo implementation; live calls return a NoSource object when
 * the required key or entitlement is missing. Keys are read from the env vars the
 * repo already uses (TRADIER_API_KEY, TRADIER_SANDBOX, POLYGON_API_KEY) and are
 * never logged, echoed or returned.
 */

import { getExpirations, getHistory, getOptionsChain, getQuote } from '@/lib/providers/tradier';
import { getOptionsSnapshot, type PolygonOptionSnapshot } from '@/lib/providers/polygon';
import { demoBars, demoChain, demoNowMs, demoSessionDate, demoTradesDays, BASE_INTERVAL } from './demo';
import { resample, type ChartInterval } from './indicators/mtf';
import { addDays, etToMs, todayEt, weekdaysEnding, lastWeekday } from './time';
import type { Bar, ChainContract, ChainSnapshot, DataMode, Maybe, NoSource, OptionTrade, SourceStatus, TradeKind } from './types';
import type { Interval } from '@/types/market';

const hasTradier = () => !!process.env.TRADIER_API_KEY;
const hasPolygon = () => !!process.env.POLYGON_API_KEY;

export function sourceStatus(): SourceStatus {
  return {
    tradier: hasTradier(),
    polygon: hasPolygon(),
    tradePrints: hasPolygon(),
    demoForced: process.env.FLOW_DESK_DEMO === 'true',
  };
}

export function resolveMode(param: string | null): DataMode {
  if (param === 'demo') return 'demo';
  if (param === 'live') return process.env.FLOW_DESK_DEMO === 'true' ? 'demo' : 'live';
  return process.env.FLOW_DESK_DEMO === 'true' ? 'demo' : 'live';
}

export function sessionInfo(mode: DataMode): { session: string; nowMs: number } {
  if (mode === 'demo') {
    const session = demoSessionDate();
    return { session, nowMs: demoNowMs(session) };
  }
  return { session: lastWeekday(todayEt()), nowMs: Date.now() };
}

function noSource(reason: string, needs: string[]): NoSource {
  return { noSource: true, reason, needs };
}

// ─── Cache (per server instance) ────────────────────────────

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return value;
}

// ─── Chain ──────────────────────────────────────────────────

export async function getChain(symbol: string, mode: DataMode, maxExpiries = 10): Promise<Maybe<ChainSnapshot>> {
  const sym = symbol.toUpperCase();
  if (mode === 'demo') return demoChain(sym, demoSessionDate());
  if (hasTradier()) {
    return cached(`chain:${sym}`, 30_000, async () => {
      const quote = await getQuote(sym);
      const exps = (await getExpirations(sym)).slice(0, maxExpiries);
      const chains = await Promise.all(exps.map((e) => getOptionsChain(sym, e.date, quote.last).catch(() => null)));
      const contracts: ChainContract[] = [];
      for (const ch of chains) {
        if (!ch) continue;
        for (const c of [...ch.calls, ...ch.puts]) {
          contracts.push({
            root: sym, expiry: c.expiration, strike: c.strike, right: c.type === 'call' ? 'C' : 'P',
            bid: c.bid, ask: c.ask, last: c.last, volume: c.volume, openInterest: c.openInterest,
            iv: c.impliedVolatility, delta: c.delta, gamma: c.gamma, vega: c.vega,
          });
        }
      }
      return { root: sym, spot: quote.last, asOf: Date.now(), oiDate: weekdaysEnding(addDays(todayEt(), -1), 1)[0], contracts };
    });
  }
  if (hasPolygon()) {
    return cached(`pchain:${sym}`, 30_000, async () => {
      const snaps = await getOptionsSnapshot(sym);
      return polygonChain(sym, snaps);
    });
  }
  return noSource('No options chain source configured', ['TRADIER_API_KEY (preferred) or POLYGON_API_KEY']);
}

type SnapWithQuote = PolygonOptionSnapshot & { last_quote?: { bid?: number; ask?: number } };

function polygonChain(sym: string, snaps: SnapWithQuote[]): ChainSnapshot {
  const today = todayEt();
  const spot = snaps.find((s) => s.underlying_asset?.price)?.underlying_asset.price ?? 0;
  return {
    root: sym, spot, asOf: Date.now(), oiDate: weekdaysEnding(addDays(today, -1), 1)[0],
    contracts: snaps.filter((s) => s.details?.expiration_date >= today).map((s) => ({
      root: sym, expiry: s.details.expiration_date, strike: s.details.strike_price,
      right: s.details.contract_type === 'call' ? 'C' : 'P',
      bid: s.last_quote?.bid ?? 0, ask: s.last_quote?.ask ?? 0, last: s.day?.close ?? 0,
      volume: s.day?.volume ?? 0, openInterest: s.open_interest ?? 0, iv: s.implied_volatility ?? 0,
      delta: s.greeks?.delta ?? 0, gamma: s.greeks?.gamma ?? 0, vega: s.greeks?.vega ?? 0,
    })),
  };
}

// ─── Bars ───────────────────────────────────────────────────

const TRADIER_BASE: Partial<Record<ChartInterval, { interval: Interval; days: number }>> = {
  '1m': { interval: '1min', days: 7 },
  '5m': { interval: '5min', days: 30 },
  '15m': { interval: '15min', days: 120 },
  '1D': { interval: '1D', days: 900 },
};

async function polygonAggs(ticker: string, mult: number, span: 'minute' | 'day', from: string, to: string): Promise<Bar[]> {
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.POLYGON_API_KEY}` }, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!res.ok) throw new Error(`Polygon aggregates error ${res.status}`);
  const data = await res.json() as { results?: { t: number; o: number; h: number; l: number; c: number; v: number }[] };
  return (data.results ?? []).map((b) => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

export async function getBars(symbol: string, interval: ChartInterval, mode: DataMode): Promise<Maybe<Bar[]>> {
  const sym = symbol.toUpperCase();
  if (mode === 'demo') return demoBars(sym, interval, demoSessionDate());
  const base = BASE_INTERVAL[interval];
  const isCrypto = sym === 'BTCUSD' || sym.startsWith('X:');
  const spec = TRADIER_BASE[base]!;
  const to = todayEt();
  const from = addDays(to, -spec.days);
  let bars: Bar[] | null = null;
  if (isCrypto) {
    if (!hasPolygon()) return noSource('Crypto bars need Polygon', ['POLYGON_API_KEY (crypto aggregates)']);
    const mult = base === '1D' ? 1 : base === '1m' ? 1 : base === '5m' ? 5 : 15;
    bars = await cached(`pbars:${sym}:${base}`, 60_000, () => polygonAggs(sym.startsWith('X:') ? sym : 'X:BTCUSD', mult, base === '1D' ? 'day' : 'minute', from, to));
  } else if (hasTradier()) {
    bars = await cached(`tbars:${sym}:${base}`, 30_000, async () =>
      (await getHistory(sym, spec.interval, from, to)).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })));
  } else if (hasPolygon()) {
    const mult = base === '1D' ? 1 : base === '1m' ? 1 : base === '5m' ? 5 : 15;
    bars = await cached(`pbars:${sym}:${base}`, 60_000, () => polygonAggs(sym, mult, base === '1D' ? 'day' : 'minute', from, to));
  } else {
    return noSource('No price-bar source configured', ['TRADIER_API_KEY or POLYGON_API_KEY']);
  }
  if (base === interval) return bars;
  return resample(bars, base, interval).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
}

// ─── Trades (prints with NBBO) ──────────────────────────────

interface PolyTrade { sip_timestamp: number; price: number; size: number; exchange: number; conditions?: number[] }
interface PolyQuote { sip_timestamp: number; bid_price: number; ask_price: number }

class EntitlementError extends Error {}

async function polyGet<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const u = new URL(`https://api.polygon.io${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${process.env.POLYGON_API_KEY}` }, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (res.status === 401 || res.status === 403) throw new EntitlementError(`Polygon ${path.split('/')[2]} not in plan (${res.status})`);
  if (!res.ok) throw new Error(`Polygon ${path.split('/')[2]} error ${res.status}`);
  const data = await res.json() as { results?: T[] };
  return data.results ?? [];
}

function parseOcc(t: string): { expiry: string; right: 'C' | 'P'; strike: number } | null {
  const m = /O:([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(t);
  if (!m) return null;
  return { expiry: `20${m[2]}-${m[3]}-${m[4]}`, right: m[5] as 'C' | 'P', strike: Number(m[6]) / 1000 };
}

/** Label sweeps (≥3 exchanges within 1 s) and blocks (≥ 100 contracts single print). */
function tagKinds(trades: PolyTrade[]): TradeKind[] {
  return trades.map((t, i) => {
    if (t.size >= 100) return 'BLOCK';
    const exch = new Set<number>();
    for (let j = Math.max(0, i - 20); j < Math.min(trades.length, i + 20); j++) {
      if (Math.abs(trades[j].sip_timestamp - t.sip_timestamp) <= 1e9) exch.add(trades[j].exchange);
    }
    return exch.size >= 3 ? 'SWEEP' : exch.size === 2 ? 'SPLIT' : 'SINGLE';
  });
}

async function polygonTradesForRoot(root: string, date: string, maxContracts: number): Promise<OptionTrade[]> {
  const snaps = (await getOptionsSnapshot(root)) as SnapWithQuote[];
  const spot = snaps.find((s) => s.underlying_asset?.price)?.underlying_asset.price ?? 0;
  const top = snaps.filter((s) => (s.day?.volume ?? 0) > 0).sort((a, b) => (b.day?.volume ?? 0) - (a.day?.volume ?? 0)).slice(0, maxContracts);
  const gte = String(etToMs(date, 4, 0) * 1e6);
  const lte = String(etToMs(date, 20, 0) * 1e6);
  const out: OptionTrade[] = [];
  let quotesEntitled = true;
  for (const s of top) {
    const occ = parseOcc(s.details.ticker);
    if (!occ) continue;
    const trades = (await polyGet<PolyTrade>(`/v3/trades/${s.details.ticker}`, { 'timestamp.gte': gte, 'timestamp.lte': lte, limit: '5000', sort: 'timestamp', order: 'asc' }));
    if (trades.length === 0) continue;
    let quotes: PolyQuote[] = [];
    if (quotesEntitled) {
      try {
        quotes = await polyGet<PolyQuote>(`/v3/quotes/${s.details.ticker}`, { 'timestamp.gte': gte, 'timestamp.lte': lte, limit: '50000', sort: 'timestamp', order: 'asc' });
      } catch (e) {
        if (e instanceof EntitlementError) quotesEntitled = false; else throw e;
      }
    }
    const kinds = tagKinds(trades);
    let q = -1;
    trades.forEach((t, i) => {
      while (q + 1 < quotes.length && quotes[q + 1].sip_timestamp <= t.sip_timestamp) q++;
      const nbbo = q >= 0 ? quotes[q] : null;
      out.push({
        id: `${s.details.ticker}-${t.sip_timestamp}-${i}`,
        time: Math.floor(t.sip_timestamp / 1e6), root, ...occ,
        price: t.price, size: t.size,
        bid: nbbo ? nbbo.bid_price : s.last_quote?.bid ?? null,
        ask: nbbo ? nbbo.ask_price : s.last_quote?.ask ?? null,
        spot, iv: s.implied_volatility ?? null, delta: s.greeks?.delta ?? null, gamma: s.greeks?.gamma ?? null, vega: s.greeks?.vega ?? null,
        kind: kinds[i], nbboAtTrade: !!nbbo,
      });
    });
  }
  return out;
}

export async function getTrades(symbols: string[], days: number, mode: DataMode): Promise<Maybe<OptionTrade[]>> {
  const syms = symbols.map((s) => s.toUpperCase());
  const { session, nowMs } = sessionInfo(mode);
  const n = Math.max(1, Math.min(5, days));
  if (mode === 'demo') return syms.flatMap((s) => demoTradesDays(s, session, n, nowMs)).sort((a, b) => a.time - b.time);
  if (!hasPolygon()) {
    return noSource('No trade-level options prints source configured', [
      'Option trades (time & sales) with the NBBO at trade time — e.g. Polygon Options Developer (trades) + Advanced (quotes) via POLYGON_API_KEY',
      'See DATA_SOURCES.md',
    ]);
  }
  const maxContracts = Number(process.env.FLOW_DESK_MAX_CONTRACTS ?? 25);
  try {
    const dates = weekdaysEnding(session, n);
    const all: OptionTrade[] = [];
    for (const sym of syms) {
      for (const d of dates) {
        all.push(...await cached(`ptrades:${sym}:${d}`, d === session ? 60_000 : 6 * 3600_000, () => polygonTradesForRoot(sym, d, maxContracts)));
      }
    }
    return all.sort((a, b) => a.time - b.time);
  } catch (e) {
    if (e instanceof EntitlementError) {
      return noSource('Polygon key present but the plan has no options trades endpoint', ['Polygon Options Developer or higher (see DATA_SOURCES.md)']);
    }
    throw e;
  }
}
