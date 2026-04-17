/**
 * Scratch verifier for entropy dimension parity with QC helper.
 *
 * Computes each H_* dimension on a small hand-crafted fixture and
 * prints the values. Not a pass/fail test — just a numerical dump
 * to eyeball against QC's expected output on the same fixture.
 *
 * Run: npx tsx scripts/verify-entropy-dims.ts
 * (or any TS runner that resolves @/ paths; otherwise use the JS
 *  mirror in comments below)
 */

// Replicated locally (no import needed — keeps script runnable standalone)
function hNorm(dist: number[]): number {
  const d = dist.filter((v) => v > 0);
  if (d.length <= 1) return 0.0;
  const sum = d.reduce((a, b) => a + b, 0);
  const p = d.map((v) => v / sum);
  const h = -p.reduce((acc, x) => acc + x * Math.log2(x), 0);
  return h / Math.log2(d.length);
}

interface Rec {
  strike: number;
  expiry: string;
  dte: number;
  is_call: boolean;
  mid: number;
  bid: number;
  ask: number;
  volume: number;
  gamma: number;
  vega: number;
  charm: number;
  moneyness: number;
}

// ── Fixture: 12 contracts across 2 expiries, 6 strikes ──
const spot = 500;
const MIN_DTE = 7;
const MAX_DTE = 45;
const recs: Rec[] = [
  // expiry 2026-05-01 (dte=14), strikes 480, 490, 500, 510
  { strike: 480, expiry: '2026-05-01', dte: 14, is_call: false, mid: 1.2, bid: 1.15, ask: 1.25, volume: 100, gamma: 0.02, vega: 0.10, charm: -0.001, moneyness: 0.96 },
  { strike: 490, expiry: '2026-05-01', dte: 14, is_call: false, mid: 2.5, bid: 2.45, ask: 2.55, volume: 250, gamma: 0.03, vega: 0.15, charm: -0.002, moneyness: 0.98 },
  { strike: 500, expiry: '2026-05-01', dte: 14, is_call: true,  mid: 5.0, bid: 4.95, ask: 5.05, volume: 500, gamma: 0.04, vega: 0.20, charm: -0.003, moneyness: 1.00 },
  { strike: 510, expiry: '2026-05-01', dte: 14, is_call: true,  mid: 2.0, bid: 1.95, ask: 2.05, volume: 300, gamma: 0.03, vega: 0.15, charm: -0.002, moneyness: 1.02 },
  // expiry 2026-05-22 (dte=35), strikes 480, 490, 500, 510, 520
  { strike: 480, expiry: '2026-05-22', dte: 35, is_call: false, mid: 3.0, bid: 2.95, ask: 3.05, volume: 80,  gamma: 0.015, vega: 0.22, charm: -0.0008, moneyness: 0.96 },
  { strike: 490, expiry: '2026-05-22', dte: 35, is_call: false, mid: 4.5, bid: 4.40, ask: 4.60, volume: 150, gamma: 0.020, vega: 0.28, charm: -0.0012, moneyness: 0.98 },
  { strike: 500, expiry: '2026-05-22', dte: 35, is_call: true,  mid: 7.0, bid: 6.95, ask: 7.05, volume: 400, gamma: 0.025, vega: 0.35, charm: -0.0018, moneyness: 1.00 },
  { strike: 510, expiry: '2026-05-22', dte: 35, is_call: true,  mid: 4.5, bid: 4.40, ask: 4.60, volume: 220, gamma: 0.022, vega: 0.32, charm: -0.0015, moneyness: 1.02 },
  { strike: 520, expiry: '2026-05-22', dte: 35, is_call: true,  mid: 2.5, bid: 2.45, ask: 2.55, volume: 100, gamma: 0.018, vega: 0.25, charm: -0.0010, moneyness: 1.04 },
];

// ── Dims ──
const ev: Record<string, number> = {};
for (const r of recs) ev[r.expiry] = (ev[r.expiry] ?? 0) + r.volume;
const H_vol_term_n = hNorm(Object.values(ev));

const sv: Record<number, number> = {};
for (const r of recs) sv[r.strike] = (sv[r.strike] ?? 0) + r.volume;
const H_vol_k_n = hNorm(Object.values(sv));

const ep: Record<string, number> = {};
for (const r of recs) ep[r.expiry] = (ep[r.expiry] ?? 0) + r.mid * r.volume * 100;
const H_prem_term_n = hNorm(Object.values(ep));

const vv: Record<number, number> = {};
for (const r of recs) vv[r.strike] = (vv[r.strike] ?? 0) + Math.abs(r.vega) * r.volume;
const H_vegavol_n = hNorm(Object.values(vv));

const dg: Record<number, number> = {};
for (const r of recs) dg[r.strike] = (dg[r.strike] ?? 0) + Math.abs(r.gamma * r.volume * spot * 100);
const H_dgamma_n = hNorm(Object.values(dg));

const gv: Record<number, number> = {};
for (const r of recs) gv[r.strike] = (gv[r.strike] ?? 0) + Math.abs(r.gamma) * r.volume;
const H_gvx_n = hNorm(Object.values(gv));

const dflow = new Array(10).fill(0);
for (const r of recs) {
  // no delta in fixture; we only exercise bucket shape here.
  // skip this dim in the scratch verifier.
}

// Liquidity concentration (H_sk) — vol / relative_spread per strike
const sl: Record<number, number> = {};
for (const r of recs) {
  if (r.mid <= 0 || r.volume <= 0) continue;
  const relSp = (r.ask - r.bid) / r.mid;
  if (relSp <= 0) continue;
  sl[r.strike] = (sl[r.strike] ?? 0) + r.volume / relSp;
}
const H_spread_k_n = hNorm(Object.values(sl));

// Moneyness — 15 uniform bins of 0.02 on [0.85, 1.15]
const mb: number[] = [];
for (let i = 0; i <= 15; i++) mb.push(0.85 + i * 0.02);
const mv = new Array(mb.length - 1).fill(0);
for (const r of recs) {
  for (let b = 0; b < mb.length - 1; b++) {
    if (r.moneyness >= mb[b] && r.moneyness < mb[b + 1]) {
      mv[b] += r.volume;
      break;
    }
  }
}
const H_moneyness_n = hNorm(mv);

// Charm — parameterized edges range(MIN_DTE, MAX_DTE+2, 5)
const cb: number[] = [];
for (let e = MIN_DTE; e < MAX_DTE + 2; e += 5) cb.push(e);
const cvArr = new Array(Math.max(0, cb.length - 1)).fill(0);
for (const r of recs) {
  for (let b = 0; b < cb.length - 1; b++) {
    if (r.dte >= cb[b] && r.dte < cb[b + 1]) {
      cvArr[b] += Math.abs(r.charm);
      break;
    }
  }
}
const H_charm_n = hNorm(cvArr);

// ── Dump ──
console.log('Entropy dimension parity fixture');
console.log('spot:', spot, 'records:', recs.length, 'MIN_DTE:', MIN_DTE, 'MAX_DTE:', MAX_DTE);
console.log();
console.log('  H_vol_term_n    =', H_vol_term_n.toFixed(6));
console.log('  H_vol_k_n       =', H_vol_k_n.toFixed(6));
console.log('  H_prem_term_n   =', H_prem_term_n.toFixed(6));
console.log('  H_vegavol_n     =', H_vegavol_n.toFixed(6));
console.log('  H_dgamma_n      =', H_dgamma_n.toFixed(6));
console.log('  H_gvx_n         =', H_gvx_n.toFixed(6));
console.log('  H_spread_k_n    =', H_spread_k_n.toFixed(6));
console.log('  H_moneyness_n   =', H_moneyness_n.toFixed(6));
console.log('  H_charm_n       =', H_charm_n.toFixed(6));
console.log();
console.log('Expiry groupings:');
console.log('  volume by expiry      :', ev);
console.log('  premium by expiry     :', ep);
console.log();
console.log('Strike groupings:');
console.log('  liq-conc (vol/relspr) :', sl);
console.log('  dollar-gamma          :', dg);
console.log();
console.log('Charm DTE bins (edges=' + cb.join(',') + '):', cvArr);
console.log('Moneyness bins (15x 0.02-wide on [0.85,1.15]):', mv);
