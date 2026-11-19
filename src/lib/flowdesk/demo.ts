/**
 * Deterministic synthetic market data for Flow Desk demo mode.
 * Same (symbol, date, interval) → same data, so screenshots and tests are stable.
 * Nothing here touches the network or reads credentials.
 */

import { bsCallPrice, bsPutPrice, delta as bsDelta, gamma as bsGamma, vega as bsVega } from '@/lib/math/blackScholes';
import { addDays, dayOfWeek, etToMs, fridayOf, isWeekday, weekdaysEnding } from './time';
import { INTERVAL_SECONDS, resample, type ChartInterval } from './indicators/mtf';
import type { Bar, ChainContract, ChainSnapshot, OptionTrade, Right, TradeKind } from './types';

// ─── PRNG ───────────────────────────────────────────────────

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed: string) {
  let a = hashString(seed) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(1e-12, next());
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, normal, pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

// ─── Universe ───────────────────────────────────────────────

export const FLOW_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'NVDA', 'TSLA', 'AAPL', 'AMZN', 'META', 'MSFT', 'AMD'];

interface SymbolProfile { price: number; iv: number; step: number; daily: boolean; tradesPerDay: number; vol: number }

const PROFILES: Record<string, SymbolProfile> = {
  SPY: { price: 592, iv: 0.15, step: 1, daily: true, tradesPerDay: 1400, vol: 6e7 },
  QQQ: { price: 512, iv: 0.19, step: 1, daily: true, tradesPerDay: 900, vol: 4e7 },
  IWM: { price: 226, iv: 0.22, step: 1, daily: true, tradesPerDay: 450, vol: 3e7 },
  DIA: { price: 441, iv: 0.14, step: 1, daily: false, tradesPerDay: 150, vol: 4e6 },
  NVDA: { price: 141, iv: 0.48, step: 1, daily: false, tradesPerDay: 800, vol: 2.5e8 },
  TSLA: { price: 342, iv: 0.58, step: 2.5, daily: false, tradesPerDay: 700, vol: 9e7 },
  AAPL: { price: 231, iv: 0.24, step: 2.5, daily: false, tradesPerDay: 450, vol: 5e7 },
  AMZN: { price: 208, iv: 0.32, step: 2.5, daily: false, tradesPerDay: 350, vol: 4e7 },
  META: { price: 583, iv: 0.36, step: 5, daily: false, tradesPerDay: 330, vol: 1.5e7 },
  MSFT: { price: 421, iv: 0.25, step: 5, daily: false, tradesPerDay: 300, vol: 2e7 },
  AMD: { price: 136, iv: 0.47, step: 1, daily: false, tradesPerDay: 330, vol: 4e7 },
  GLD: { price: 246, iv: 0.16, step: 1, daily: false, tradesPerDay: 100, vol: 8e6 },
  TLT: { price: 92, iv: 0.15, step: 1, daily: false, tradesPerDay: 100, vol: 3e7 },
  BTCUSD: { price: 92000, iv: 0.55, step: 1000, daily: false, tradesPerDay: 0, vol: 3e4 },
};

function profile(symbol: string): SymbolProfile {
  const p = PROFILES[symbol.toUpperCase()];
  if (p) return p;
  const r = rng(`profile:${symbol}`);
  const price = Math.round(20 + r.next() * 400);
  return { price, iv: 0.25 + r.next() * 0.35, step: price > 200 ? 5 : price > 50 ? 2.5 : 1, daily: false, tradesPerDay: 250, vol: 1e7 };
}

// ─── Session & spot path ────────────────────────────────────

/** The demo "session": the latest weekday on or before `date` (holidays ignored). */
export function demoSessionDate(now = Date.now()): string {
  const d = new Date(now - 5 * 3600 * 1000).toISOString().slice(0, 10); // ~ET date
  return weekdaysEnding(d, 1)[0];
}

/** Demo clock: 15:55 ET on the session date — so "last 30 minutes" is always populated. */
export function demoNowMs(session: string): number {
  return etToMs(session, 15, 55);
}

/** Minute-by-minute spot path for a session, 08:00–17:00 ET (540 points). */
export function spotPath(symbol: string, date: string): { time: number; spot: number }[] {
  const p = profile(symbol);
  const r = rng(`spot:${symbol}:${date}`);
  // start price drifts slowly across days
  const dayIdx = Math.floor(etToMs(date, 12) / 86400000);
  const rd = rng(`spotday:${symbol}:${dayIdx}`);
  let s = p.price * (1 + 0.03 * Math.sin(dayIdx / 9 + hashString(symbol) % 7) + 0.006 * rd.normal());
  const sigmaMin = p.iv / Math.sqrt(252 * 390);
  const drift = 0.25 * sigmaMin * r.normal();
  const start = etToMs(date, 8, 0);
  const out: { time: number; spot: number }[] = [];
  for (let m = 0; m < 540; m++) {
    const rth = m >= 90 && m < 480;
    s *= Math.exp(drift + (rth ? 1 : 0.35) * sigmaMin * r.normal());
    out.push({ time: start + m * 60000, spot: +s.toFixed(2) });
  }
  return out;
}

// ─── Chain ──────────────────────────────────────────────────

export function demoExpiries(symbol: string, date: string): string[] {
  const p = profile(symbol);
  const set = new Set<string>();
  if (p.daily) {
    let d = date;
    for (let i = 0; i < 6; i++) { if (isWeekday(d)) set.add(d); else i--; d = addDays(d, 1); }
  }
  let f = fridayOf(date);
  for (let i = 0; i < 5; i++) { set.add(f); f = addDays(f, 7); }
  // next three monthlies (3rd Friday)
  const [y, m] = date.split('-').map(Number);
  for (let k = 1; k <= 3; k++) {
    const first = new Date(Date.UTC(y, m - 1 + k, 1)).toISOString().slice(0, 10);
    const third = addDays(first, ((5 - dayOfWeek(first) + 7) % 7) + 14);
    set.add(third);
  }
  return [...set].filter((d) => d >= date).sort();
}

const YEAR_MS = 365 * 24 * 3600 * 1000;

function smileIv(p: SymbolProfile, S: number, K: number, T: number, right: Right): number {
  const k = Math.log(K / S);
  const term = 1 + 0.15 * Math.exp(-T * 20) - 0.05 * Math.min(1, T * 4);
  const iv = p.iv * term * (1 - 1.1 * k + 3.5 * k * k) + (right === 'P' ? 0.004 : 0);
  return Math.max(0.05, iv);
}

function theo(S: number, K: number, T: number, iv: number, right: Right) {
  const params = { S, K, T, r: 0.05, sigma: iv };
  const type = right === 'C' ? 'call' : 'put';
  return {
    price: right === 'C' ? bsCallPrice(params) : bsPutPrice(params),
    delta: bsDelta(params, type),
    gamma: bsGamma(params),
    vega: bsVega(params),
  };
}

function strikeGrid(p: SymbolProfile, S: number, width = 0.12): number[] {
  const lo = Math.ceil((S * (1 - width)) / p.step) * p.step;
  const hi = Math.floor((S * (1 + width)) / p.step) * p.step;
  const out: number[] = [];
  for (let k = lo; k <= hi + 1e-9; k += p.step) out.push(+k.toFixed(2));
  // keep payload sane for wide-step symbols
  return out.length > 90 ? out.filter((_, i) => i % Math.ceil(out.length / 90) === 0) : out;
}

export function demoChain(symbol: string, date: string, asOfMs?: number): ChainSnapshot {
  const sym = symbol.toUpperCase();
  const p = profile(sym);
  const path = spotPath(sym, date);
  const asOf = asOfMs ?? demoNowMs(date);
  const idx = Math.max(0, Math.min(path.length - 1, Math.floor((asOf - path[0].time) / 60000)));
  const S = path[idx].spot;
  const prevClose = spotPath(sym, weekdaysEnding(addDays(date, -1), 1)[0])[479].spot;
  const r = rng(`chain:${sym}:${date}`);
  const contracts: ChainContract[] = [];
  for (const expiry of demoExpiries(sym, date)) {
    const T = Math.max(1 / (365 * 24), (etToMs(expiry, 16) - asOf) / YEAR_MS);
    for (const K of strikeGrid(p, S)) {
      for (const right of ['C', 'P'] as Right[]) {
        const iv = smileIv(p, S, K, T, right);
        const th = theo(S, K, T, iv, right);
        const mid = Math.max(0.01, th.price);
        const spread = Math.max(0.01, +(mid * (0.03 + 0.04 * r.next())).toFixed(2));
        const dist = Math.abs(Math.log(K / prevClose));
        const round = K % (p.step * 5) === 0 ? 1.8 : 1;
        const tWeight = expiry === date ? 0.6 : 1 / (1 + 3 * T);
        const skewW = right === 'P' ? (K < prevClose ? 1.3 : 0.6) : (K > prevClose ? 1.2 : 0.6);
        const oi = Math.round(p.tradesPerDay * 30 * tWeight * round * skewW * Math.exp(-dist * dist / 0.0018) * (0.5 + r.next()));
        contracts.push({
          root: sym, expiry, strike: K, right,
          bid: +Math.max(0, mid - spread / 2).toFixed(2), ask: +Math.max(+Math.max(0, mid - spread / 2).toFixed(2) + 0.01, mid + spread / 2).toFixed(2), last: +mid.toFixed(2),
          volume: 0, openInterest: oi, iv: +iv.toFixed(4), delta: +th.delta.toFixed(4), gamma: +th.gamma.toFixed(6), vega: +th.vega.toFixed(4),
        });
      }
    }
  }
  return { root: sym, spot: S, asOf, oiDate: weekdaysEnding(addDays(date, -1), 1)[0], contracts };
}

// ─── Trades ─────────────────────────────────────────────────

function intradayWeight(m: number): number {
  // U-shaped activity over 390 RTH minutes
  const x = m / 390;
  return 0.6 + 2.2 * Math.exp(-x * 12) + 1.3 * Math.exp(-(1 - x) * 10);
}

export function demoTrades(symbol: string, date: string, untilMs?: number): OptionTrade[] {
  const sym = symbol.toUpperCase();
  const p = profile(sym);
  if (p.tradesPerDay <= 0) return [];
  const path = spotPath(sym, date);
  const r = rng(`trades:${sym}:${date}`);
  const expiries = demoExpiries(sym, date);
  const bias = 0.18 * r.normal(); // >0 = call-buying day
  const out: OptionTrade[] = [];
  const n = Math.round(p.tradesPerDay * (0.8 + 0.4 * r.next()));
  const weights = path.map((_, m) => (m >= 90 && m < 480 ? intradayWeight(m - 90) : 0.08));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const cdf: number[] = [];
  weights.reduce((acc, w, i) => (cdf[i] = acc + w / wSum), 0);

  for (let i = 0; i < n; i++) {
    const u = r.next();
    let m = cdf.findIndex((c) => c >= u);
    if (m < 0) m = path.length - 1;
    const time = path[m].time + Math.floor(r.next() * 60000);
    if (untilMs != null && time > untilMs) continue;
    const S = path[m].spot;
    // expiry: favour near-dated
    const ei = Math.min(expiries.length - 1, Math.floor(Math.abs(r.normal()) * (p.daily ? 2.2 : 1.6)));
    const expiry = expiries[ei];
    const T = Math.max(1 / (365 * 24), (etToMs(expiry, 16) - time) / YEAR_MS);
    const right: Right = r.next() < 0.5 + bias * 0.4 ? 'C' : 'P';
    const deep = r.next() < 0.015;
    let K: number;
    if (deep) K = right === 'C' ? S * 0.82 : S * 1.18;
    else K = S * Math.exp((right === 'C' ? 0.012 : -0.012) + 0.03 * r.normal() * Math.sqrt(Math.max(0.2, T * 12)));
    K = Math.round(K / p.step) * p.step;
    const iv = smileIv(p, S, K, T, right);
    const th = theo(S, K, T, iv, right);
    const mid = Math.max(0.01, th.price);
    const spread = Math.max(0.01, mid * (0.03 + 0.05 * r.next()));
    const bid = +Math.max(0, mid - spread / 2).toFixed(2);
    const ask = +Math.max(bid + 0.01, mid + spread / 2).toFixed(2); // never a locked market
    // aggressor: call-heavy days lean to call buys and put sells
    const pBuy = 0.5 + (right === 'C' ? bias : -bias) * 0.8;
    const side = r.next() < pBuy ? 'buy' : 'sell';
    const where = r.next();
    let price: number;
    if (deep) price = +((bid + ask) / 2).toFixed(2);
    else if (where < 0.62) price = side === 'buy' ? ask : bid;
    else if (where < 0.88) price = +(side === 'buy' ? bid + (ask - bid) * 0.75 : bid + (ask - bid) * 0.25).toFixed(2);
    else price = +((bid + ask) / 2).toFixed(2);
    if (price <= 0) price = 0.01;
    let size = Math.max(1, Math.round(Math.exp(1.6 + 1.1 * r.normal())));
    let kind: TradeKind = 'SINGLE';
    const kr = r.next();
    if (deep) { size = 500 + Math.round(r.next() * 3000); kind = 'BLOCK'; }
    else if (kr < 0.03) { size = 100 + Math.round(r.next() * 1500); kind = 'BLOCK'; }
    else if (kr < 0.16) { size = Math.max(size, 20 + Math.round(r.next() * 300)); kind = 'SWEEP'; }
    else if (kr < 0.24) kind = 'SPLIT';
    out.push({
      id: `${sym}-${date}-${i}`,
      time, root: sym, expiry, strike: +K.toFixed(2), right, price, size,
      bid, ask, spot: S, iv: +iv.toFixed(4), delta: +th.delta.toFixed(4), gamma: +th.gamma.toFixed(6), vega: +th.vega.toFixed(4),
      kind, nbboAtTrade: true,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Trades for the last `days` sessions ending at `session` (inclusive). */
export function demoTradesDays(symbol: string, session: string, days: number, untilMs?: number): OptionTrade[] {
  return weekdaysEnding(session, days).flatMap((d) => demoTrades(symbol, d, d === session ? untilMs : undefined));
}

// ─── Bars ───────────────────────────────────────────────────

/** Base intervals the providers serve natively; others are resampled from these. */
export const BASE_INTERVAL: Record<ChartInterval, ChartInterval> = {
  '1m': '1m', '3m': '1m', '5m': '5m', '15m': '15m', '1h': '15m', '4h': '15m', '1D': '1D',
};

const BASE_SESSIONS: Record<string, number> = { '1m': 5, '5m': 20, '15m': 120 };

/** Synthetic OHLCV with regime switching, so the ribbon has trends and ranges to show. */
export function demoBaseBars(symbol: string, base: ChartInterval, session: string): Bar[] {
  const sym = symbol.toUpperCase();
  const p = profile(sym);
  const crypto = sym === 'BTCUSD';
  const r = rng(`bars:${sym}:${base}:${session}`);
  const step = INTERVAL_SECONDS[base];
  const times: number[] = [];
  if (base === '1D') {
    let d = session;
    const days: string[] = [];
    while (days.length < 600) { if (crypto || isWeekday(d)) days.unshift(d); d = addDays(d, -1); }
    for (const day of days) times.push(Math.floor(etToMs(day, 0) / 1000));
  } else {
    const n = BASE_SESSIONS[base] ?? 20;
    const days = crypto
      ? Array.from({ length: Math.ceil(n * 6.5 / 24) + 1 }, (_, i) => addDays(session, -i)).reverse()
      : weekdaysEnding(session, n);
    for (const day of days) {
      const [h0, m0, h1, m1] = crypto ? [0, 0, 24, 0] : [9, 30, 16, 0];
      const a = Math.floor(etToMs(day, h0, m0) / 1000);
      const b = Math.floor(etToMs(day, h1, m1) / 1000);
      for (let t = a; t < b; t += step) times.push(t);
    }
  }
  const perBarSigma = p.iv * Math.sqrt(step / (crypto ? 365 * 86400 : 252 * 23400));
  const scaleDay = base === '1D' ? 1 : 1;
  let s = p.price * (base === '1D' ? 0.78 : 0.97);
  let regime = 0;
  let regimeLeft = 0;
  const out: Bar[] = [];
  for (const t of times) {
    if (regimeLeft <= 0) { regime = r.pick([-1, 0, 0, 1, 1]); regimeLeft = 20 + Math.floor(r.next() * 120); }
    regimeLeft--;
    const mu = regime * perBarSigma * 0.18 * scaleDay;
    const vol = perBarSigma * (regime === 0 ? 0.6 : 1.1);
    const o = s;
    const c = o * Math.exp(mu + vol * r.normal());
    const wig = Math.abs(vol * r.normal()) * o * 0.6;
    const h = Math.max(o, c) + wig * r.next();
    const l = Math.min(o, c) - wig * r.next();
    const v = Math.round((p.vol * step / (base === '1D' ? 86400 : 23400)) * (0.5 + r.next()) * (regime === 0 ? 0.7 : 1.3));
    out.push({ time: t, open: +o.toFixed(2), high: +h.toFixed(2), low: +l.toFixed(2), close: +c.toFixed(2), volume: Math.max(1, v) });
    s = c;
  }
  return out;
}

export function demoBars(symbol: string, interval: ChartInterval, session: string): Bar[] {
  const base = BASE_INTERVAL[interval];
  const bars = demoBaseBars(symbol, base, session);
  if (base === interval) return bars;
  return resample(bars, base, interval).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
}
