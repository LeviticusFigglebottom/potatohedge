'use client';

import { useEffect, useRef, useCallback } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type CandlestickData, type HistogramData, ColorType, CrosshairMode } from 'lightweight-charts';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import type { Interval } from '@/types/market';

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

  const { history, interval, setInterval, loading, symbol, multiGEX } = useDashboardStore();

  // Initialize chart
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
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderColor: '#2a2a3d',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00e676',
      downColor: '#ff3d57',
      borderUpColor: '#00e676',
      borderDownColor: '#ff3d57',
      wickUpColor: '#00e67688',
      wickDownColor: '#ff3d5788',
    });

    const volumeSeries = chart.addHistogramSeries({
      color: '#00d4ff15',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Resize observer
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
    };
  }, []);

  // Update data
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

    // Add GEX levels as price lines
    if (multiGEX?.aggregated && candleSeriesRef.current) {
      const series = candleSeriesRef.current;
      
      if (multiGEX.aggregated.gammaFlip) {
        series.createPriceLine({
          price: multiGEX.aggregated.gammaFlip,
          color: '#ffaa00',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'γ Flip',
        });
      }
      if (multiGEX.aggregated.callWall) {
        series.createPriceLine({
          price: multiGEX.aggregated.callWall,
          color: '#00e676',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Call Wall',
        });
      }
      if (multiGEX.aggregated.putWall) {
        series.createPriceLine({
          price: multiGEX.aggregated.putWall,
          color: '#ff3d57',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Put Wall',
        });
      }
    }

    chartRef.current?.timeScale().fitContent();
  }, [history, multiGEX]);

  const handleIntervalChange = useCallback((newInterval: Interval) => {
    setInterval(newInterval);
  }, [setInterval]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="panel-title">
          {symbol} Price Chart
        </span>
        <div className="flex items-center gap-1">
          {INTERVALS.map((int) => (
            <button
              key={int.value}
              onClick={() => handleIntervalChange(int.value)}
              className={`px-2 py-1 rounded text-xs font-mono transition-all ${
                interval === int.value
                  ? 'bg-accent-cyan/20 text-accent-cyan'
                  : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
              }`}
            >
              {int.label}
            </button>
          ))}
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
