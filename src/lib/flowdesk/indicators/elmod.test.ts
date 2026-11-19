import { describe, expect, it } from 'vitest';
import { alma, almaWeights, ema, highest, lowest, pivots, sma, wma } from './ta';
import { computeElmoD, entp, entpRaw, extremeTurns, lhh, ribbon, scaleEntp, type Bar } from './elmod';
import { completedHtfBars, htfOverlay, mapHtfToLtf, resample, bucketStart } from './mtf';
import { etToMs } from '../time';

/** Small deterministic fixture: trending + oscillating synthetic prices. */
function fixture(n = 300): Bar[] {
  const bars: Bar[] = [];
  const t0 = Math.floor(etToMs('2026-11-16', 9, 30) / 1000);
  for (let i = 0; i < n; i++) {
    const c = 100 + i * 0.05 + 3 * Math.sin(i / 7) + 1.2 * Math.sin(i / 2.3);
    const o = i === 0 ? c : bars[i - 1].close;
    bars.push({ time: t0 + i * 300, open: o, high: Math.max(o, c) + 0.3 + 0.2 * Math.abs(Math.sin(i)), low: Math.min(o, c) - 0.3 - 0.2 * Math.abs(Math.cos(i)), close: c, volume: 1000 + 400 * Math.abs(Math.sin(i / 5)) });
  }
  return bars;
}

describe('Pine primitives', () => {
  it('WMA weights newest bar most (ta.wma)', () => {
    const w = wma([1, 2, 3, 4], 3);
    expect(w[0]).toBeNaN();
    expect(w[1]).toBeNaN();
    expect(w[2]).toBeCloseTo((1 * 1 + 2 * 2 + 3 * 3) / 6, 12);
    expect(w[3]).toBeCloseTo((2 * 1 + 3 * 2 + 4 * 3) / 6, 12);
  });

  it('ALMA weights follow m = floor(offset·(len−1)), s = len/sigma', () => {
    const w = almaWeights(4, 0.85, 6);
    const m = Math.floor(0.85 * 3); // 2
    const s = 4 / 6;
    expect(m).toBe(2);
    for (let i = 0; i < 4; i++) expect(w[i]).toBeCloseTo(Math.exp(-((i - m) ** 2) / (2 * s * s)), 14);
    // peak at m
    expect(Math.max(...w)).toBe(w[2]);
  });

  it('ALMA applies weight 0 to the oldest bar (Pine ta.alma orientation)', () => {
    const x = [10, 20, 40, 80];
    const w = almaWeights(4, 0.85, 6);
    const expected = (x[0] * w[0] + x[1] * w[1] + x[2] * w[2] + x[3] * w[3]) / w.reduce((a, b) => a + b, 0);
    const reversed = (x[3] * w[0] + x[2] * w[1] + x[1] * w[2] + x[0] * w[3]) / w.reduce((a, b) => a + b, 0);
    const got = alma(x, 4, 0.85, 6)[3];
    expect(got).toBeCloseTo(expected, 12);
    expect(Math.abs(got - reversed)).toBeGreaterThan(1);
  });

  it('ALMA symmetric hand check: len 3, offset .85, sigma 6', () => {
    // m = floor(1.7) = 1, s = 0.5 → weights e^-2, 1, e^-2
    const e2 = Math.exp(-2);
    expect(alma([1, 2, 4], 3, 0.85, 6)[2]).toBeCloseTo((1 * e2 + 2 + 4 * e2) / (1 + 2 * e2), 12);
  });

  it('ALMA of a constant series is the constant; NaN propagates', () => {
    const a = alma(new Array(30).fill(5), 20, 0.85, 10);
    expect(a[19]).toBeCloseTo(5, 12);
    expect(a[18]).toBeNaN();
    expect(alma([1, NaN, 3, 4], 2)[2]).toBeNaN();
  });

  it('SMA / EMA / highest / lowest basics', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[2]).toBeCloseTo(2, 12); // SMA seed
    expect(e[3]).toBeCloseTo(0.5 * 4 + 0.5 * 2, 12);
    expect(highest([1, 5, 2, 3], 2)).toEqual([NaN, 5, 5, 3]);
    expect(lowest([1, 5, 2, 3], 2)).toEqual([NaN, 1, 2, 2]);
  });

  it('pivots are confirmed `right` bars later', () => {
    const high = [1, 2, 3, 9, 3, 2, 1, 1];
    const low = high.map((h) => h - 1);
    const p = pivots(high, low, 3, 2).filter((x) => x.kind === 'high');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ index: 3, confirmedAt: 5, price: 9 });
  });
});

describe('ENTP', () => {
  it('r = WMA9(ln(close/close[10]))', () => {
    const close = fixture().map((b) => b.close);
    const r = entpRaw(close, 10, 9);
    const lr = close.map((c, i) => (i >= 10 ? Math.log(c / close[i - 10]) : NaN));
    const i = 50;
    let s = 0;
    for (let k = 0; k < 9; k++) s += lr[i - k] * (9 - k);
    expect(r[i]).toBeCloseTo(s / 45, 12);
    expect(r[17]).toBeNaN(); // first valid r is at index 10 + 8 = 18
    expect(Number.isFinite(r[18])).toBe(true);
  });

  it('history scaling spans exactly 0..100', () => {
    const e = entp(fixture().map((b) => b.close), { lookback: 10, wmaLen: 9, scaling: { mode: 'history' } });
    const vals = e.filter(Number.isFinite);
    expect(Math.min(...vals)).toBeCloseTo(0, 9);
    expect(Math.max(...vals)).toBeCloseTo(100, 9);
  });

  it('rolling scaling is causal (truncating the future does not change the past)', () => {
    const close = fixture().map((b) => b.close);
    const r = entpRaw(close);
    const full = scaleEntp(r, { mode: 'rolling', window: 1000 });
    const cut = scaleEntp(r.slice(0, 120), { mode: 'rolling', window: 1000 });
    for (let i = 0; i < 120; i++) expect(cut[i]).toEqual(full[i]);
  });

  it('ribbon MAs are ALMA(ENTP, 5/20/50/100, 0.85, 10) and fills count 0..4', () => {
    const close = fixture().map((b) => b.close);
    const e = entp(close, { lookback: 10, wmaLen: 9, scaling: { mode: 'history' } });
    const rib = ribbon(e, { maLens: [5, 20, 50, 100], maOffset: 0.85, maSigma: 10 });
    expect(rib.ma[1][200]).toBeCloseTo(alma(e, 20, 0.85, 10)[200], 12);
    const i = 250;
    const lines = [e, ...rib.ma];
    let count = 0;
    for (let b = 0; b < 4; b++) if (lines[b][i] > lines[b + 1][i]) count++;
    expect(rib.bullishFills[i]).toBe(count);
    expect(rib.bullishFills.filter(Number.isFinite).every((v) => v >= 0 && v <= 4)).toBe(true);
  });
});

describe('LHH', () => {
  it('matches the Hui-Heubel definition on bar i', () => {
    const bars = fixture();
    const l = lhh(bars, 10);
    const i = 40;
    const w = bars.slice(i - 9, i + 1);
    const pmax = Math.max(...w.map((b) => b.high));
    const pmin = Math.min(...w.map((b) => b.low));
    const dv = w.reduce((a, b) => a + ((b.high + b.low + b.close) / 3) * b.volume, 0);
    const smaV = w.reduce((a, b) => a + b.volume, 0) / 10;
    const smaC = w.reduce((a, b) => a + b.close, 0) / 10;
    expect(l[i]).toBeCloseTo(((pmax - pmin) / pmin) / (dv / (smaV * smaC)) * 100, 10);
    expect(l[8]).toBeNaN();
  });
});

describe('marks, shelves, boxes', () => {
  it('extreme turns: peak ≥ 80 that started dipping, trough ≤ 20 that started rising', () => {
    const e = [50, 70, 85, 90, 88, 60, 30, 15, 10, 12, 40];
    const m = extremeTurns(e, 80, 20);
    expect(m).toEqual([
      { index: 4, kind: 'extreme_peak', value: 90 },
      { index: 9, kind: 'extreme_trough', value: 10 },
    ]);
  });

  it('computeElmoD returns aligned series and sane structures', () => {
    const bars = fixture();
    const r = computeElmoD(bars);
    expect(r.ribbon.entp).toHaveLength(bars.length);
    expect(r.lhhSma50).toHaveLength(bars.length);
    expect(r.priceAlma.map((a) => a.len)).toEqual([20, 100, 200]);
    expect(r.priceEma.map((a) => a.len)).toEqual([20, 50, 100, 200]);
    for (const s of r.shelves) expect(s.knownAt).toBeGreaterThanOrEqual(s.fromIndex);
    for (const b of r.boxes) {
      expect(b.endIndex - b.startIndex + 1).toBeGreaterThanOrEqual(6);
      for (let i = b.startIndex; i <= b.endIndex; i++) expect(r.lhh[i]).toBeLessThan(r.lhhSma50[i]);
    }
  });
});

describe('multi-timeframe', () => {
  it('resamples 5m → 15m with correct OHLCV', () => {
    const bars = fixture(30);
    const h = resample(bars, '5m', '15m');
    expect(h[0].time).toBe(bucketStart(bars[0].time, '15m'));
    expect(h[0].open).toBe(bars[0].open);
    expect(h[0].close).toBe(bars[2].close);
    expect(h[0].high).toBe(Math.max(bars[0].high, bars[1].high, bars[2].high));
    expect(h[0].volume).toBeCloseTo(bars[0].volume + bars[1].volume + bars[2].volume, 9);
  });

  it('only completed HTF bars are mapped onto LTF bars', () => {
    const bars = fixture(31); // last 15m bucket has a single 5m bar → incomplete
    const all = resample(bars, '5m', '15m');
    expect(all[all.length - 1].complete).toBe(false);
    const done = completedHtfBars(bars, '5m', '15m');
    const mapped = mapHtfToLtf(bars.length, done, done.map((_, k) => k));
    expect(mapped[0]).toBeNaN();
    expect(mapped[1]).toBeNaN();
    expect(mapped[2]).toBe(0); // first bucket completes at the close of its 3rd 5m bar
    expect(mapped[5]).toBe(1);
    expect(mapped[30]).toBe(9); // the in-progress bucket never leaks
  });

  it('HTF overlay has no look-ahead: future LTF bars never change past values', () => {
    const bars = fixture(400);
    const opts = { scaling: { mode: 'rolling' as const, window: 1000 } };
    const full = htfOverlay(bars, '5m', '15m', opts);
    for (const cut of [150, 151, 152, 299]) {
      const part = htfOverlay(bars.slice(0, cut), '5m', '15m', opts);
      for (let i = 0; i < cut; i++) {
        expect(part.entp[i]).toEqual(full.entp[i]);
        expect(part.ma1[i]).toEqual(full.ma1[i]);
      }
    }
  });
});
