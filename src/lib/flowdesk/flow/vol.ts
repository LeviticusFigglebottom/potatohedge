/** Volatility panel helpers: IV term structure (call vs put) and fixed-strike skew. */

import type { ChainContract, ChainSnapshot } from '../types';

export interface TermPoint {
  expiry: string;
  callIv: number | null;
  putIv: number | null;
}

/** ATM IV per expiry and right: linear interpolation between the two strikes bracketing spot. */
export function atmIv(contracts: ChainContract[], spot: number): number | null {
  const pts = contracts.filter((c) => c.iv > 0).sort((a, b) => a.strike - b.strike);
  if (pts.length === 0) return null;
  const hiIdx = pts.findIndex((c) => c.strike >= spot);
  if (hiIdx <= 0) return (hiIdx === 0 ? pts[0] : pts[pts.length - 1]).iv;
  const lo = pts[hiIdx - 1];
  const hi = pts[hiIdx];
  const w = hi.strike === lo.strike ? 0 : (spot - lo.strike) / (hi.strike - lo.strike);
  return lo.iv + w * (hi.iv - lo.iv);
}

export function termStructure(chain: ChainSnapshot): TermPoint[] {
  const byExp = new Map<string, ChainContract[]>();
  for (const c of chain.contracts) {
    const arr = byExp.get(c.expiry) ?? [];
    arr.push(c);
    byExp.set(c.expiry, arr);
  }
  return [...byExp.keys()].sort().map((expiry) => {
    const cs = byExp.get(expiry)!;
    return {
      expiry,
      callIv: atmIv(cs.filter((c) => c.right === 'C'), chain.spot),
      putIv: atmIv(cs.filter((c) => c.right === 'P'), chain.spot),
    };
  });
}

export interface SkewCurve {
  expiry: string;
  points: { strike: number; iv: number; right: 'C' | 'P' }[];
}

/**
 * Fixed-strike skew per expiry using OTM options (puts below spot, calls at/above),
 * which is the conventional way to stitch one smile from both rights.
 */
export function skewByExpiry(chain: ChainSnapshot): SkewCurve[] {
  const byExp = new Map<string, SkewCurve>();
  for (const c of chain.contracts) {
    if (!(c.iv > 0)) continue;
    const otm = c.right === 'P' ? c.strike < chain.spot : c.strike >= chain.spot;
    if (!otm) continue;
    const curve = byExp.get(c.expiry) ?? { expiry: c.expiry, points: [] };
    curve.points.push({ strike: c.strike, iv: c.iv, right: c.right });
    byExp.set(c.expiry, curve);
  }
  return [...byExp.values()]
    .map((c) => ({ ...c, points: c.points.sort((a, b) => a.strike - b.strike) }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
}
