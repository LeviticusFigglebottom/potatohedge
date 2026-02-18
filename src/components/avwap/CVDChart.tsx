'use client';

import { useEffect, useRef } from 'react';
import { createChart, type IChartApi } from 'lightweight-charts';
import type { Bar } from '@/lib/avwap';

interface Props {
  bars: Bar[];
  cvd: number[];
}

export default function CVDChart({ bars, cvd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    chartRef.current = createChart(containerRef.current, {
      layout: { background: { color: '#0d1117' }, textColor: '#9ca3af' },
      grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
      width: containerRef.current.clientWidth,
      height: 160,
      rightPriceScale: { borderColor: '#374151' },
      timeScale: { borderColor: '#374151', timeVisible: true },
    });

    const el = containerRef.current;
    const resizeObserver = new ResizeObserver(() => {
      chartRef.current?.applyOptions({ width: el?.clientWidth ?? 0 });
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !bars?.length || !cvd?.length) return;

    // Remove existing series by recreating chart content
    // LWC doesn't have a clean removeAllSeries — we track and remove
    const chart = chartRef.current;

    const cvdData = bars.map((bar, i) => ({
      time: Math.floor(bar.t / 1000) as unknown as import('lightweight-charts').UTCTimestamp,
      value: cvd[i],
      color: cvd[i] >= (cvd[i - 1] ?? cvd[i]) ? '#22c55e' : '#ef4444',
    }));

    const series = chart.addHistogramSeries({
      color: '#2196F3',
      priceFormat: { type: 'volume' },
      title: 'CVD (approx)',
    });
    series.setData(cvdData);
    chart.timeScale().fitContent();

    return () => {
      try {
        chart.removeSeries(series);
      } catch {
        // Chart may already be disposed
      }
    };
  }, [bars, cvd]);

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-2 border-b border-border">
        <span className="text-xs text-text-muted">
          Cumulative Volume Delta (bar approximation &mdash; rising = net buying pressure)
        </span>
      </div>
      <div ref={containerRef} />
    </div>
  );
}
