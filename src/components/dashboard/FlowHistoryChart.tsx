'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  loadFlowHistory,
  loadFlowHistoryWithSync,
  loadTickerFlowHistory,
  FLOW_METRICS,
  type DailyFlowRecord,
  type TickerFlowRecord,
} from '@/lib/flowHistory';

// ─── Format Helpers ──────────────────────────────────────────

function fmtCurrency(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtVal(n: number, format: string): string {
  switch (format) {
    case 'currency': return fmtCurrency(n);
    case 'ratio': return n.toFixed(2);
    case 'count': return n.toFixed(0);
    default: return fmtNum(n);
  }
}

// ─── Market-Wide Flow Chart ──────────────────────────────────

function MarketFlowChart() {
  const [metricIdx, setMetricIdx] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<DailyFlowRecord[]>([]);

  useEffect(() => {
    // Load localStorage immediately, then merge with server
    setHistory(loadFlowHistory());
    loadFlowHistoryWithSync().then(merged => {
      if (merged.length > 0) setHistory(merged);
    }).catch(() => {});
  }, []);

  const metric = FLOW_METRICS[metricIdx];

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || history.length < 2) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const pad = { top: 25, right: 60, bottom: 35, left: 70 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const values = history.map(r => (r as unknown as Record<string, number>)[metric.key] ?? 0);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range = maxVal - minVal || 1;

    const toX = (i: number) => pad.left + (i / (history.length - 1)) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minVal) / range) * ch;

    // Grid
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (ch / 5) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // Zero line for premium metrics
    if (metric.format === 'currency' && minVal < 0 && maxVal > 0) {
      const zy = toY(0);
      ctx.strokeStyle = '#ffffff15';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(pad.left, zy); ctx.lineTo(w - pad.right, zy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Area fill
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(values[0]));
    for (let i = 1; i < values.length; i++) {
      ctx.lineTo(toX(i), toY(values[i]));
    }
    ctx.lineTo(toX(values.length - 1), pad.top + ch);
    ctx.lineTo(toX(0), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = `${metric.color}10`;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(values[0]));
    for (let i = 1; i < values.length; i++) {
      ctx.lineTo(toX(i), toY(values[i]));
    }
    ctx.strokeStyle = metric.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Current value dot
    const last = values[values.length - 1];
    ctx.beginPath();
    ctx.arc(toX(values.length - 1), toY(last), 4, 0, 2 * Math.PI);
    ctx.fillStyle = metric.color;
    ctx.fill();

    // Y axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const val = minVal + (range / 5) * (5 - i);
      ctx.fillText(fmtVal(val, metric.format), pad.left - 5, pad.top + (ch / 5) * i + 3);
    }

    // X axis labels
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, history.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (history.length - 1));
      const d = new Date(history[idx].timestamp);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(idx), h - pad.bottom + 14);
    }

    // Current value label
    ctx.fillStyle = metric.color;
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'left';
    ctx.fillText(fmtVal(last, metric.format), w - pad.right + 4, toY(last) + 3);

    // 20-day MA
    if (values.length >= 20) {
      ctx.beginPath();
      let started = false;
      for (let i = 19; i < values.length; i++) {
        const ma = values.slice(i - 19, i + 1).reduce((s, v) => s + v, 0) / 20;
        if (!started) {
          ctx.moveTo(toX(i), toY(ma));
          started = true;
        } else {
          ctx.lineTo(toX(i), toY(ma));
        }
      }
      ctx.strokeStyle = '#ffaa0060';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Legend
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'left';
    ctx.fillStyle = metric.color;
    ctx.fillRect(pad.left, 10, 12, 2);
    ctx.fillText(metric.label, pad.left + 16, 14);
    if (values.length >= 20) {
      ctx.fillStyle = '#ffaa00';
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = '#ffaa00';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left + 180, 9); ctx.lineTo(pad.left + 192, 9); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('20d MA', pad.left + 196, 14);
    }

  }, [history, metricIdx, metric]);

  if (history.length < 2) {
    return (
      <div className="panel p-6 text-center">
        <div className="text-sm font-mono text-text-muted">Flow History</div>
        <div className="text-xs font-mono text-text-muted/60 mt-2">
          {history.length === 0
            ? 'No flow data recorded yet. Visit the Institutional tab during market hours to start recording.'
            : 'Need at least 2 days of data. Check back tomorrow!'}
        </div>
        <div className="text-[10px] font-mono text-text-muted/40 mt-1">
          Data accumulates automatically each time you view the Institutional tab.
        </div>
      </div>
    );
  }

  // Stats
  const latestVal = (history[history.length - 1] as unknown as Record<string, number>)[metric.key] ?? 0;
  const vals = history.map(r => (r as unknown as Record<string, number>)[metric.key] ?? 0);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">Flow History</span>
        <span className="badge badge-cyan">{history.length}d</span>
      </div>

      {/* Metric Selector */}
      <div className="px-4 pt-3 flex flex-wrap gap-1.5">
        {FLOW_METRICS.map((m, i) => (
          <button
            key={m.key}
            onClick={() => setMetricIdx(i)}
            className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
              i === metricIdx
                ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                : 'bg-bg-tertiary/30 text-text-muted hover:bg-bg-tertiary/60 border border-transparent'
            }`}
          >
            {m.shortLabel}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div ref={containerRef} className="flex-1 min-h-[260px] px-0">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2 px-4 pb-3">
        <div className="text-center">
          <div className="text-[9px] font-mono text-text-muted">Current</div>
          <div className="text-xs font-mono font-semibold" style={{ color: metric.color }}>{fmtVal(latestVal, metric.format)}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono text-text-muted">Average</div>
          <div className="text-xs font-mono font-semibold text-text-secondary">{fmtVal(avg, metric.format)}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono text-text-muted">Min</div>
          <div className="text-xs font-mono font-semibold text-text-muted">{fmtVal(minV, metric.format)}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-mono text-text-muted">Max</div>
          <div className="text-xs font-mono font-semibold text-text-muted">{fmtVal(maxV, metric.format)}</div>
        </div>
      </div>

      {/* Sentiment timeline */}
      <div className="border-t border-border/20 px-4 py-2">
        <div className="text-[9px] font-mono text-text-muted mb-1">Sentiment (last 14d)</div>
        <div className="flex gap-0.5">
          {history.slice(-14).map((r, i) => (
            <div
              key={i}
              className={`flex-1 h-2 rounded-sm ${
                r.sentiment === 'bullish' ? 'bg-green-500/60' :
                r.sentiment === 'bearish' ? 'bg-red-500/60' :
                'bg-gray-500/30'
              }`}
              title={`${r.date}: ${r.sentiment}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Per-Ticker Flow Chart ───────────────────────────────────

function TickerFlowChart({ ticker }: { ticker: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<TickerFlowRecord[]>([]);

  useEffect(() => {
    setHistory(loadTickerFlowHistory(ticker));
  }, [ticker]);

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || history.length < 2) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const pad = { top: 15, right: 50, bottom: 25, left: 60 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const values = history.map(r => r.netPremium);
    const minVal = Math.min(...values, 0);
    const maxVal = Math.max(...values, 0);
    const range = maxVal - minVal || 1;

    const toX = (i: number) => pad.left + (i / (history.length - 1)) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minVal) / range) * ch;

    // Zero line
    const zy = toY(0);
    ctx.strokeStyle = '#ffffff10';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zy); ctx.lineTo(w - pad.right, zy); ctx.stroke();

    // Bars (green above zero, red below)
    const barW = Math.max(2, (cw / history.length) * 0.7);
    for (let i = 0; i < values.length; i++) {
      const x = toX(i) - barW / 2;
      const y = toY(values[i]);
      const barH = Math.abs(zy - y);
      ctx.fillStyle = values[i] >= 0 ? '#00e67660' : '#ff3d5760';
      ctx.fillRect(x, Math.min(y, zy), barW, barH);
    }

    // Y axis
    ctx.fillStyle = '#555570';
    ctx.font = '8px "JetBrains Mono"';
    ctx.textAlign = 'right';
    [minVal, 0, maxVal].forEach(v => {
      ctx.fillText(fmtCurrency(v), pad.left - 4, toY(v) + 3);
    });

    // X axis dates
    ctx.textAlign = 'center';
    const labelCount = Math.min(4, history.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / Math.max(labelCount - 1, 1)) * (history.length - 1));
      const d = new Date(history[idx].timestamp);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(idx), h - pad.bottom + 12);
    }
  }, [history]);

  if (history.length < 2) return null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[10px] font-mono font-semibold text-text-secondary">{ticker}</span>
        <span className={`text-[10px] font-mono ${
          history[history.length - 1].netPremium >= 0 ? 'text-green-400' : 'text-red-400'
        }`}>
          {fmtCurrency(history[history.length - 1].netPremium)}
        </span>
      </div>
      <div ref={containerRef} className="h-[80px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}

// ─── Main Export ─────────────────────────────────────────────

const WATCHLIST_TICKERS = ['SPY', 'QQQ', 'IWM', 'NVDA', 'TSLA', 'AAPL', 'AMZN', 'META', 'MSFT', 'AMD'];

export default function FlowHistoryPanel() {
  const [showPerTicker, setShowPerTicker] = useState(false);
  const [tickerHistories, setTickerHistories] = useState<{ ticker: string; count: number }[]>([]);

  useEffect(() => {
    const histories = WATCHLIST_TICKERS.map(t => ({
      ticker: t,
      count: loadTickerFlowHistory(t).length,
    })).filter(h => h.count >= 2);
    setTickerHistories(histories);
  }, []);

  return (
    <div className="space-y-4">
      <MarketFlowChart />

      {tickerHistories.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <button
              onClick={() => setShowPerTicker(!showPerTicker)}
              className="panel-title flex items-center gap-2 cursor-pointer hover:text-text-primary transition-colors"
            >
              Per-Ticker Flow History
              <span className="text-[10px] text-text-muted">
                {showPerTicker ? '(collapse)' : '(expand)'}
              </span>
            </button>
            <span className="badge badge-purple">{tickerHistories.length} tickers</span>
          </div>

          {showPerTicker && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 p-2">
              {tickerHistories.map(({ ticker }) => (
                <TickerFlowChart key={ticker} ticker={ticker} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
