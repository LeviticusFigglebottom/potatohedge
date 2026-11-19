'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { LineStyle, LineType, type IChartApi, type ISeriesApi, type LogicalRange, type SeriesMarker, type Time, type WhitespaceData, type LineData } from 'lightweight-charts';
import { computeElmoD, DEFAULT_ELMOD_OPTIONS, type ElmoDResult } from '@/lib/flowdesk/indicators/elmod';
import { CHART_INTERVALS, higherIntervals, htfOverlay, type ChartInterval } from '@/lib/flowdesk/indicators/mtf';
import type { Bar, NoSource } from '@/lib/flowdesk/types';
import { BandFill, Rects, Segments } from './chart/primitives';
import { C, deskChart, etTime } from './chart/theme';
import { NoSourceState, Panel, Seg, Toggle } from './ui';
import { useApi, useDesk } from './useFlowDesk';

const DEFAULT_ROWS = ['SPY', 'QQQ', 'DIA', 'IWM', 'BTCUSD', 'GLD', 'TLT'];
const MA_COLORS = ['#e8e8ef', C.cyan, C.amber, C.purple, C.pink];
const ALMA_COLORS = ['#7ee8ff', '#ffd166', '#c8a2ff'];
const EMA_COLORS = ['#5c8a99', '#8a7a4f', '#6f5f99', '#996f84'];
const HEAT = ['#ff3d57', '#a8404f', '#3a3a4d', '#2f9e66', '#00e676'];

const line = (times: Time[], vals: number[]): (LineData | WhitespaceData)[] =>
  times.map((time, i) => (Number.isFinite(vals[i]) ? { time, value: vals[i] } : { time }));

function useMultiBars(symbols: string[], interval: ChartInterval) {
  const mode = useDesk((s) => s.mode);
  const [state, setState] = useState<Record<string, Bar[] | NoSource | null>>({});
  const key = symbols.join(',');
  useEffect(() => {
    let alive = true;
    setState({});
    symbols.forEach((s) => {
      fetch(`/api/flow-desk/bars?mode=${mode}&interval=${interval}&symbol=${encodeURIComponent(s)}`)
        .then((r) => r.json())
        .then((b) => alive && setState((st) => ({ ...st, [s]: b.noSource ? (b as NoSource) : (b.data as Bar[]) ?? null })))
        .catch(() => alive && setState((st) => ({ ...st, [s]: null })));
    });
    return () => { alive = false; };
  }, [key, interval, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export function ElmoDPanel({ symbol }: { symbol: string }) {
  const mode = useDesk((s) => s.mode);
  const [interval, setInterval] = useState<ChartInterval>('5m');
  const [scaling, setScaling] = useState<'history' | 'rolling'>('history');
  const [htf, setHtf] = useState<ChartInterval | ''>('15m');
  const [show, setShow] = useState({ alma: true, ema: false, shelves: true, boxes: true, marks: true, dots: true, heatmap: true });
  const [rowsText, setRowsText] = useState(DEFAULT_ROWS.join(','));
  const rows = useMemo(() => [symbol, ...rowsText.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)].filter((s, i, a) => a.indexOf(s) === i).slice(0, 8), [symbol, rowsText]);
  const barsApi = useApi<Bar[]>(`/api/flow-desk/bars?mode=${mode}&interval=${interval}&symbol=${encodeURIComponent(symbol)}`);
  const heatBars = useMultiBars(show.heatmap ? rows : [], interval);
  const htfChoices = higherIntervals(interval);
  const effectiveHtf = htf && htfChoices.includes(htf) ? htf : '';

  const bars = barsApi.data;
  const opts = useMemo(() => ({ scaling: scaling === 'history' ? { mode: 'history' as const } : { mode: 'rolling' as const, window: 1000 } }), [scaling]);
  const res = useMemo<ElmoDResult | null>(() => (bars && bars.length ? computeElmoD(bars, opts) : null), [bars, opts]);
  const overlay = useMemo(() => (bars && effectiveHtf ? htfOverlay(bars, interval, effectiveHtf, opts) : null), [bars, interval, effectiveHtf, opts]);
  const heat = useMemo(() => rows.map((s) => {
    const b = heatBars[s];
    if (!b || !Array.isArray(b) || b.length === 0) return { symbol: s, times: [] as number[], fills: [] as number[], dots: [] as { i: number; bull: boolean }[], missing: !!b && !Array.isArray(b) };
    const r = computeElmoD(b, { ...opts, lookback: 20 });
    return { symbol: s, times: b.map((x) => x.time), fills: r.ribbon.bullishFills, dots: r.dots.map((d) => ({ i: d.index, bull: d.kind === 'dot_bull' })), missing: false };
  }), [rows, heatBars, opts]);

  // ── charts
  const priceEl = useRef<HTMLDivElement>(null);
  const paneEl = useRef<HTMLDivElement>(null);
  const lhhEl = useRef<HTMLDivElement>(null);
  const heatEl = useRef<HTMLCanvasElement>(null);
  const charts = useRef<IChartApi[]>([]);
  const s = useRef<Record<string, ISeriesApi<'Line'> | ISeriesApi<'Candlestick'> | ISeriesApi<'Histogram'>>>({});
  const prims = useRef<{ bands: BandFill; rects: Rects; segs: Segments } | null>(null);
  const timesRef = useRef<Time[]>([]);
  const heatRef = useRef(heat);
  heatRef.current = heat;
  const dotsRef = useRef(show.dots);
  dotsRef.current = show.dots;
  const rawTimesRef = useRef<number[]>([]);

  useEffect(() => {
    if (!priceEl.current || !paneEl.current || !lhhEl.current) return;
    const common = { rightPriceScale: { minimumWidth: 72, borderColor: C.border } };
    const price = deskChart(priceEl.current, common);
    const pane = deskChart(paneEl.current, { ...common, timeScale: { visible: false } });
    const lhh = deskChart(lhhEl.current, { ...common, timeScale: { visible: false } });
    charts.current = [price, pane, lhh];
    const reg: typeof s.current = {};
    reg.candles = price.addCandlestickSeries({ upColor: C.green, downColor: C.red, borderVisible: false, wickUpColor: '#00e67699', wickDownColor: '#ff3d5799' });
    [0, 1, 2].forEach((k) => (reg[`alma${k}`] = price.addLineSeries({ color: ALMA_COLORS[k], lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })));
    [0, 1, 2, 3].forEach((k) => (reg[`ema${k}`] = price.addLineSeries({ color: EMA_COLORS[k], lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })));
    [0, 1, 2, 3, 4].forEach((k) => (reg[`ma${k}`] = pane.addLineSeries({ color: MA_COLORS[k], lineWidth: k === 0 ? 2 : 1, priceLineVisible: false, lastValueVisible: k === 0, crosshairMarkerVisible: k === 0, title: k === 0 ? 'ENTP' : '' })));
    ['hEntp', 'hMa1', 'hMa2'].forEach((k, i) => (reg[k] = pane.addLineSeries({ color: [C.cyan, C.amber, C.purple][i], lineWidth: 1, lineStyle: LineStyle.SparseDotted, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })));
    const entpSeries = reg.ma0 as ISeriesApi<'Line'>;
    entpSeries.createPriceLine({ price: 80, color: '#ff3d5766', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });
    entpSeries.createPriceLine({ price: 20, color: '#00e67666', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' });
    pane.priceScale('right').applyOptions({ autoScale: true, scaleMargins: { top: 0.06, bottom: 0.06 } });
    reg.lhh = lhh.addHistogramSeries({ color: '#8888a066', priceLineVisible: false, lastValueVisible: false });
    reg.lhh20 = lhh.addLineSeries({ color: C.cyan, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    reg.lhh50 = lhh.addLineSeries({ color: C.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.current = reg;
    const bands = new BandFill('rgba(0,230,118,0.16)', 'rgba(255,61,87,0.16)');
    entpSeries.attachPrimitive(bands);
    const rects = new Rects();
    const segs = new Segments();
    (reg.candles as ISeriesApi<'Candlestick'>).attachPrimitive(rects);
    (reg.candles as ISeriesApi<'Candlestick'>).attachPrimitive(segs);
    prims.current = { bands, rects, segs };

    // sync visible range across the stacked panes + heatmap
    let syncing = false;
    const onRange = (src: IChartApi) => (r: LogicalRange | null) => {
      if (syncing || !r) return;
      syncing = true;
      charts.current.forEach((c) => c !== src && c.timeScale().setVisibleLogicalRange(r));
      syncing = false;
      requestAnimationFrame(drawHeat);
    };
    charts.current.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange(onRange(c)));
    const ro = new ResizeObserver(() => requestAnimationFrame(drawHeat));
    ro.observe(priceEl.current);
    return () => { ro.disconnect(); charts.current.forEach((c) => c.remove()); charts.current = []; prims.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function drawHeat() {
    const cv = heatEl.current;
    const price = charts.current[0];
    if (!cv || !price) return;
    const rowsNow = heatRef.current;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, rowH = 16, h = rowsNow.length * rowH + 4;
    cv.height = h * dpr; cv.width = w * dpr; cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const ts = price.timeScale();
    const times = rawTimesRef.current;
    const labelX = w - price.priceScale('right').width();
    const range = ts.getVisibleLogicalRange();
    if (!range || times.length === 0) return;
    const from = Math.max(0, Math.floor(range.from)), to = Math.min(times.length - 1, Math.ceil(range.to));
    const bw = Math.max(1, ts.width() / Math.max(1, range.to - range.from));
    rowsNow.forEach((row, ri) => {
      const y = ri * rowH + 2;
      let k = -1;
      const dotsAt = new Map(row.dots.map((d) => [d.i, d.bull]));
      for (let i = from; i <= to; i++) {
        const t = times[i];
        while (k + 1 < row.times.length && row.times[k + 1] <= t) k++;
        if (k < 0) continue;
        const v = row.fills[k];
        const x = ts.logicalToCoordinate(i as unknown as Parameters<typeof ts.logicalToCoordinate>[0]);
        if (x == null || !Number.isFinite(v)) continue;
        ctx.fillStyle = HEAT[v];
        ctx.fillRect(x - bw / 2, y, Math.ceil(bw), rowH - 3);
        if (dotsRef.current && dotsAt.has(k) && row.times[k] === t) {
          ctx.fillStyle = dotsAt.get(k) ? '#ffffff' : '#111118';
          ctx.beginPath(); ctx.arc(x, y + (rowH - 3) / 2, 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.fillStyle = row.missing ? C.muted : C.text;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText(row.missing ? `${row.symbol} n/a` : row.symbol, labelX + 6, y + 10);
    });
  }

  // data → series
  useEffect(() => {
    const reg = s.current;
    if (!bars || !res || !reg.candles || !prims.current) return;
    const intraday = interval !== '1D';
    const times = bars.map((b) => (intraday ? etTime(b.time) : (b.time as Time)));
    timesRef.current = times;
    rawTimesRef.current = bars.map((b) => b.time);
    charts.current.forEach((c) => c.applyOptions({ timeScale: { timeVisible: intraday } }));
    (reg.candles as ISeriesApi<'Candlestick'>).setData(bars.map((b, i) => ({ time: times[i], open: b.open, high: b.high, low: b.low, close: b.close })));
    res.priceAlma.forEach((a, k) => { reg[`alma${k}`].setData(show.alma ? line(times, a.values) : []); });
    res.priceEma.forEach((a, k) => { reg[`ema${k}`].setData(show.ema ? line(times, a.values) : []); });
    const lines = [res.ribbon.entp, ...res.ribbon.ma];
    lines.forEach((v, k) => reg[`ma${k}`].setData(line(times, v)));
    reg.hEntp.setData(overlay ? line(times, overlay.entp) : []);
    reg.hMa1.setData(overlay ? line(times, overlay.ma1) : []);
    reg.hMa2.setData(overlay ? line(times, overlay.ma2) : []);
    (reg.lhh as ISeriesApi<'Histogram'>).setData(line(times, res.lhh) as never);
    reg.lhh20.setData(line(times, res.lhhSma20));
    reg.lhh50.setData(line(times, res.lhhSma50));
    (reg.ma0 as ISeriesApi<'Line'>).applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: -2, maxValue: 102 } }) });

    prims.current.bands.set(times, [0, 1, 2, 3].map((b) => ({
      upper: lines[b], lower: lines[b + 1], bull: res.ribbon.bands.map((row) => row[b]),
    })));
    prims.current.rects.set(show.boxes ? res.boxes.map((bx) => ({ from: times[bx.startIndex], to: times[bx.endIndex], top: bx.top, bottom: bx.bottom, fill: 'rgba(179,136,255,0.08)', stroke: 'rgba(179,136,255,0.45)' })) : []);
    const lastIdx = bars.length - 1;
    // Active shelves (not yet traded through) plus any broken in the last 40 bars, nearest to price first.
    const lastClose = bars[lastIdx].close;
    const recent = res.shelves
      .filter((sh) => sh.brokenAt == null || sh.brokenAt > lastIdx - 40)
      .sort((a, b) => Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose))
      .slice(0, 14);
    prims.current.segs.set(show.shelves ? recent.map((sh) => ({
      from: times[sh.fromIndex], to: sh.brokenAt == null ? null : times[sh.brokenAt], price: sh.price,
      color: sh.kind === 'pivot_high' ? '#ff3d5799' : sh.kind === 'pivot_low' ? '#00e67699' : '#ffaa0099',
      dashed: sh.kind.startsWith('gap'), label: sh.brokenAt == null ? (sh.kind.startsWith('gap') ? 'gap' : 'shelf') : undefined,
    })) : []);

    const markers: SeriesMarker<Time>[] = [];
    if (show.marks) for (const m of res.extremeMarks) markers.push({ time: times[m.index], position: m.kind === 'extreme_peak' ? 'aboveBar' : 'belowBar', color: m.kind === 'extreme_peak' ? C.red : C.green, shape: 'circle', text: m.kind === 'extreme_peak' ? 'ctx▼' : 'ctx▲' });
    if (show.dots) for (const d of res.dots) markers.push({ time: times[d.index], position: d.kind === 'dot_bull' ? 'belowBar' : 'aboveBar', color: d.kind === 'dot_bull' ? '#ffffffcc' : '#8888a0', shape: d.kind === 'dot_bull' ? 'arrowUp' : 'arrowDown', text: '≈' });
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    (reg.ma0 as ISeriesApi<'Line'>).setMarkers(markers);
    const n = bars.length;
    const r = { from: Math.max(0, n - 260), to: n + 3 };
    charts.current.forEach((c) => c.timeScale().setVisibleLogicalRange(r));
    requestAnimationFrame(drawHeat);
  }, [bars, res, overlay, show, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { requestAnimationFrame(drawHeat); }, [heat, show.dots]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = res && bars ? bars.length - 1 : -1;
  const fillsNow = res && last >= 0 ? res.ribbon.bullishFills[last] : NaN;

  return (
    <Panel id="elmod" title={`ELMo-D — ${symbol} · ${interval}`}
      subtitle={`ENTP = 100·(r−min)/(max−min), r = WMA9(ln(close/close[10])) · scaling: ${scaling === 'history' ? 'loaded history' : 'rolling 1,000 bars'} · ribbon ALMA 5/20/50/100 (0.85, σ10) · LHH(10) with SMA20/50${effectiveHtf ? ` · HTF ${effectiveHtf} overlay from completed bars only` : ''}`}
      actions={<>
        <Seg value={interval} onChange={setInterval} options={CHART_INTERVALS.map((i) => ({ value: i, label: i }))} />
        <Seg value={scaling} onChange={setScaling} options={[{ value: 'history', label: 'Hist scale' }, { value: 'rolling', label: 'Roll 1000' }]} />
        <select value={effectiveHtf} onChange={(e) => setHtf(e.target.value as ChartInterval | '')} className="bg-bg-tertiary border border-border rounded px-1.5 py-1 font-mono text-[11px] text-text-secondary" aria-label="Higher timeframe overlay">
          <option value="">No HTF overlay</option>
          {htfChoices.map((h) => <option key={h} value={h}>HTF {h} ENTP/MA1/MA2</option>)}
        </select>
      </>}>
      <div className="flex flex-wrap gap-3 mb-2 text-[11px] font-mono">
        {(Object.keys(show) as (keyof typeof show)[]).map((k) => (
          <Toggle key={k} label={{ alma: 'ALMA 20/100/200', ema: 'EMA 20/50/100/200', shelves: 'Liquidity shelves', boxes: 'Consolidation boxes', marks: 'Extreme-turn context marks', dots: 'Cross dots (approximate)', heatmap: 'Heatmap pane' }[k]} checked={show[k]} onChange={(v) => setShow({ ...show, [k]: v })} />
        ))}
      </div>
      {barsApi.noSource ? <NoSourceState ns={barsApi.noSource} /> : barsApi.error ? <div className="text-xs text-accent-red py-4">{barsApi.error}</div> : null}
      <div className={barsApi.noSource ? 'hidden' : ''}>
        <div ref={priceEl} className="h-[340px] w-full" data-pane="price" />
        <div className="flex items-center justify-between text-[10px] font-mono text-text-muted px-1 pt-1">
          <span>ELMo-D pane · ENTP <span className="text-text-primary">━</span> MA1 <span style={{ color: C.cyan }}>━</span> MA2 <span style={{ color: C.amber }}>━</span> MA3 <span style={{ color: C.purple }}>━</span> MA4 <span style={{ color: C.pink }}>━</span>{effectiveHtf && <> · HTF {effectiveHtf} step lines ┅</>} · fills green = faster line above slower</span>
          <span>bullish fills now: <span className="text-text-primary">{Number.isFinite(fillsNow) ? `${fillsNow}/4` : '—'}</span></span>
        </div>
        <div ref={paneEl} className="h-[200px] w-full" data-pane="elmod" />
        <div className="text-[10px] font-mono text-text-muted px-1 pt-1">LHH (Hui-Heubel, 10) · bars = LHH, <span style={{ color: C.cyan }}>SMA20</span>, <span style={{ color: C.amber }}>SMA50</span> · boxes on price where LHH &lt; SMA50 for ≥ 6 bars</div>
        <div ref={lhhEl} className="h-[110px] w-full" data-pane="lhh" />
        {show.heatmap && (
          <div className="mt-1" data-pane="heatmap">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-text-muted px-1 py-1">
              <span>Heatmap · cell = bullish fills (0–4) at ENTP lookback 20 · {HEAT.map((c, i) => <span key={i} className="inline-flex items-center gap-0.5 mr-1"><span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: c }} />{i}</span>)} · dots: ENTP×MA1 cross vs MA3 (approximate)</span>
              <label className="inline-flex items-center gap-1">rows <input value={rowsText} onChange={(e) => setRowsText(e.target.value)} className="bg-bg-tertiary border border-border rounded px-1 py-0.5 w-[260px] text-text-secondary" aria-label="Heatmap tickers" /></label>
            </div>
            <canvas ref={heatEl} className="w-full block" />
          </div>
        )}
        <div className="text-[10px] font-mono text-text-muted mt-2">
          ctx▼ / ctx▲ = extreme-turn <span className="text-accent-amber">context marks, not signals</span>: ENTP peak ≥ {DEFAULT_ELMOD_OPTIONS.extremeHigh} that has started dipping / trough ≤ {DEFAULT_ELMOD_OPTIONS.extremeLow} that has started rising. ≈ arrows = approximate cross dots.
        </div>
      </div>
    </Panel>
  );
}
