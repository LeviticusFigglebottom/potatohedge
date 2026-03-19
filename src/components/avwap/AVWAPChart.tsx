'use client';

import { useEffect, useRef } from 'react';
import { createChart, LineStyle, CrosshairMode, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { Bar } from '@/lib/avwap';
import type { ComputedAVWAPData } from './AVWAPTab';

const AVWAP_COLORS = ['#2196F3', '#FF9800', '#4CAF50', '#E91E63', '#9C27B0'];
const BAND1_ALPHA = '33';
const BAND2_ALPHA = '1A';

interface Props {
  bars: Bar[];
  computedData: ComputedAVWAPData | null;
  ticker: string;
}

export default function AVWAPChart({ bars, computedData, ticker }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<ISeriesApi<any>[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;

    chartRef.current = createChart(containerRef.current, {
      layout: {
        background: { color: '#0d1117' },
        textColor: '#9ca3af',
        fontSize: 12,
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#374151' },
      timeScale: {
        borderColor: '#374151',
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height: 480,
    });

    const resizeObserver = new ResizeObserver(() => {
      if (chartRef.current && containerRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
    };
  }, []);

  // Update data when bars or computedData change
  useEffect(() => {
    if (!chartRef.current || !bars?.length) return;

    // Remove all existing series
    seriesRef.current.forEach(s => {
      try {
        chartRef.current?.removeSeries(s);
      } catch {
        // Series may already be removed
      }
    });
    seriesRef.current = [];

    // Candlestick series
    const candleSeries = chartRef.current.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    candleSeries.setData(
      bars.map(bar => ({
        time: Math.floor(bar.t / 1000) as unknown as import('lightweight-charts').UTCTimestamp,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
      }))
    );
    seriesRef.current.push(candleSeries);

    // AVWAP lines + bands for each anchor
    if (computedData?.avwapSeries) {
      computedData.avwapSeries.forEach((s, i) => {
        if (!chartRef.current) return;
        const color = AVWAP_COLORS[i % AVWAP_COLORS.length];

        // AVWAP main line
        const avwapLine = chartRef.current.addLineSeries({
          color,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          title: `AVWAP ${s.anchor.label.slice(0, 20)}`,
          priceLineVisible: true,
          lastValueVisible: true,
        });
        const avwapData = bars
          .map((bar, idx) =>
            s.avwap[idx] !== null
              ? { time: Math.floor(bar.t / 1000) as unknown as import('lightweight-charts').UTCTimestamp, value: s.avwap[idx] as number }
              : null
          )
          .filter((d): d is NonNullable<typeof d> => d !== null);
        avwapLine.setData(avwapData);
        seriesRef.current.push(avwapLine);

        // Helper to add a band line
        const addBandLine = (
          bandData: (number | null)[],
          alpha: string,
          style: LineStyle
        ) => {
          if (!chartRef.current) return;
          const line = chartRef.current.addLineSeries({
            color: `${color}${alpha}`,
            lineWidth: 1,
            lineStyle: style,
            title: '',
            priceLineVisible: false,
            lastValueVisible: false,
          });
          const data = bars
            .map((bar, idx) =>
              bandData[idx] !== null
                ? { time: Math.floor(bar.t / 1000) as unknown as import('lightweight-charts').UTCTimestamp, value: bandData[idx] as number }
                : null
            )
            .filter((d): d is NonNullable<typeof d> => d !== null);
          line.setData(data);
          seriesRef.current.push(line);
        };

        addBandLine(s.bands1.upper, BAND1_ALPHA, LineStyle.Dashed);
        addBandLine(s.bands1.lower, BAND1_ALPHA, LineStyle.Dashed);
        addBandLine(s.bands2.upper, BAND2_ALPHA, LineStyle.Dotted);
        addBandLine(s.bands2.lower, BAND2_ALPHA, LineStyle.Dotted);
      });
    }

    chartRef.current.timeScale().fitContent();
  }, [bars, computedData]);

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <div className="px-4 py-2 border-b border-border flex items-center gap-3 flex-wrap">
        <span className="font-mono font-bold text-text-primary">{ticker}</span>
        <span className="text-text-muted text-xs">AVWAP Overlay</span>
        {computedData?.avwapSeries.map((s, i) => (
          <span
            key={s.anchor.date}
            className="flex items-center gap-1 text-xs"
            style={{ color: AVWAP_COLORS[i % AVWAP_COLORS.length] }}
          >
            <span
              className="w-3 h-0.5 inline-block"
              style={{ background: AVWAP_COLORS[i % AVWAP_COLORS.length] }}
            />
            {s.anchor.label.slice(0, 18)}
          </span>
        ))}
      </div>
      <div ref={containerRef} />
    </div>
  );
}
