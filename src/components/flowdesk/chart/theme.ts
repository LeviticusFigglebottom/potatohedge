import { ColorType, CrosshairMode, createChart, type DeepPartial, type ChartOptions, type Time, type IChartApi } from 'lightweight-charts';
import { etOffsetMs } from '@/lib/flowdesk/time';

/** Colours reuse the dashboard's Tailwind accents (tailwind.config.ts). */
export const C = {
  bg: '#12121a',
  grid: '#1a1a25',
  border: '#2a2a3d',
  text: '#8888a0',
  muted: '#555570',
  cyan: '#00d4ff',
  amber: '#ffaa00',
  green: '#00e676',
  red: '#ff3d57',
  purple: '#b388ff',
  pink: '#ff6e9c',
};

export function deskChart(el: HTMLElement, opts: DeepPartial<ChartOptions> = {}): IChartApi {
  return createChart(el, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: C.border },
    leftPriceScale: { borderColor: C.border },
    timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false },
    ...opts,
  });
}

/**
 * lightweight-charts renders timestamps as UTC. Shift unix seconds so the axis
 * reads US/Eastern wall-clock time (exchange time).
 */
export function etTime(unixSec: number): Time {
  return (unixSec + Math.round(etOffsetMs(unixSec * 1000) / 1000)) as Time;
}

export function fmtUsd(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(digits)}K`;
  return `${s}$${a.toFixed(0)}`;
}

export function fmtNum(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(digits)}K`;
  return `${s}${a.toFixed(a < 10 && a % 1 ? 2 : 0)}`;
}
