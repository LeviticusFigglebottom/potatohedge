/**
 * Dealer greek exposure by strike (panel 6).
 *
 * Greeks come from the repo's Black-Scholes engine (src/lib/math/blackScholes.ts —
 * the same functions analytics/GEX use). Vendor delta/gamma/vega are used when
 * the chain supplies them; vanna and charm are always computed.
 *
 * Dealer position per contract, by mode:
 *   oi        "Weighted OI" : repo convention — dealers +OI calls, −OI puts (OI = prior trading day)
 *   dealer5d  "Dealer (5d)" : −Σ aggressor-signed contracts over the last 5 sessions (dealer takes the other side)
 *   flow1d    "Flow (1d)"   : −Σ aggressor-signed contracts today
 *   combined  "Combined"    : oi + flow1d
 *
 * Exposure units (match GEXChart / blackScholes.computeDealerExposure):
 *   delta: qty·100·Δ·S            ($ delta)
 *   gamma: qty·100·Γ·S²·0.01      ($ gamma per 1% move)
 *   vega : qty·100·vega           ($ per vol point)
 *   vanna: qty·100·vanna
 *   charm: qty·100·charm          (per day)
 */

import { charm, delta as bsDelta, gamma as bsGamma, vanna, vega as bsVega } from '@/lib/math/blackScholes';
import { etToMs } from '../time';
import type { ChainContract, ChainSnapshot } from '../types';
import type { EnrichedTrade } from './aggregate';

export type GreekKey = 'delta' | 'gamma' | 'vega' | 'vanna' | 'charm';
export const GREEKS: GreekKey[] = ['delta', 'gamma', 'vega', 'vanna', 'charm'];
export type ExposureMode = 'oi' | 'dealer5d' | 'flow1d' | 'combined';

export interface StrikeGreeks {
  strike: number;
  delta: number;
  gamma: number;
  vega: number;
  vanna: number;
  charm: number;
}

const RATE = 0.05;
const YEAR_MS = 365 * 24 * 3600 * 1000;

export function yearsToExpiry(expiry: string, asOfMs: number): number {
  return Math.max(1 / (365 * 24), (etToMs(expiry, 16, 0) - asOfMs) / YEAR_MS);
}

export interface UnitGreeks { delta: number; gamma: number; vega: number; vanna: number; charm: number }

/** Per-contract (one option, not ×100) greeks at spot S. */
export function contractGreeks(c: Pick<ChainContract, 'strike' | 'right' | 'iv' | 'expiry'> & Partial<Pick<ChainContract, 'delta' | 'gamma' | 'vega'>>, S: number, asOfMs: number, useVendor = true): UnitGreeks {
  const T = yearsToExpiry(c.expiry, asOfMs);
  const sigma = c.iv > 0 ? c.iv : 0.3;
  const p = { S, K: c.strike, T, r: RATE, sigma };
  const type = c.right === 'C' ? 'call' : 'put';
  return {
    delta: useVendor && c.delta ? c.delta : bsDelta(p, type),
    gamma: useVendor && c.gamma ? c.gamma : bsGamma(p),
    vega: useVendor && c.vega ? c.vega : bsVega(p),
    vanna: vanna(p),
    charm: charm(p, type),
  };
}

export function exposureScale(g: GreekKey, S: number): number {
  switch (g) {
    case 'delta': return 100 * S;
    case 'gamma': return 100 * S * S * 0.01;
    default: return 100;
  }
}

const key = (expiry: string, strike: number, right: string) => `${expiry}|${strike}|${right}`;

/** Net contracts dealers are assumed to hold from flow: −Σ sign·size. */
export function dealerFlowQty(trades: EnrichedTrade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of trades) {
    if (!t.inSentiment || t.sign === 0) continue;
    const k = key(t.expiry, t.strike, t.right);
    m.set(k, (m.get(k) ?? 0) - t.sign * t.size);
  }
  return m;
}

export interface ExposureInput {
  chain: ChainSnapshot;
  trades1d: EnrichedTrade[];
  trades5d: EnrichedTrade[];
  mode: ExposureMode;
  expiry?: string | null; // restrict to one expiry
  spot?: number; // override spot (MSI recomputation)
  asOfMs?: number;
}

export function dealerExposure({ chain, trades1d, trades5d, mode, expiry, spot, asOfMs }: ExposureInput): StrikeGreeks[] {
  const S = spot ?? chain.spot;
  const now = asOfMs ?? chain.asOf;
  const useVendor = spot == null;
  const flowQty = mode === 'dealer5d' ? dealerFlowQty(trades5d) : mode === 'flow1d' || mode === 'combined' ? dealerFlowQty(trades1d) : null;
  const byStrike = new Map<number, StrikeGreeks>();
  const contracts = new Map<string, ChainContract>();
  for (const c of chain.contracts) contracts.set(key(c.expiry, c.strike, c.right), c);
  // contracts seen only in flow (not in the snapshot) still count in flow modes
  if (flowQty) {
    const all = [...trades1d, ...trades5d];
    for (const t of all) {
      const k = key(t.expiry, t.strike, t.right);
      if (!contracts.has(k)) contracts.set(k, { root: t.root, expiry: t.expiry, strike: t.strike, right: t.right, bid: t.bid ?? 0, ask: t.ask ?? 0, last: t.price, volume: 0, openInterest: 0, iv: t.iv ?? 0.3, delta: 0, gamma: 0, vega: 0 });
    }
  }
  for (const [k, c] of contracts) {
    if (expiry && c.expiry !== expiry) continue;
    if (yearsToExpiry(c.expiry, now) <= 1 / (365 * 24) && etToMs(c.expiry, 16) < now) continue; // expired
    let qty = 0;
    if (mode === 'oi' || mode === 'combined') qty += c.right === 'C' ? c.openInterest : -c.openInterest;
    if (flowQty) qty += flowQty.get(k) ?? 0;
    if (qty === 0) continue;
    const g = contractGreeks(c, S, now, useVendor);
    let row = byStrike.get(c.strike);
    if (!row) { row = { strike: c.strike, delta: 0, gamma: 0, vega: 0, vanna: 0, charm: 0 }; byStrike.set(c.strike, row); }
    for (const gk of GREEKS) row[gk] += qty * g[gk] * exposureScale(gk, S);
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

export function filterStrikeRange<T extends { strike: number }>(rows: T[], spot: number, pct: number | null): T[] {
  if (pct == null) return rows;
  const lo = spot * (1 - pct / 100);
  const hi = spot * (1 + pct / 100);
  return rows.filter((r) => r.strike >= lo && r.strike <= hi);
}

export function totals(rows: StrikeGreeks[]): UnitGreeks {
  const t = { delta: 0, gamma: 0, vega: 0, vanna: 0, charm: 0 };
  for (const r of rows) for (const g of GREEKS) t[g] += r[g];
  return t;
}
