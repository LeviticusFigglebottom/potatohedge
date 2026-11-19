/**
 * ELMo-D indicator — pure TypeScript implementation.
 *
 * Definitions (see FLOW_DESK.md § ELMo-D for the full spec):
 *   r     = WMA9( ln(close / close[lookback]) )          lookback default 10
 *   ENTP  = 100 · (r − min) / (max − min)                 min/max over the loaded
 *                                                         history, or a rolling window
 *   MA1..4= ALMA(ENTP, 5/20/50/100, offset 0.85, sigma 10)
 *   LHH   = ((pmax − pmin)/pmin) / (dv / (sma(vol,10)·sma(close,10))) · 100
 *           pmax = highest(high,10), pmin = lowest(low,10), dv = Σ10 hlc3·volume
 *   Price layer: ALMA(close, 20/100/200, 0.85, 6), EMA 20/50/100/200,
 *   liquidity shelves (pivots L10/R5 + gap edges), consolidation boxes
 *   (LHH < SMA50(LHH) for ≥ 6 bars), extreme-turn context marks.
 */

import { alma, crossover, crossunder, ema, highest, lowest, pivots, sma, sum, wma, type Series } from './ta';

export interface Bar {
  time: number; // unix seconds (bar open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type EntpScaling = { mode: 'history' } | { mode: 'rolling'; window: number };

export interface ElmoDOptions {
  /** momentum lookback for ln(close/close[n]); 10 by default, 20 for the heatmap */
  lookback: number;
  wmaLen: number;
  scaling: EntpScaling;
  maLens: [number, number, number, number];
  maOffset: number;
  maSigma: number;
  lhhLen: number;
  priceAlmaLens: number[];
  priceAlmaOffset: number;
  priceAlmaSigma: number;
  emaLens: number[];
  pivotLeft: number;
  pivotRight: number;
  boxMinBars: number;
  extremeHigh: number;
  extremeLow: number;
}

export const DEFAULT_ELMOD_OPTIONS: ElmoDOptions = {
  lookback: 10,
  wmaLen: 9,
  scaling: { mode: 'history' },
  maLens: [5, 20, 50, 100],
  maOffset: 0.85,
  maSigma: 10,
  lhhLen: 10,
  priceAlmaLens: [20, 100, 200],
  priceAlmaOffset: 0.85,
  priceAlmaSigma: 6,
  emaLens: [20, 50, 100, 200],
  pivotLeft: 10,
  pivotRight: 5,
  boxMinBars: 6,
  extremeHigh: 80,
  extremeLow: 20,
};

const isNum = (v: number) => Number.isFinite(v);

// ─── ENTP ───────────────────────────────────────────────────

export function entpRaw(close: Series, lookback = 10, wmaLen = 9): Series {
  const lr = close.map((c, i) =>
    i >= lookback && c > 0 && close[i - lookback] > 0 ? Math.log(c / close[i - lookback]) : NaN,
  );
  return wma(lr, wmaLen);
}

export function scaleEntp(r: Series, scaling: EntpScaling): Series {
  if (scaling.mode === 'history') {
    const vals = r.filter(isNum);
    if (vals.length === 0) return r.map(() => NaN);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const rng = mx - mn;
    return r.map((v) => (isNum(v) ? (rng > 0 ? (100 * (v - mn)) / rng : 50) : NaN));
  }
  // Rolling: min/max over the last `window` valid values up to and including bar i.
  // Uses only past data (no look-ahead). Fewer than `window` bars → uses what exists.
  const w = Math.max(2, scaling.window);
  return r.map((v, i) => {
    if (!isNum(v)) return NaN;
    let mn = Infinity;
    let mx = -Infinity;
    for (let k = Math.max(0, i - w + 1); k <= i; k++) {
      const x = r[k];
      if (!isNum(x)) continue;
      if (x < mn) mn = x;
      if (x > mx) mx = x;
    }
    const rng = mx - mn;
    return rng > 0 ? (100 * (v - mn)) / rng : 50;
  });
}

export function entp(close: Series, opts: Pick<ElmoDOptions, 'lookback' | 'wmaLen' | 'scaling'>): Series {
  return scaleEntp(entpRaw(close, opts.lookback, opts.wmaLen), opts.scaling);
}

// ─── Ribbon ─────────────────────────────────────────────────

export interface Ribbon {
  entp: Series;
  ma: [Series, Series, Series, Series];
  /** per bar, for bands [ENTP/MA1, MA1/MA2, MA2/MA3, MA3/MA4]: true = bullish (faster above slower) */
  bands: (boolean | null)[][];
  /** per bar, number of bullish bands 0..4 (NaN while warming up) */
  bullishFills: Series;
}

export function ribbon(entpSeries: Series, opts: Pick<ElmoDOptions, 'maLens' | 'maOffset' | 'maSigma'>): Ribbon {
  const ma = opts.maLens.map((l) => alma(entpSeries, l, opts.maOffset, opts.maSigma)) as Ribbon['ma'];
  const lines = [entpSeries, ...ma];
  const bands: (boolean | null)[][] = [];
  const bullishFills: Series = [];
  for (let i = 0; i < entpSeries.length; i++) {
    const row: (boolean | null)[] = [];
    let count = 0;
    let valid = true;
    for (let b = 0; b < 4; b++) {
      const fast = lines[b][i];
      const slow = lines[b + 1][i];
      if (!isNum(fast) || !isNum(slow)) { row.push(null); valid = false; continue; }
      const bull = fast > slow;
      row.push(bull);
      if (bull) count++;
    }
    bands.push(row);
    bullishFills.push(valid ? count : NaN);
  }
  return { entp: entpSeries, ma, bands, bullishFills };
}

// ─── LHH (Hui-Heubel liquidity ratio) ───────────────────────

export function lhh(bars: Bar[], len = 10): Series {
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const vol = bars.map((b) => b.volume);
  const pmax = highest(high, len);
  const pmin = lowest(low, len);
  const dv = sum(bars.map((b) => ((b.high + b.low + b.close) / 3) * b.volume), len);
  const smaV = sma(vol, len);
  const smaC = sma(close, len);
  return bars.map((_, i) => {
    const denom = smaV[i] * smaC[i];
    if (![pmax[i], pmin[i], dv[i], denom].every(isNum) || pmin[i] <= 0 || denom <= 0 || dv[i] <= 0) return NaN;
    return (((pmax[i] - pmin[i]) / pmin[i]) / (dv[i] / denom)) * 100;
  });
}

// ─── Price layer ────────────────────────────────────────────

export interface Shelf {
  kind: 'pivot_high' | 'pivot_low' | 'gap_upper' | 'gap_lower';
  price: number;
  /** bar index where the level originates (pivot bar / gap bar) */
  fromIndex: number;
  /** bar index where the level is first known (pivot confirmation / gap bar) */
  knownAt: number;
  /** bar index where price traded through the level, or null if still open */
  brokenAt: number | null;
}

export function liquidityShelves(bars: Bar[], left = 10, right = 5): Shelf[] {
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const shelves: Shelf[] = [];
  for (const p of pivots(high, low, left, right)) {
    shelves.push({ kind: p.kind === 'high' ? 'pivot_high' : 'pivot_low', price: p.price, fromIndex: p.index, knownAt: p.confirmedAt, brokenAt: null });
  }
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (cur.low > prev.high) {
      shelves.push({ kind: 'gap_lower', price: prev.high, fromIndex: i, knownAt: i, brokenAt: null });
      shelves.push({ kind: 'gap_upper', price: cur.low, fromIndex: i, knownAt: i, brokenAt: null });
    } else if (cur.high < prev.low) {
      shelves.push({ kind: 'gap_upper', price: prev.low, fromIndex: i, knownAt: i, brokenAt: null });
      shelves.push({ kind: 'gap_lower', price: cur.high, fromIndex: i, knownAt: i, brokenAt: null });
    }
  }
  // A shelf is broken on the first bar after it is known whose range trades through it.
  for (const s of shelves) {
    for (let i = s.knownAt + 1; i < bars.length; i++) {
      if (bars[i].low < s.price && bars[i].high > s.price) { s.brokenAt = i; break; }
    }
  }
  return shelves.sort((a, b) => a.fromIndex - b.fromIndex);
}

export interface ConsolidationBox {
  startIndex: number;
  endIndex: number; // inclusive
  top: number;
  bottom: number;
}

export function consolidationBoxes(bars: Bar[], lhhSeries: Series, lhhSlow: Series, minBars = 6): ConsolidationBox[] {
  const boxes: ConsolidationBox[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0 && end - start + 1 >= minBars) {
      const seg = bars.slice(start, end + 1);
      boxes.push({ startIndex: start, endIndex: end, top: Math.max(...seg.map((b) => b.high)), bottom: Math.min(...seg.map((b) => b.low)) });
    }
    start = -1;
  };
  for (let i = 0; i < bars.length; i++) {
    const inside = isNum(lhhSeries[i]) && isNum(lhhSlow[i]) && lhhSeries[i] < lhhSlow[i];
    if (inside) { if (start < 0) start = i; }
    else flush(i - 1);
  }
  flush(bars.length - 1);
  return boxes;
}

// ─── Marks ──────────────────────────────────────────────────

export interface Mark {
  index: number;
  kind: 'extreme_peak' | 'extreme_trough' | 'dot_bull' | 'dot_bear';
  value: number;
}

/**
 * Extreme-turn context marks (NOT signals): a local ENTP peak ≥ high that has
 * started dipping (ENTP[i-1] ≥ high, ENTP[i-1] > ENTP[i-2], ENTP[i] < ENTP[i-1]);
 * mirror for troughs ≤ low. The mark sits on bar i, the first bar the turn is known.
 */
export function extremeTurns(e: Series, high = 80, low = 20): Mark[] {
  const out: Mark[] = [];
  for (let i = 2; i < e.length; i++) {
    const [a, b, c] = [e[i - 2], e[i - 1], e[i]];
    if (![a, b, c].every(isNum)) continue;
    if (b >= high && b > a && c < b) out.push({ index: i, kind: 'extreme_peak', value: b });
    if (b <= low && b < a && c > b) out.push({ index: i, kind: 'extreme_trough', value: b });
  }
  return out;
}

/**
 * Approximate dots: bull = ENTP crosses up MA1 while below MA3;
 * bear = ENTP crosses down MA1 while above MA3.
 */
export function crossDots(r: Ribbon): Mark[] {
  const out: Mark[] = [];
  const [ma1, , ma3] = r.ma;
  for (let i = 1; i < r.entp.length; i++) {
    if (crossover(r.entp, ma1, i) && r.entp[i] < ma3[i]) out.push({ index: i, kind: 'dot_bull', value: r.entp[i] });
    if (crossunder(r.entp, ma1, i) && r.entp[i] > ma3[i]) out.push({ index: i, kind: 'dot_bear', value: r.entp[i] });
  }
  return out;
}

// ─── Full computation ───────────────────────────────────────

export interface ElmoDResult {
  ribbon: Ribbon;
  lhh: Series;
  lhhSma20: Series;
  lhhSma50: Series;
  priceAlma: { len: number; values: Series }[];
  priceEma: { len: number; values: Series }[];
  shelves: Shelf[];
  boxes: ConsolidationBox[];
  extremeMarks: Mark[];
  dots: Mark[];
}

export function computeElmoD(bars: Bar[], partial: Partial<ElmoDOptions> = {}): ElmoDResult {
  const opts = { ...DEFAULT_ELMOD_OPTIONS, ...partial };
  const close = bars.map((b) => b.close);
  const e = entp(close, opts);
  const rib = ribbon(e, opts);
  const l = lhh(bars, opts.lhhLen);
  const l20 = sma(l, 20);
  const l50 = sma(l, 50);
  return {
    ribbon: rib,
    lhh: l,
    lhhSma20: l20,
    lhhSma50: l50,
    priceAlma: opts.priceAlmaLens.map((len) => ({ len, values: alma(close, len, opts.priceAlmaOffset, opts.priceAlmaSigma) })),
    priceEma: opts.emaLens.map((len) => ({ len, values: ema(close, len) })),
    shelves: liquidityShelves(bars, opts.pivotLeft, opts.pivotRight),
    boxes: consolidationBoxes(bars, l, l50, opts.boxMinBars),
    extremeMarks: extremeTurns(e, opts.extremeHigh, opts.extremeLow),
    dots: crossDots(rib),
  };
}
