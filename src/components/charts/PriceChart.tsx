'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type IPriceLine, type CandlestickData, type HistogramData, ColorType, CrosshairMode } from 'lightweight-charts';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import type { Interval } from '@/types/market';

// Range presets: each maps to a default interval + time window
type RangePreset = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL';

const RANGE_CONFIG: { label: string; value: RangePreset; interval: Interval; seconds: number }[] = [
  { label: '1D',  value: '1D',  interval: '5min', seconds: 1 * 24 * 60 * 60 },
  { label: '1W',  value: '1W',  interval: '15min', seconds: 7 * 24 * 60 * 60 },
  { label: '1M',  value: '1M',  interval: '1D', seconds: 30 * 24 * 60 * 60 },
  { label: '3M',  value: '3M',  interval: '1D', seconds: 90 * 24 * 60 * 60 },
  { label: '1Y',  value: '1Y',  interval: '1D', seconds: 365 * 24 * 60 * 60 },
  { label: 'ALL', value: 'ALL', interval: '1D', seconds: 0 }, // 0 = fitContent
];

const INTERVALS: { label: string; value: Interval }[] = [
  { label: '1m', value: '1min' },
  { label: '5m', value: '5min' },
  { label: '15m', value: '15min' },
  { label: '1D', value: '1D' },
  { label: '1W', value: '1W' },
  { label: '1M', value: '1M' },
];

export default function PriceChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const historyRef = useRef(useDashboardStore.getState().history);
  const visibleRangeRef = useRef<{ from: number; to: number } | null>(null);

  const { history, interval, setInterval, loading, symbol, multiGEX } = useDashboardStore();
  const [activeRange, setActiveRange] = useState<RangePreset>('1Y');

  // Keep historyRef in sync for use in autoscaleInfoProvider + visibility handler
  useEffect(() => { historyRef.current = history; }, [history]);

  // Initialize chart (runs once)
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#12121a' },
        textColor: '#8888a0',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1a1a2508' },
        horzLines: { color: '#1a1a2508' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#00d4ff30', width: 1, style: 2 },
        horzLine: { color: '#00d4ff30', width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: '#2a2a3d',
        scaleMargins: { top: 0.08, bottom: 0.22 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#2a2a3d',
        timeVisible: true,
        secondsVisible: false,
        // NOTE: fixRightEdge removed — it caused edge-case auto-scale issues
        // when the chart was scrolled to the latest bar. Instead, applyRangeZoom
        // positions the view correctly on load.
      },
      handleScroll: { vertTouchDrag: false },
    });

    chartRef.current = chart;

    // Single subscription for both: (1) tracking visible range for autoscaleInfoProvider,
    // and (2) hiding price line labels when they're far from visible candle data
    chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
      if (!logicalRange) return;

      // (1) Store range for autoscaleInfoProvider
      visibleRangeRef.current = { from: logicalRange.from, to: logicalRange.to };

      // (2) Update price line visibility for visual cleanliness
      if (priceLinesRef.current.length === 0) return;
      const data = historyRef.current;
      if (!data.length) return;

      const from = Math.max(0, Math.floor(logicalRange.from));
      const to = Math.min(data.length - 1, Math.ceil(logicalRange.to));
      if (from > to) return;

      let minP = Infinity, maxP = -Infinity;
      for (let i = from; i <= to; i++) {
        if (data[i]) {
          minP = Math.min(minP, data[i].low);
          maxP = Math.max(maxP, data[i].high);
        }
      }
      if (minP === Infinity) return;

      const priceRange = maxP - minP;
      const pad = Math.max(priceRange * 0.6, (maxP + minP) * 0.005);

      for (const line of priceLinesRef.current) {
        const price = line.options().price;
        const inRange = price >= minP - pad && price <= maxP + pad;
        line.applyOptions({ lineVisible: inRange, axisLabelVisible: inRange });
      }
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00e676',
      downColor: '#ff3d57',
      borderUpColor: '#00e676',
      borderDownColor: '#ff3d57',
      wickUpColor: '#00e67688',
      wickDownColor: '#ff3d5788',
      // CRITICAL FIX: Override auto-scale to compute y-axis range from candle
      // data ONLY. Without this, price lines (gamma flip, call/put walls)
      // participate in auto-scale and stretch the y-axis to include their
      // prices, compressing the actual candle data into a tiny band.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autoscaleInfoProvider: (original: any) => {
        const data = historyRef.current;
        const vr = visibleRangeRef.current;

        // Before we have data + visible range, use library default
        if (!data.length || !vr) return original();

        const from = Math.max(0, Math.floor(vr.from));
        const to = Math.min(data.length - 1, Math.ceil(vr.to));
        if (from > to) return original();

        let minP = Infinity, maxP = -Infinity;
        for (let i = from; i <= to; i++) {
          if (data[i]) {
            minP = Math.min(minP, data[i].low);
            maxP = Math.max(maxP, data[i].high);
          }
        }

        if (minP === Infinity) return original();

        return {
          priceRange: { minValue: minP, maxValue: maxP },
        };
      },
    });

    // Volume on a named overlay scale — keeps volume values completely
    // separate from the right price scale (prevents any cross-contamination)
    const volumeSeries = chart.addHistogramSeries({
      color: '#00d4ff15',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume_overlay',
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      priceLinesRef.current = [];
    };
  }, []);

  // Update candle/volume data when history changes
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || !history.length) return;

    const candles: CandlestickData[] = history.map((bar) => ({
      time: bar.time as unknown as CandlestickData['time'],
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));

    const volumes: HistogramData[] = history.map((bar) => ({
      time: bar.time as unknown as HistogramData['time'],
      value: bar.volume,
      color: bar.close >= bar.open ? '#00e67618' : '#ff3d5718',
    }));

    candleSeriesRef.current.setData(candles);
    volumeSeriesRef.current.setData(volumes);

    applyRangeZoom(activeRange);
  }, [history]);

  // GEX + Max Pain price lines — clean up before re-adding
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* already removed */ }
    }
    priceLinesRef.current = [];

    if (!multiGEX?.aggregated || !history.length) return;

    const agg = multiGEX.aggregated;

    if (agg.gammaFlip) {
      priceLinesRef.current.push(series.createPriceLine({
        price: agg.gammaFlip,
        color: '#ffaa00',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'γ Flip',
      }));
    }
    if (agg.callWall) {
      priceLinesRef.current.push(series.createPriceLine({
        price: agg.callWall,
        color: '#00e676',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Call Wall',
      }));
    }
    if (agg.putWall) {
      priceLinesRef.current.push(series.createPriceLine({
        price: agg.putWall,
        color: '#ff3d57',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Put Wall',
      }));
    }
    // Max pain — dotted cyan line for expiration gravity reference
    if (multiGEX.maxPain?.strike) {
      priceLinesRef.current.push(series.createPriceLine({
        price: multiGEX.maxPain.strike,
        color: '#00d4ff80',
        lineWidth: 1,
        lineStyle: 3,
        axisLabelVisible: true,
        title: 'Max Pain',
      }));
    }
  }, [multiGEX, history.length]);

  useEffect(() => {
    if (history.length > 0) {
      applyRangeZoom(activeRange);
    }
  }, [activeRange]);

  const applyRangeZoom = useCallback((range: RangePreset) => {
    if (!chartRef.current || !history.length) return;

    const config = RANGE_CONFIG.find(r => r.value === range);
    if (!config || config.seconds === 0) {
      chartRef.current.timeScale().fitContent();
      return;
    }

    const lastBar = history[history.length - 1];
    const fromTimestamp = lastBar.time - config.seconds;
    const fromIdx = history.findIndex(b => b.time >= fromTimestamp);
    if (fromIdx < 0) {
      chartRef.current.timeScale().fitContent();
      return;
    }

    const fromBar = history[Math.max(0, fromIdx - 2)];
    chartRef.current.timeScale().setVisibleRange({
      from: fromBar.time as unknown as CandlestickData['time'],
      to: lastBar.time as unknown as CandlestickData['time'],
    });
  }, [history]);

  const handleRangeChange = useCallback((range: RangePreset) => {
    const config = RANGE_CONFIG.find(r => r.value === range);
    if (!config) return;
    setActiveRange(range);
    if (config.interval !== interval) {
      setInterval(config.interval);
    }
  }, [interval, setInterval]);

  const handleIntervalChange = useCallback((newInterval: Interval) => {
    setInterval(newInterval);
  }, [setInterval]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header flex-wrap gap-2">
        <span className="panel-title">
          {symbol} Price Chart
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0.5 bg-bg-tertiary rounded-md p-0.5">
            {RANGE_CONFIG.map((r) => (
              <button
                key={r.value}
                onClick={() => handleRangeChange(r.value)}
                className={`px-2 py-1 rounded text-xs font-mono transition-all ${
                  activeRange === r.value
                    ? 'bg-accent-cyan/20 text-accent-cyan'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 border-l border-border/30 pl-3">
            <span className="text-[10px] font-mono text-text-muted/60 mr-1">INT</span>
            {INTERVALS.map((int) => (
              <button
                key={int.value}
                onClick={() => handleIntervalChange(int.value)}
                className={`px-1.5 py-1 rounded text-[11px] font-mono transition-all ${
                  interval === int.value
                    ? 'bg-purple-500/20 text-purple-300'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {int.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1 relative min-h-[300px]">
        {loading.history && (
          <div className="absolute inset-0 bg-bg-secondary/80 flex items-center justify-center z-10">
            <div className="flex items-center gap-2 text-text-muted text-sm font-mono">
              <div className="w-4 h-4 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
              Loading...
            </div>
          </div>
        )}
        <div ref={chartContainerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
