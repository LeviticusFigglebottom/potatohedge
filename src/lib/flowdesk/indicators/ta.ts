/**
 * Technical-analysis primitives with TradingView Pine conventions.
 *
 * Every function takes a series ordered OLDEST → NEWEST (index 0 = first bar)
 * and returns a series of the same length. Warm-up bars, and any window that
 * contains a NaN, yield NaN — the same as Pine's `na` propagation.
 *
 * Pure functions, no dependencies: safe on server, client and in tests.
 */

export type Series = number[];

const isNum = (v: number) => typeof v === 'number' && Number.isFinite(v);

/** Simple moving average (ta.sma). */
export function sma(src: Series, len: number): Series {
  const out = new Array<number>(src.length).fill(NaN);
  if (len <= 0) return out;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = 0; k < len; k++) {
      const v = src[i - k];
      if (!isNum(v)) { ok = false; break; }
      s += v;
    }
    if (ok) out[i] = s / len;
  }
  return out;
}

/**
 * Weighted moving average (ta.wma): newest bar weight `len`, oldest weight 1.
 *   wma = Σ_{k=0}^{len-1} src[i-k]·(len-k) / Σ (len-k)
 */
export function wma(src: Series, len: number): Series {
  const out = new Array<number>(src.length).fill(NaN);
  if (len <= 0) return out;
  const norm = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = 0; k < len; k++) {
      const v = src[i - k];
      if (!isNum(v)) { ok = false; break; }
      s += v * (len - k);
    }
    if (ok) out[i] = s / norm;
  }
  return out;
}

/**
 * ALMA weights exactly as Pine's ta.alma (floor = true):
 *   m = floor(offset·(len−1)), s = len/sigma, w_i = exp(−(i−m)²/(2s²)), i = 0..len−1
 * Weight w_0 applies to the OLDEST bar in the window, w_{len−1} to the newest.
 * Returned weights are NOT normalised (Pine divides by their sum).
 */
export function almaWeights(len: number, offset: number, sigma: number): number[] {
  const m = Math.floor(offset * (len - 1));
  const s = len / sigma;
  const w: number[] = [];
  for (let i = 0; i < len; i++) w.push(Math.exp(-((i - m) ** 2) / (2 * s * s)));
  return w;
}

/** Arnaud Legoux moving average (ta.alma with floor = true). */
export function alma(src: Series, len: number, offset = 0.85, sigma = 6): Series {
  const out = new Array<number>(src.length).fill(NaN);
  if (len <= 0) return out;
  const w = almaWeights(len, offset, sigma);
  const norm = w.reduce((a, b) => a + b, 0);
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = 0; j < len; j++) {
      // Pine: sum += series[len - j - 1] * w_j  → j=0 is the oldest bar
      const v = src[i - (len - 1 - j)];
      if (!isNum(v)) { ok = false; break; }
      s += v * w[j];
    }
    if (ok) out[i] = s / norm;
  }
  return out;
}

/**
 * Exponential moving average, alpha = 2/(len+1), seeded with the SMA of the
 * first `len` valid values (NaN before that). Leading NaNs are skipped.
 */
export function ema(src: Series, len: number): Series {
  const out = new Array<number>(src.length).fill(NaN);
  if (len <= 0) return out;
  const alpha = 2 / (len + 1);
  let start = src.findIndex(isNum);
  if (start < 0) return out;
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = start; i < src.length; i++) {
    const v = src[i];
    if (!isNum(v)) { out[i] = prev; continue; }
    if (seedCount < len) {
      seedSum += v;
      seedCount++;
      if (seedCount === len) { prev = seedSum / len; out[i] = prev; }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Rolling sum (math.sum). */
export function sum(src: Series, len: number): Series {
  return sma(src, len).map((v) => (isNum(v) ? v * len : NaN));
}

/** ta.highest(src, len) — includes the current bar. */
export function highest(src: Series, len: number): Series {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let m = -Infinity;
    let ok = true;
    for (let k = 0; k < len; k++) {
      const v = src[i - k];
      if (!isNum(v)) { ok = false; break; }
      if (v > m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

/** ta.lowest(src, len) — includes the current bar. */
export function lowest(src: Series, len: number): Series {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let m = Infinity;
    let ok = true;
    for (let k = 0; k < len; k++) {
      const v = src[i - k];
      if (!isNum(v)) { ok = false; break; }
      if (v < m) m = v;
    }
    if (ok) out[i] = m;
  }
  return out;
}

/** src[i - n] (Pine history reference). */
export function shift(src: Series, n: number): Series {
  return src.map((_, i) => (i - n >= 0 && i - n < src.length ? src[i - n] : NaN));
}

/** ta.crossover(a, b): a > b now and a <= b on the previous bar. */
export function crossover(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  const [a0, a1, b0, b1] = [a[i], a[i - 1], b[i], b[i - 1]];
  if (![a0, a1, b0, b1].every(isNum)) return false;
  return a0 > b0 && a1 <= b1;
}

/** ta.crossunder(a, b). */
export function crossunder(a: Series, b: Series, i: number): boolean {
  if (i < 1) return false;
  const [a0, a1, b0, b1] = [a[i], a[i - 1], b[i], b[i - 1]];
  if (![a0, a1, b0, b1].every(isNum)) return false;
  return a0 < b0 && a1 >= b1;
}

export interface Pivot {
  /** index of the pivot bar itself */
  index: number;
  /** index of the bar on which the pivot becomes known (index + right) */
  confirmedAt: number;
  price: number;
  kind: 'high' | 'low';
}

/**
 * Confirmed pivots (ta.pivothigh / ta.pivotlow semantics): the pivot bar must be
 * strictly above (below) the `left` bars before it and at least as high (low) as
 * the `right` bars after it. A pivot is only known `right` bars later.
 */
export function pivots(high: Series, low: Series, left: number, right: number): Pivot[] {
  const out: Pivot[] = [];
  for (let p = left; p + right < high.length; p++) {
    const h = high[p];
    const l = low[p];
    let isHigh = isNum(h);
    let isLow = isNum(l);
    for (let k = 1; k <= left && (isHigh || isLow); k++) {
      if (!(h > high[p - k])) isHigh = false;
      if (!(l < low[p - k])) isLow = false;
    }
    for (let k = 1; k <= right && (isHigh || isLow); k++) {
      if (!(h >= high[p + k])) isHigh = false;
      if (!(l <= low[p + k])) isLow = false;
    }
    if (isHigh) out.push({ index: p, confirmedAt: p + right, price: h, kind: 'high' });
    if (isLow) out.push({ index: p, confirmedAt: p + right, price: l, kind: 'low' });
  }
  return out;
}
