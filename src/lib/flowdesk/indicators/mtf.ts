/**
 * Multi-timeframe helpers: aggregate lower-timeframe bars into higher-timeframe
 * bars and map HTF values back onto LTF bars WITHOUT look-ahead.
 *
 * A HTF bucket is "completed" for LTF bar i only once bar i is the last LTF bar
 * whose open time falls inside the bucket AND the bucket's end time is ≤ the end
 * of bar i. The overlay at LTF bar i shows the value of the most recent completed
 * HTF bar — never the bucket that bar i is still building.
 */

import { DEFAULT_ELMOD_OPTIONS, entp, ribbon, type Bar, type ElmoDOptions } from './elmod';
import { etOffsetMs } from '../time';

export type ChartInterval = '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1D';

export const CHART_INTERVALS: ChartInterval[] = ['1m', '3m', '5m', '15m', '1h', '4h', '1D'];

export const INTERVAL_SECONDS: Record<ChartInterval, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400,
};

/**
 * Bucket start (unix seconds) for a bar time. Intraday buckets are aligned to
 * ET midnight so 1h/4h/1D boundaries match exchange-local wall-clock time.
 */
export function bucketStart(timeSec: number, interval: ChartInterval): number {
  const size = INTERVAL_SECONDS[interval];
  const offSec = Math.round(etOffsetMs(timeSec * 1000) / 1000); // e.g. −18000
  const local = timeSec + offSec;
  return local - (((local % size) + size) % size) - offSec;
}

export interface HtfBar extends Bar {
  /** bucket end (exclusive), unix seconds */
  end: number;
  /** index of the last LTF bar inside the bucket */
  lastLtfIndex: number;
  /** true if the bucket has fully elapsed according to the LTF data */
  complete: boolean;
  /** first LTF index at whose close the bucket is known to be complete (Infinity if not yet) */
  knownAt: number;
}

export function resample(bars: Bar[], ltf: ChartInterval, htf: ChartInterval): HtfBar[] {
  const ltfSec = INTERVAL_SECONDS[ltf];
  const htfSec = INTERVAL_SECONDS[htf];
  const out: HtfBar[] = [];
  let cur: HtfBar | null = null;
  bars.forEach((b, i) => {
    const start = bucketStart(b.time, htf);
    if (!cur || cur.time !== start) {
      if (cur) out.push(cur);
      cur = { time: start, end: start + htfSec, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, lastLtfIndex: i, complete: false, knownAt: Infinity };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      cur.lastLtfIndex = i;
    }
  });
  if (cur) out.push(cur);
  // A bucket is complete if a later bucket started, or its last LTF bar reaches the end.
  // If the last LTF bar reaches the bucket end, it is known at that bar's close;
  // otherwise only once the first bar of the next bucket closes.
  out.forEach((h, k) => {
    const lastBar = bars[h.lastLtfIndex];
    if (lastBar.time + ltfSec >= h.end) h.knownAt = h.lastLtfIndex;
    else if (k < out.length - 1) h.knownAt = h.lastLtfIndex + 1;
    h.complete = Number.isFinite(h.knownAt);
  });
  return out;
}

/** Bars that are safe to compute HTF indicators on (completed buckets only). */
export function completedHtfBars(bars: Bar[], ltf: ChartInterval, htf: ChartInterval): HtfBar[] {
  return resample(bars, ltf, htf).filter((h) => h.complete);
}

/**
 * Map a HTF series (aligned with `htfBars`) onto LTF bars: LTF bar i receives the
 * value of the latest HTF bar whose knownAt ≤ i (i.e. that was known complete by
 * the close of bar i). Before the first completed HTF bar: NaN.
 */
export function mapHtfToLtf(ltfLength: number, htfBars: HtfBar[], htfValues: number[]): number[] {
  const out = new Array<number>(ltfLength).fill(NaN);
  let k = -1;
  for (let i = 0; i < ltfLength; i++) {
    while (k + 1 < htfBars.length && htfBars[k + 1].knownAt <= i) k++;
    if (k >= 0) out[i] = htfValues[k];
  }
  return out;
}

/** Valid HTF choices for an LTF (strictly larger and an integer multiple). */
export function higherIntervals(ltf: ChartInterval): ChartInterval[] {
  const s = INTERVAL_SECONDS[ltf];
  return CHART_INTERVALS.filter((i) => INTERVAL_SECONDS[i] > s && INTERVAL_SECONDS[i] % s === 0);
}

export interface HtfOverlay {
  htf: ChartInterval;
  entp: number[];
  ma1: number[];
  ma2: number[];
}

/**
 * ENTP / MA1 / MA2 of a higher timeframe, computed from completed HTF bars only
 * and stepped onto the LTF bars. Note: with `scaling: history` the 0–100 range
 * uses the whole loaded HTF history (that is the definition of history scaling);
 * choose rolling scaling for a strictly causal overlay.
 */
export function htfOverlay(bars: Bar[], ltf: ChartInterval, htf: ChartInterval, partial: Partial<ElmoDOptions> = {}): HtfOverlay {
  const opts = { ...DEFAULT_ELMOD_OPTIONS, ...partial };
  const hBars = completedHtfBars(bars, ltf, htf);
  const e = entp(hBars.map((b) => b.close), opts);
  const rib = ribbon(e, opts);
  return {
    htf,
    entp: mapHtfToLtf(bars.length, hBars, e),
    ma1: mapHtfToLtf(bars.length, hBars, rib.ma[0]),
    ma2: mapHtfToLtf(bars.length, hBars, rib.ma[1]),
  };
}
