'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, Activity, Zap, TrendingUp, AlertTriangle, Clock, DollarSign, Play, Loader2, CheckCircle2 } from 'lucide-react';
import InfoTip from './vol/InfoTip';

// ─── Types ──────────────────────────────────────────────────

interface SignalItem {
  strategy: string;
  fired: number;
  strength: number;
  trade_type: string;
  rationale: string;
  executed: number;
}

interface OpenPosition {
  id: number;
  strategy: string;
  symbol: string;
  trade_type: string;
  qty: number;
  entry_price: number;
  entry_cost: number;
  entry_date: string;
  strike: number;
  expiry: string;
  is_credit: number;
}

interface RecentTrade {
  date: string;
  strategy: string;
  action: string;
  symbol: string;
  qty: number;
  price: number;
  details: string;
}

interface EquityPoint {
  date: string;
  portfolio_value: number;
  cash: number;
  positions_value: number;
}

interface HistoryRow {
  date: string;
  spot: number;
  comp_volume: number | null;
  comp_greek: number | null;
  composite: number | null;
  iv_mean: number | null;
  put_skew: number | null;
  pcr_dollar: number | null;
  [key: string]: number | string | null | undefined;
}

interface EntropyData {
  status: 'no_db' | 'warmup' | 'active';
  warmup: { current: number; required: number };
  date: string | null;
  spot: number | null;
  metrics: Record<string, number | null> | null;
  medians: Record<string, number | null>;
  signals: { date: string; items: SignalItem[] };
  openPositions: OpenPosition[];
  recentTrades: RecentTrade[];
  equity: EquityPoint[];
  stats: { totalTrades: number; wins: number; winRate: number; totalPnl: number; openCount: number };
}

// ─── Helpers ────────────────────────────────────────────────

const fmt4 = (v: number | null | undefined) => v != null ? v.toFixed(4) : '—';
const fmtPct = (v: number | null | undefined) => v != null ? `${(v * 100).toFixed(1)}%` : '—';
const fmtRatio = (v: number | null | undefined) => v != null ? v.toFixed(3) : '—';
const fmtDollar = (v: number) => v >= 0 ? `$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;

function daysUntil(expiry: string): number {
  const now = new Date();
  const exp = new Date(expiry);
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

const GAUGE_INFO: Record<string, string> = {
  comp_volume: 'Volume-weighted entropy composite. Measures disorder in option volume distribution across strikes and expirations. Lower values indicate concentrated (directional) flow — a potential signal.',
  comp_greek: 'Greek-weighted entropy composite. Captures disorder in delta/gamma exposure across the chain. Low values suggest the market is pricing a specific move.',
  composite: 'Master composite combining volume and greek entropy with auxiliary metrics. The primary signal driver — values below the 21-day median indicate exploitable structure.',
};

const STRATEGY_LABELS: Record<string, string> = {
  S_LowVolEnt: 'Low Volume Entropy',
  S_VolCollapse: 'Volatility Collapse',
  S_LowEntLowIV: 'Low Entropy + Low IV',
  S_LowGreekEnt: 'Low Greek Entropy',
  S_SkewFlow: 'Skew Flow',
  S_PCRContrarian: 'PCR Contrarian',
};

const ACTION_COLORS: Record<string, string> = {
  OPEN: 'text-accent-cyan',
  CLOSE_TP: 'text-accent-green',
  CLOSE_SL: 'text-accent-red',
  CLOSE_DTE: 'text-accent-amber',
};

// ─── Market Hours Helper ────────────────────────────────────

function isMarketHours(): boolean {
  const now = new Date();
  // Convert to ET (approximate: UTC-5 or UTC-4 during DST)
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const month = now.getUTCMonth();
  // Rough DST: March-November
  const isDST = month >= 2 && month <= 10;
  const etH = utcH - (isDST ? 4 : 5);
  const etMin = etH * 60 + utcM;
  const day = now.getUTCDay();
  // Mon-Fri, 9:30am - 4:00pm ET
  return day >= 1 && day <= 5 && etMin >= 570 && etMin <= 960;
}

function todayET(): string {
  // Get today's date in ET
  const now = new Date();
  const month = now.getUTCMonth();
  const isDST = month >= 2 && month <= 10;
  const offset = isDST ? 4 : 5;
  const et = new Date(now.getTime() - offset * 60 * 60 * 1000);
  return et.toISOString().slice(0, 10);
}

// ─── Component ──────────────────────────────────────────────

export default function EntropyTab() {
  const [data, setData] = useState<EntropyData | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ status: string; message: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const warmupCanvasRef = useRef<HTMLCanvasElement>(null);
  const warmupContainerRef = useRef<HTMLDivElement>(null);
  const autoRunAttempted = useRef<string>('');

  const fetchData = useCallback(async () => {
    try {
      const [dashRes, histRes] = await Promise.all([
        fetch('/api/entropy?view=dashboard'),
        fetch('/api/entropy?view=history&days=60'),
      ]);
      if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status}`);
      const json = await dashRes.json();
      setData(json);
      if (histRes.ok) {
        const histJson = await histRes.json();
        setHistory(histJson.history || []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  const runEngine = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch('/api/entropy/run', { method: 'POST' });
      const json = await res.json();
      setRunResult({ status: json.status, message: json.message });
      // Refresh dashboard data after run
      await fetchData();
    } catch (err) {
      setRunResult({ status: 'error', message: err instanceof Error ? err.message : 'Run failed' });
    } finally {
      setRunning(false);
    }
  }, [running, fetchData]);

  // Auto-run: during market hours, if engine hasn't run today
  useEffect(() => {
    const checkAndRun = () => {
      const today = todayET();
      // Only auto-run once per day, and only during market hours
      if (autoRunAttempted.current === today) return;
      if (!isMarketHours()) return;

      // Check if data already has today's date
      if (data?.date === today) {
        autoRunAttempted.current = today;
        return;
      }

      autoRunAttempted.current = today;
      runEngine();
    };

    // Check on mount
    const timer = setTimeout(checkAndRun, 2000);
    // Re-check every 5 minutes
    const interval = setInterval(checkAndRun, 5 * 60_000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [data?.date, runEngine]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ─── Equity Chart ───────────────────────────────────────
  useEffect(() => {
    if (!data?.equity?.length || !canvasRef.current || !containerRef.current) return;

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

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 20, right: 50, bottom: 30, left: 60 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const equity = data.equity;
    if (equity.length < 2) return;

    const values = equity.map(e => e.portfolio_value);
    const minV = Math.min(...values) * 0.995;
    const maxV = Math.max(...values) * 1.005;
    const range = maxV - minV || 1;

    const toX = (i: number) => pad.left + (i / (equity.length - 1)) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minV) / range) * ch;

    // Grid lines
    ctx.strokeStyle = '#1a1a2520';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    // Area fill
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(values[0]));
    for (let i = 1; i < equity.length; i++) {
      ctx.lineTo(toX(i), toY(values[i]));
    }
    ctx.lineTo(toX(equity.length - 1), pad.top + ch);
    ctx.lineTo(toX(0), pad.top + ch);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    grad.addColorStop(0, '#00d4ff18');
    grad.addColorStop(1, '#00d4ff02');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(values[0]));
    for (let i = 1; i < equity.length; i++) {
      ctx.lineTo(toX(i), toY(values[i]));
    }
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Y axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = maxV - (range / 4) * i;
      ctx.fillText(`$${val.toFixed(0)}`, pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    // X axis dates
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, equity.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (equity.length - 1));
      const d = new Date(equity[idx].date);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(idx), h - pad.bottom + 14);
    }

    // Current value badge
    const lastVal = values[values.length - 1];
    const firstVal = values[0];
    const pnlPct = ((lastVal - firstVal) / firstVal) * 100;
    ctx.font = 'bold 10px "JetBrains Mono"';
    ctx.textAlign = 'right';
    ctx.fillStyle = pnlPct >= 0 ? '#00e676' : '#ff3d57';
    ctx.fillText(
      `$${lastVal.toFixed(0)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
      w - pad.right - 4,
      pad.top + 12,
    );
  }, [data?.equity]);

  // ─── Warmup / History Chart ──────────────────────────────
  useEffect(() => {
    if (!history.length || !warmupCanvasRef.current || !warmupContainerRef.current) return;

    const canvas = warmupCanvasRef.current;
    const container = warmupContainerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 24, right: 55, bottom: 32, left: 55 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const series: { key: string; color: string; label: string }[] = [
      { key: 'composite', color: '#b388ff', label: 'Composite' },
      { key: 'comp_volume', color: '#00d4ff', label: 'Volume' },
      { key: 'comp_greek', color: '#00e676', label: 'Greek' },
    ];

    // Collect all values for y-axis range
    let allVals: number[] = [];
    for (const s of series) {
      for (const row of history) {
        const v = row[s.key];
        if (v != null && typeof v === 'number') allVals.push(v);
      }
    }
    if (allVals.length === 0) return;

    const minV = Math.min(...allVals) * 0.98;
    const maxV = Math.max(...allVals) * 1.02;
    const range = maxV - minV || 0.01;

    const toX = (i: number) => pad.left + (history.length === 1 ? cw / 2 : (i / (history.length - 1)) * cw);
    const toY = (v: number) => pad.top + ch - ((v - minV) / range) * ch;

    // Grid lines
    ctx.strokeStyle = '#1a1a2520';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }

    // Y axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = maxV - (range / 4) * i;
      ctx.fillText(val.toFixed(3), pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    // X axis dates
    ctx.textAlign = 'center';
    if (history.length === 1) {
      const d = new Date(history[0].date);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(0), h - pad.bottom + 14);
    } else {
      const labelCount = Math.min(6, history.length);
      for (let i = 0; i < labelCount; i++) {
        const idx = Math.floor((i / (labelCount - 1)) * (history.length - 1));
        const d = new Date(history[idx].date);
        ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(idx), h - pad.bottom + 14);
      }
    }

    // Draw each series
    for (const s of series) {
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < history.length; i++) {
        const v = history[i][s.key];
        if (v != null && typeof v === 'number') {
          points.push({ x: toX(i), y: toY(v) });
        }
      }
      if (points.length === 0) continue;

      if (points.length === 1) {
        // Single point: draw a dot
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        // Line
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Dots at each data point
        for (const pt of points) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.fill();
        }
      }
    }

    // Legend
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'left';
    let lx = pad.left + 4;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, pad.top - 14, 10, 3);
      ctx.fillText(s.label, lx + 14, pad.top - 10);
      lx += ctx.measureText(s.label).width + 28;
    }
  }, [history]);

  // ─── September check ────────────────────────────────────
  const isSeptember = new Date().getMonth() === 8;

  // ─── Render ─────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div className="p-8 flex items-center justify-center">
        <span className="text-sm font-mono text-text-muted animate-pulse">Loading entropy engine...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-8 flex items-center justify-center">
        <span className="text-sm font-mono text-accent-red">Error: {error}</span>
      </div>
    );
  }

  if (!data) return null;

  // ─── Status banners ─────────────────────────────────────

  if (data.status === 'no_db') {
    return (
      <div className="p-8">
        <div className="panel p-6 flex flex-col items-center gap-4 text-center">
          <Brain className="w-8 h-8 text-text-muted" />
          <p className="text-sm font-mono text-text-secondary">
            Entropy engine has not been initialized yet.
          </p>
          <p className="text-xs font-mono text-text-muted max-w-md">
            Click below to run the engine for the first time. It will fetch the SPY options chain,
            compute Shannon entropy metrics, and begin building the 30-day warmup history.
          </p>
          <button
            onClick={runEngine}
            disabled={running}
            className="px-4 py-2 rounded-md bg-accent-purple/20 border border-accent-purple/30 text-accent-purple text-sm font-mono hover:bg-accent-purple/30 transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Initializing...' : 'Initialize Engine'}
          </button>
          {runResult && (
            <p className={`text-xs font-mono ${runResult.status === 'error' ? 'text-accent-red' : 'text-accent-green'}`}>
              {runResult.message}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Warmup state now falls through to the active dashboard below,
  // with a warmup banner at the top instead of blocking the view.

  // ─── Active dashboard (also used during warmup) ─────────

  const { metrics, medians, signals, openPositions, recentTrades, equity, stats } = data;
  const isWarmup = data.status === 'warmup';

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Warmup banner */}
      {isWarmup && (
        <div className="panel p-4 flex items-center gap-4">
          <Brain className="w-6 h-6 text-accent-amber shrink-0 animate-pulse" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-mono text-text-primary font-semibold">Warming Up</span>
              <span className="text-xs font-mono text-text-muted">
                {data.warmup.current}/{data.warmup.required} days
              </span>
            </div>
            <div className="w-full h-1.5 bg-bg-primary rounded-full overflow-hidden mb-1">
              <div
                className="h-full bg-accent-amber rounded-full transition-all"
                style={{ width: `${Math.round((data.warmup.current / data.warmup.required) * 100)}%` }}
              />
            </div>
            <p className="text-[10px] font-mono text-text-muted">
              Signals require {data.warmup.required} days for stable medians. Backfill is not possible — option chains are point-in-time snapshots. Below is the data collected so far.
            </p>
          </div>
          <button
            onClick={runEngine}
            disabled={running || data.date === todayET()}
            className="px-3 py-1.5 rounded-md bg-accent-amber/20 border border-accent-amber/30 text-accent-amber text-xs font-mono hover:bg-accent-amber/30 transition-all disabled:opacity-50 flex items-center gap-1.5 shrink-0"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {running ? 'Running...' : data.date === todayET() ? 'Ran today' : 'Run Now'}
          </button>
        </div>
      )}

      {/* September skip warning */}
      {isSeptember && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-md bg-accent-amber/10 border border-accent-amber/20">
          <AlertTriangle className="w-4 h-4 text-accent-amber shrink-0" />
          <span className="text-xs font-mono text-accent-amber">
            September — historically the worst month for equity markets. The entropy engine skips new entries this month.
          </span>
        </div>
      )}

      {/* Header row: date + spot + run controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-accent-purple" />
          <span className="text-sm font-mono text-text-primary font-semibold">Entropy Engine</span>
          {data.date && (
            <span className="text-xs font-mono text-text-muted">{data.date}</span>
          )}
          {data.date === todayET() && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-accent-green">
              <CheckCircle2 className="w-3 h-3" /> Today
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {data.spot != null && (
            <span className="text-xs font-mono text-text-secondary">
              SPY <span className="text-text-primary">${data.spot.toFixed(2)}</span>
            </span>
          )}
          <button
            onClick={runEngine}
            disabled={running || data.date === todayET()}
            title={data.date === todayET() ? 'Already ran today' : 'Run entropy engine now'}
            className="px-2.5 py-1 rounded-md bg-bg-tertiary border border-border/30 text-xs font-mono text-text-secondary hover:border-accent-purple/30 hover:text-accent-purple transition-all disabled:opacity-40 disabled:cursor-default flex items-center gap-1.5"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {running ? 'Running...' : 'Run'}
          </button>
          {runResult && !running && (
            <span className={`text-[10px] font-mono ${runResult.status === 'error' ? 'text-accent-red' : 'text-accent-green'}`}>
              {runResult.message.slice(0, 40)}
            </span>
          )}
        </div>
      </div>

      {/* Section 1: Entropy Gauges */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-accent-cyan" />
            <span className="panel-title">Entropy Composites</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 p-4">
          {(['comp_volume', 'comp_greek', 'composite'] as const).map((key) => {
            const current = metrics?.[key] ?? null;
            const median = medians?.[key] ?? null;
            const inSignal = current != null && median != null && current < median;
            const pctOfMedian = current != null && median != null && median > 0
              ? Math.min((current / median) * 100, 150)
              : 50;

            return (
              <div key={key} className="flex flex-col gap-2 p-3 rounded-md bg-bg-primary/50">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    {key.replace('comp_', '').replace('composite', 'master')}
                  </span>
                  <InfoTip text={GAUGE_INFO[key]} />
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-lg font-mono font-bold ${inSignal ? 'text-accent-green' : 'text-accent-red'}`}>
                    {fmt4(current)}
                  </span>
                  <span className="text-[10px] font-mono text-text-muted">
                    med {fmt4(median)}
                  </span>
                </div>
                {/* Bar indicator */}
                <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${inSignal ? 'bg-accent-green' : 'bg-accent-red'}`}
                    style={{ width: `${Math.max(5, Math.min(100, pctOfMedian))}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 2: Auxiliary Metrics */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-accent-amber" />
            <span className="panel-title">Auxiliary Metrics</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 p-4">
          {[
            { key: 'iv_mean', label: 'IV Mean', format: fmtPct, medFormat: fmtPct },
            { key: 'put_skew', label: 'Put Skew', format: (v: number | null | undefined) => v != null ? `${(v * 100).toFixed(1)}pp` : '—', medFormat: (v: number | null | undefined) => v != null ? `${(v * 100).toFixed(1)}pp` : '—' },
            { key: 'pcr_dollar', label: 'PCR Dollar', format: fmtRatio, medFormat: fmtRatio },
          ].map(({ key, label, format, medFormat }) => {
            const current = metrics?.[key] ?? null;
            const median = medians?.[key] ?? null;
            return (
              <div key={key} className="flex flex-col gap-1 p-3 rounded-md bg-bg-primary/50">
                <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{label}</span>
                <span className="text-sm font-mono font-bold text-text-primary">{format(current)}</span>
                <span className="text-[10px] font-mono text-text-muted">med {medFormat(median)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 2.5: Entropy History Chart (especially useful during warmup) */}
      {history.length >= 1 && (
        <div className="panel flex flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-accent-purple" />
              <span className="panel-title">Entropy History</span>
              <span className="text-[10px] font-mono text-text-muted">({history.length} day{history.length !== 1 ? 's' : ''})</span>
            </div>
          </div>
          <div ref={warmupContainerRef} className="flex-1 min-h-[280px]">
            <canvas ref={warmupCanvasRef} className="w-full h-full" />
          </div>
          {/* Raw metrics table */}
          <div className="overflow-x-auto border-t border-border/10">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="border-b border-border/20">
                  {['Date', 'SPY', 'Composite', 'Vol Ent', 'Greek Ent', 'IV Mean', 'Put Skew', 'PCR $'].map(h => (
                    <th key={h} className="px-2 py-1.5 text-left text-text-muted font-normal uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().slice(0, 15).map((row) => (
                  <tr key={row.date} className="border-b border-border/5 hover:bg-bg-primary/30">
                    <td className="px-2 py-1 text-text-muted">{row.date}</td>
                    <td className="px-2 py-1 text-text-primary">${row.spot?.toFixed(2) ?? '—'}</td>
                    <td className="px-2 py-1 text-accent-purple">{fmt4(row.composite)}</td>
                    <td className="px-2 py-1 text-accent-cyan">{fmt4(row.comp_volume)}</td>
                    <td className="px-2 py-1 text-accent-green">{fmt4(row.comp_greek)}</td>
                    <td className="px-2 py-1 text-text-secondary">{row.iv_mean != null ? fmtPct(row.iv_mean) : '—'}</td>
                    <td className="px-2 py-1 text-text-secondary">{row.put_skew != null ? `${(row.put_skew * 100).toFixed(1)}pp` : '—'}</td>
                    <td className="px-2 py-1 text-text-secondary">{fmtRatio(row.pcr_dollar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 3: Signal Status */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-accent-green" />
            <span className="panel-title">Signal Status</span>
          </div>
          {signals?.date && (
            <span className="text-[10px] font-mono text-text-muted">{signals.date}</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 p-4">
          {(['S_LowVolEnt', 'S_VolCollapse', 'S_LowEntLowIV', 'S_LowGreekEnt', 'S_SkewFlow', 'S_PCRContrarian'] as const).map((strat) => {
            const item = signals?.items?.find(s => s.strategy === strat);
            const fired = item?.fired === 1;
            const executed = item?.executed === 1;

            return (
              <div key={strat} className="flex items-center gap-3 p-2.5 rounded-md bg-bg-primary/50">
                {/* Status dot */}
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${fired ? 'bg-accent-green shadow-[0_0_6px_rgba(0,230,118,0.4)]' : 'bg-text-muted/20'}`} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-text-primary truncate">
                      {STRATEGY_LABELS[strat] || strat}
                    </span>
                    {executed && (
                      <span className="px-1.5 py-0.5 text-[8px] font-mono font-bold bg-accent-green/20 text-accent-green rounded uppercase tracking-wider">
                        Executed
                      </span>
                    )}
                  </div>
                  {item && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] font-mono text-accent-cyan">{item.trade_type}</span>
                      {/* Strength bar */}
                      <div className="flex-1 h-1 bg-bg-primary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accent-purple rounded-full"
                          style={{ width: `${Math.max(5, Math.min(100, item.strength * 100))}%` }}
                        />
                      </div>
                      <span className="text-[9px] font-mono text-text-muted">{(item.strength * 100).toFixed(0)}%</span>
                    </div>
                  )}
                  {item?.rationale && (
                    <p className="text-[9px] font-mono text-text-muted mt-0.5 truncate">{item.rationale}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 4: Open Positions */}
      {openPositions?.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title">Open Positions</span>
              <span className="text-[10px] font-mono text-text-muted">({openPositions.length})</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border/20">
                  {['Strategy', 'Symbol', 'Type', 'Qty', 'Strike', 'Expiry', 'Entry Price', 'Entry Cost', 'DTE'].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] text-text-muted font-normal uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openPositions.map((pos) => (
                  <tr key={pos.id} className="border-b border-border/10 hover:bg-bg-primary/30">
                    <td className="px-3 py-2 text-text-secondary">{pos.strategy}</td>
                    <td className="px-3 py-2 text-text-primary">{pos.symbol}</td>
                    <td className="px-3 py-2 text-text-secondary">{pos.trade_type}</td>
                    <td className={`px-3 py-2 ${pos.qty > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                      {pos.qty > 0 ? `+${pos.qty}` : pos.qty}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">${pos.strike.toFixed(2)}</td>
                    <td className="px-3 py-2 text-text-secondary">{pos.expiry}</td>
                    <td className="px-3 py-2 text-text-secondary">${pos.entry_price.toFixed(2)}</td>
                    <td className="px-3 py-2 text-text-secondary">{fmtDollar(pos.entry_cost)}</td>
                    <td className="px-3 py-2 text-text-secondary">{daysUntil(pos.expiry)}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 5: Equity Curve */}
      {equity?.length > 1 && (
        <div className="panel flex flex-col">
          <div className="panel-header">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title">Equity Curve</span>
            </div>
          </div>
          <div ref={containerRef} className="flex-1 min-h-[250px]">
            <canvas ref={canvasRef} className="w-full h-full" />
          </div>
        </div>
      )}

      {/* Section 6: Recent Trades */}
      {recentTrades?.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-accent-purple" />
              <span className="panel-title">Recent Trades</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border/20">
                  {['Date', 'Strategy', 'Action', 'Symbol', 'Qty', 'P&L'].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] text-text-muted font-normal uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentTrades.map((trade, i) => (
                  <tr key={i} className="border-b border-border/10 hover:bg-bg-primary/30">
                    <td className="px-3 py-2 text-text-muted">{trade.date}</td>
                    <td className="px-3 py-2 text-text-secondary">{trade.strategy}</td>
                    <td className={`px-3 py-2 font-semibold ${ACTION_COLORS[trade.action] || 'text-text-secondary'}`}>
                      {trade.action}
                    </td>
                    <td className="px-3 py-2 text-text-primary">{trade.symbol}</td>
                    <td className="px-3 py-2 text-text-secondary">{trade.qty}</td>
                    <td className="px-3 py-2 text-text-secondary">{trade.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 7: Stats Summary */}
      {stats && (
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-accent-green" />
              <span className="panel-title">Performance Summary</span>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4 p-4">
            <div className="flex flex-col gap-1 p-3 rounded-md bg-bg-primary/50">
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Total Trades</span>
              <span className="text-lg font-mono font-bold text-text-primary">{stats.totalTrades}</span>
            </div>
            <div className="flex flex-col gap-1 p-3 rounded-md bg-bg-primary/50">
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Win Rate</span>
              <span className={`text-lg font-mono font-bold ${stats.winRate >= 50 ? 'text-accent-green' : 'text-accent-red'}`}>
                {stats.winRate.toFixed(1)}%
              </span>
            </div>
            <div className="flex flex-col gap-1 p-3 rounded-md bg-bg-primary/50">
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Total P&L</span>
              <span className={`text-lg font-mono font-bold ${stats.totalPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {fmtDollar(stats.totalPnl)}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-3 rounded-md bg-bg-primary/50">
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Open Positions</span>
              <span className="text-lg font-mono font-bold text-accent-cyan">{stats.openCount}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
