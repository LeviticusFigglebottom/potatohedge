'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type CandlestickData, type HistogramData, ColorType, CrosshairMode } from 'lightweight-charts';
import { useDashboardStore, type MultiGEXData } from '@/hooks/useDashboardStore';
import type { Interval } from '@/types/market';

type RangePreset = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL';

const RANGE_CONFIG: { label: string; value: RangePreset; interval: Interval; seconds: number }[] = [
  { label: '1D',  value: '1D',  interval: '5min', seconds: 1 * 24 * 60 * 60 },
  { label: '1W',  value: '1W',  interval: '15min', seconds: 7 * 24 * 60 * 60 },
  { label: '1M',  value: '1M',  interval: '1D', seconds: 30 * 24 * 60 * 60 },
  { label: '3M',  value: '3M',  interval: '1D', seconds: 90 * 24 * 60 * 60 },
  { label: '1Y',  value: '1Y',  interval: '1D', seconds: 365 * 24 * 60 * 60 },
  { label: 'ALL', value: 'ALL', interval: '1D', seconds: 0 },
];

const INTERVALS: { label: string; value: Interval }[] = [
  { label: '1m', value: '1min' },
  { label: '5m', value: '5min' },
  { label: '15m', value: '15min' },
  { label: '1D', value: '1D' },
  { label: '1W', value: '1W' },
  { label: '1M', value: '1M' },
];

interface LevelOverlay {
  label: string;
  price: number;
  color: string;
  y: number;
}

export default function PriceChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const multiGEXRef = useRef<MultiGEXData | null>(null);
  const historyRef = useRef(useDashboardStore.getState().history);

  const { history, interval, setInterval, loading, symbol, multiGEX } = useDashboardStore();
  const [activeRange, setActiveRange] = useState<RangePreset>('1Y');
  const [levelOverlays, setLevelOverlays] = useState<LevelOverlay[]>([]);
  const [chartHeight, setChartHeight] = useState(400);

  // Keep refs in sync
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { multiGEXRef.current = multiGEX; }, [multiGEX]);

  // Compute GEX level overlay positions from series.priceToCoordinate
  // This is called from chart event handlers via refs (no stale closures)
  const updateLevelOverlays = useCallback(() => {
    const series = candleSeriesRef.current;
    const gex = multiGEXRef.current;
    if (!series || !gex?.aggregated) {
      setLevelOverlays([]);
      return;
    }

    const agg = gex.aggregated;
    const levels: { label: string; price: number; color: string }[] = [];

    if (agg.gammaFlip) levels.push({ label: 'γ Flip', price: agg.gammaFlip, color: '#ffaa00' });
    if (agg.callWall) levels.push({ label: 'Call Wall', price: agg.callWall, color: '#00e676' });
    if (agg.putWall) levels.push({ label: 'Put Wall', price: agg.putWall, color: '#ff3d57' });
    if (gex.maxPain?.strike) levels.push({ label: 'Max Pain', price: gex.maxPain.strike, color: '#00d4ff' });

    const positioned: LevelOverlay[] = [];
    for (const l of levels) {
      const y = series.priceToCoordinate(l.price);
      if (y !== null && y > 10 && y < chartHeight - 40) {
        positioned.push({ ...l, y });
      }
    }
    setLevelOverlays(positioned);
  }, [chartHeight]);

  // Initialize chart (runs once)
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const isIntraday = ['1min', '5min', '15min'].includes(interval);

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
        timeVisible: isIntraday,
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
    });

    chartRef.current = chart;

    // Update overlays when chart view changes (scroll / zoom)
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      requestAnimationFrame(() => {
        updateLevelOverlays();
      });
    });

    // Also update on crosshair move (catches y-axis rescaling from interaction)
    let rafPending = false;
    chart.subscribeCrosshairMove(() => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          updateLevelOverlays();
          rafPending = false;
        });
      }
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00e676',
      downColor: '#ff3d57',
      borderUpColor: '#00e676',
      borderDownColor: '#ff3d57',
      wickUpColor: '#00e67688',
      wickDownColor: '#ff3d5788',
    });

    // Volume on a dedicated overlay scale — completely separate from price axis
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
        setChartHeight(height);
      }
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
    };
  }, []);

  // Adapt timeVisible to interval changes (daily bars don't need HH:MM labels)
  useEffect(() => {
    if (!chartRef.current) return;
    const isIntraday = ['1min', '5min', '15min'].includes(interval);
    chartRef.current.applyOptions({
      timeScale: { timeVisible: isIntraday },
    });
  }, [interval]);

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

    // Update overlays after data settles
    requestAnimationFrame(() => updateLevelOverlays());
  }, [history]);

  // Update overlays when GEX levels change
  useEffect(() => {
    requestAnimationFrame(() => updateLevelOverlays());
  }, [multiGEX]);

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

        {/* GEX Level Overlays — rendered as HTML, zero interaction with chart auto-scale */}
        {levelOverlays.map((level) => (
          <div key={level.label} className="absolute left-0 pointer-events-none" style={{ top: level.y, right: 0 }}>
            <div
              className="absolute left-0 h-0"
              style={{
                right: 55,
                borderTop: `1px dashed ${level.color}`,
              }}
            />
            <div
              className="absolute text-[10px] font-mono px-1 rounded whitespace-nowrap"
              style={{
                right: 56,
                top: -9,
                color: level.color,
                backgroundColor: `${level.color}20`,
              }}
            >
              {level.label} ${level.price.toFixed(2)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
