/**
 * Aggressor classification of option prints against the NBBO.
 *
 *   price ≥ ask            → buy  (+)
 *   price ≤ bid            → sell (−)
 *   bid < price < ask      → quote rule: above mid → buy, below mid → sell
 *   exactly at mid, or no valid quote → unknown (0)
 */

import type { OptionTrade, Side } from '../types';

export function classifySide(price: number, bid: number | null, ask: number | null): Side {
  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask)) return 'unknown';
  if (ask <= 0 || bid < 0 || ask < bid) return 'unknown';
  if (price >= ask) return 'buy';
  if (price <= bid) return 'sell';
  const mid = (bid + ask) / 2;
  const eps = 1e-9;
  if (price > mid + eps) return 'buy';
  if (price < mid - eps) return 'sell';
  return 'unknown';
}

export function sideSign(side: Side): 1 | -1 | 0 {
  return side === 'buy' ? 1 : side === 'sell' ? -1 : 0;
}

/** Contract multiplier: standard US equity/index options. */
export const MULTIPLIER = 100;

export function premium(t: Pick<OptionTrade, 'price' | 'size'>): number {
  return t.price * t.size * MULTIPLIER;
}

/** Deep-ITM financing / dividend-play prints, flagged and excluded from sentiment. */
export function isDeepItm(t: Pick<OptionTrade, 'delta'>, threshold = 0.95): boolean {
  return t.delta != null && Math.abs(t.delta) > threshold;
}

/** Bullishness of a print: +1 for call buys / put sells, −1 for call sells / put buys. */
export function bullSign(t: OptionTrade, side: Side): number {
  const s = sideSign(side);
  return t.right === 'C' ? s : -s;
}

/** Detail string for the tape: qty@price with suffix _A (at/above ask side), _B (bid side), _M (mid/unknown). */
export function tapeDetail(t: OptionTrade, side: Side): string {
  const suffix = side === 'buy' ? 'A' : side === 'sell' ? 'B' : 'M';
  return `${t.size}@${t.price.toFixed(2)}_${suffix}`;
}
