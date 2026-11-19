/**
 * MSI — Market Stability Index: candidate component series.
 *
 * Each component is a time series sampled on the intraday minute grid. The
 * composite is defined in JSON (see msi.config.json / composite.ts) so the
 * research repo can swap the formula without code changes.
 *
 * Components (ids are referenced from the JSON config):
 *   gamma_all       all-expiry OI-weighted dealer gamma ($ per 1%), recomputed at each minute's spot
 *   dex_5pct        dealer $ delta for strikes within ±5 % of spot
 *   exp_prem_today  OI-weighted BS value of contracts expiring today ($)
 *   exp_prem_week   same for contracts expiring on or before this Friday ($)
 *   entropy_strike  normalised Shannon entropy of |cumulative signed premium| across strikes (0..1)
 *   entropy_expiry  same across expiries (0..1)
 *   flow_skew       (call net − put net) / (|call net| + |put net|), cumulative (−1..1)
 */

import { bsCallPrice, bsPutPrice } from '@/lib/math/blackScholes';
import { contractGreeks, exposureScale, yearsToExpiry } from '../flow/greeks';
import { fridayOf, etParts } from '../time';
import type { ChainSnapshot } from '../types';
import type { EnrichedTrade, FlowPoint } from '../flow/aggregate';

export type MsiComponentId =
  | 'gamma_all' | 'dex_5pct' | 'exp_prem_today' | 'exp_prem_week'
  | 'entropy_strike' | 'entropy_expiry' | 'flow_skew';

export const MSI_COMPONENTS: { id: MsiComponentId; label: string; unit: string }[] = [
  { id: 'gamma_all', label: 'All-expiry OI dealer gamma', unit: '$γ/1%' },
  { id: 'dex_5pct', label: 'DEX within ±5%', unit: '$Δ' },
  { id: 'exp_prem_today', label: 'Expiring premium (today)', unit: '$' },
  { id: 'exp_prem_week', label: 'Expiring premium (this week)', unit: '$' },
  { id: 'entropy_strike', label: 'Flow entropy across strikes', unit: '0–1' },
  { id: 'entropy_expiry', label: 'Flow entropy across expiries', unit: '0–1' },
  { id: 'flow_skew', label: 'Flow skew (call vs put)', unit: '−1…1' },
];

export interface MsiSample {
  time: number; // unix seconds
  values: Record<MsiComponentId, number>;
}

/** Normalised Shannon entropy H/ln(N) of non-negative weights (N = non-zero bins). */
export function normalizedEntropy(weights: number[]): number {
  const w = weights.filter((x) => x > 0);
  const total = w.reduce((a, b) => a + b, 0);
  if (w.length < 2 || total <= 0) return 0;
  let h = 0;
  for (const x of w) { const p = x / total; h -= p * Math.log(p); }
  return h / Math.log(w.length);
}

const RATE = 0.05;

export function computeMsiComponents(chain: ChainSnapshot, trades: EnrichedTrade[], grid: FlowPoint[], stepMin = 5): MsiSample[] {
  if (grid.length === 0) return [];
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const date = etParts(grid[0].time * 1000).date;
  const friday = fridayOf(date);
  const strikeAcc = new Map<number, number>();
  const expAcc = new Map<string, number>();
  let callNet = 0;
  let putNet = 0;
  let ti = 0;
  const out: MsiSample[] = [];
  const live = chain.contracts.filter((c) => c.openInterest > 0);

  for (let gi = 0; gi < grid.length; gi++) {
    const pt = grid[gi];
    const tMs = (pt.time + 60) * 1000; // end of minute
    while (ti < sorted.length && sorted[ti].time < tMs) {
      const t = sorted[ti++];
      if (!t.inSentiment || t.sign === 0) continue;
      strikeAcc.set(t.strike, (strikeAcc.get(t.strike) ?? 0) + t.signedPremium);
      expAcc.set(t.expiry, (expAcc.get(t.expiry) ?? 0) + t.signedPremium);
      if (t.right === 'C') callNet += t.signedPremium; else putNet += t.signedPremium;
    }
    if (gi % stepMin !== 0 && gi !== grid.length - 1) continue;

    const S = pt.spot;
    let gamma = 0, dex = 0, premToday = 0, premWeek = 0;
    for (const c of live) {
      if (c.expiry < date) continue;
      const qty = c.right === 'C' ? c.openInterest : -c.openInterest;
      const g = contractGreeks(c, S, tMs, false);
      gamma += qty * g.gamma * exposureScale('gamma', S);
      if (Math.abs(c.strike / S - 1) <= 0.05) dex += qty * g.delta * exposureScale('delta', S);
      if (c.expiry <= friday) {
        const p = { S, K: c.strike, T: yearsToExpiry(c.expiry, tMs), r: RATE, sigma: c.iv > 0 ? c.iv : 0.3 };
        const value = (c.right === 'C' ? bsCallPrice(p) : bsPutPrice(p)) * c.openInterest * 100;
        premWeek += value;
        if (c.expiry === date) premToday += value;
      }
    }
    const denom = Math.abs(callNet) + Math.abs(putNet);
    out.push({
      time: pt.time,
      values: {
        gamma_all: gamma,
        dex_5pct: dex,
        exp_prem_today: premToday,
        exp_prem_week: premWeek,
        entropy_strike: normalizedEntropy([...strikeAcc.values()].map(Math.abs)),
        entropy_expiry: normalizedEntropy([...expAcc.values()].map(Math.abs)),
        flow_skew: denom > 0 ? (callNet - putNet) / denom : 0,
      },
    });
  }
  return out;
}
