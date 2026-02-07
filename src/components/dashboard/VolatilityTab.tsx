'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber } from '@/lib/utils/format';
import { Thermometer, TrendingUp, Activity, BarChart3, ChevronRight, Brain } from 'lucide-react';

// ─── IV Rank Gauge ─────────────────────────────────────────

function IVGauge() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { snapshot } = useDashboardStore();
  const iv = snapshot?.iv;

  useEffect(() => {
    if (!canvasRef.current || !iv) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = 180;
    canvas.width = size * dpr;
    canvas.height = (size * 0.65) * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size * 0.65}px`;
    ctx.scale(dpr, dpr);

    const cx = size / 2, cy = size * 0.55;
    const r = size * 0.38;
    const startAngle = Math.PI;
    const endAngle = 2 * Math.PI;

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#1a1a25';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Gradient arc for value
    const valueAngle = startAngle + (iv.ivRank / 100) * Math.PI;
    const gradient = ctx.createLinearGradient(0, cy, size, cy);
    gradient.addColorStop(0, '#00e676');
    gradient.addColorStop(0.5, '#ffaa00');
    gradient.addColorStop(1, '#ff3d57');

    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, valueAngle);
    ctx.lineWidth = 14;
    ctx.strokeStyle = gradient;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Needle
    const needleAngle = startAngle + (iv.ivRank / 100) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(needleAngle) * (r - 20), cy + Math.sin(needleAngle) * (r - 20));
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e8e8ef';
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#e8e8ef';
    ctx.fill();

    // Labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'center';
    ctx.fillText('0', cx - r - 2, cy + 14);
    ctx.fillText('100', cx + r + 2, cy + 14);
    ctx.fillText('50', cx, cy - r + 6);

  }, [snapshot]);

  if (!iv) return null;

  const rankColor = iv.ivRank > 70 ? 'text-accent-red' : iv.ivRank < 30 ? 'text-accent-green' : 'text-accent-amber';

  return (
    <div className="panel p-4 flex flex-col items-center">
      <span className="panel-title mb-2">IV Rank</span>
      <canvas ref={canvasRef} />
      <div className={`text-3xl font-mono font-bold mt-1 ${rankColor}`}>{iv.ivRank}</div>
      <div className="text-xs font-mono text-text-muted mt-1">
        Percentile: {iv.ivPercentile}%
      </div>
    </div>
  );
}

// ─── IV Stats ──────────────────────────────────────────────

function IVStats() {
  const { snapshot } = useDashboardStore();
  const iv = snapshot?.iv;
  const hv = snapshot?.historicalVol;
  if (!iv) return null;

  const stats = [
    { label: 'Current IV', value: `${(iv.currentIV * 100).toFixed(1)}%`, color: 'text-text-primary' },
    { label: '30d MA', value: `${(iv.iv30dMA * 100).toFixed(1)}%`, color: iv.currentIV > iv.iv30dMA ? 'text-accent-red' : 'text-accent-green' },
    { label: '52w High', value: `${(iv.iv52wHigh * 100).toFixed(1)}%`, color: 'text-accent-red' },
    { label: '52w Low', value: `${(iv.iv52wLow * 100).toFixed(1)}%`, color: 'text-accent-green' },
    { label: 'HV 20d', value: hv ? `${(hv.hv20 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary' },
    { label: 'HV 60d', value: hv ? `${(hv.hv60 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary' },
    { label: 'IV/HV Ratio', value: iv.ivHvRatio.toFixed(2), color: iv.ivHvRatio > 1.3 ? 'text-accent-red' : iv.ivHvRatio < 0.8 ? 'text-accent-green' : 'text-text-primary' },
  ];

  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">IV Statistics</span></div>
      <div className="divide-y divide-border/30">
        {stats.map((s) => (
          <div key={s.label} className="px-4 py-2 flex justify-between items-center">
            <span className="text-xs font-mono text-text-muted">{s.label}</span>
            <span className={`text-sm font-mono font-medium ${s.color}`}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Term Structure Chart ──────────────────────────────────

function TermStructureChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !snapshot?.termStructure?.length) return;
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
    const pad = { top: 20, right: 50, bottom: 35, left: 50 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const data = snapshot.termStructure.filter(d => d.dte > 0 && d.dte <= 180 && d.atmIV > 0);
    if (data.length < 2) return;

    const minDTE = 0;
    const maxDTE = Math.max(...data.map(d => d.dte));
    const minIV = Math.min(...data.map(d => d.atmIV)) * 0.9;
    const maxIV = Math.max(...data.map(d => d.atmIV)) * 1.1;

    const toX = (dte: number) => pad.left + ((dte - minDTE) / (maxDTE - minDTE)) * cw;
    const toY = (iv: number) => pad.top + ch - ((iv - minIV) / (maxIV - minIV)) * ch;

    // Grid
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // Line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].dte), toY(data[0].atmIV));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].dte), toY(data[i].atmIV));
    }
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill under
    ctx.lineTo(toX(data[data.length - 1].dte), pad.top + ch);
    ctx.lineTo(toX(data[0].dte), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = '#b388ff10';
    ctx.fill();

    // Points
    data.forEach(d => {
      const x = toX(d.dte), y = toY(d.atmIV);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fillStyle = '#b388ff';
      ctx.fill();
    });

    // Labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    data.forEach(d => {
      ctx.textAlign = 'center';
      ctx.fillText(`${d.dte}d`, toX(d.dte), h - pad.bottom + 14);
    });

    // Y axis
    for (let i = 0; i <= 4; i++) {
      const iv = minIV + ((maxIV - minIV) / 4) * (4 - i);
      ctx.textAlign = 'right';
      ctx.fillText(`${(iv * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

  }, [snapshot]);

  // Check contango/backwardation
  const ts = snapshot?.termStructure?.filter(d => d.dte > 0 && d.dte <= 180) ?? [];
  const isBackwardation = ts.length >= 2 && ts[0].atmIV > ts[ts.length - 1].atmIV;

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">IV Term Structure</span>
        {ts.length >= 2 && (
          <span className={`badge ${isBackwardation ? 'badge-red' : 'badge-green'}`}>
            {isBackwardation ? 'Backwardation' : 'Contango'}
          </span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-[200px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      {isBackwardation && (
        <div className="px-4 py-2 border-t border-border text-xs text-text-secondary font-mono">
          Near-term IV exceeds far-term — market pricing imminent risk (earnings, event, etc.)
        </div>
      )}
    </div>
  );
}

// ─── Skew Chart ────────────────────────────────────────────

function SkewChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !snapshot?.skewSurface?.length) return;
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
    const pad = { top: 20, right: 20, bottom: 35, left: 50 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const spot = snapshot.spotPrice;
    // Use nearest 3 expirations for skew curves
    const exps = snapshot.skewSurface.slice(0, 3);
    if (exps.length === 0) return;

    // Global ranges
    const allPoints = exps.flatMap(e => e.points);
    const minStrike = Math.min(...allPoints.map(p => p.strike));
    const maxStrike = Math.max(...allPoints.map(p => p.strike));
    const minIV = Math.min(...allPoints.map(p => p.iv)) * 0.9;
    const maxIV = Math.max(...allPoints.map(p => p.iv)) * 1.1;

    // Focus near ATM
    const focusMin = spot * 0.9, focusMax = spot * 1.1;

    const toX = (strike: number) => pad.left + ((strike - focusMin) / (focusMax - focusMin)) * cw;
    const toY = (iv: number) => pad.top + ch - ((iv - minIV) / (maxIV - minIV)) * ch;

    const colors = ['#00d4ff', '#b388ff', '#ffaa00'];

    exps.forEach((exp, ei) => {
      const pts = exp.points.filter(p => p.strike >= focusMin && p.strike <= focusMax);
      if (pts.length < 2) return;

      ctx.beginPath();
      ctx.moveTo(toX(pts[0].strike), toY(pts[0].iv));
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(toX(pts[i].strike), toY(pts[i].iv));
      }
      ctx.strokeStyle = colors[ei] || '#8888a0';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Spot vertical
    const sx = toX(spot);
    ctx.strokeStyle = '#e8e8ef20';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(sx, pad.top); ctx.lineTo(sx, h - pad.bottom); ctx.stroke();
    ctx.setLineDash([]);

    // Spot label
    ctx.fillStyle = '#8888a0';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'center';
    ctx.fillText('ATM', sx, h - pad.bottom + 12);

    // Y axis
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const iv = minIV + ((maxIV - minIV) / 4) * (4 - i);
      ctx.fillText(`${(iv * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    // Legend
    exps.forEach((exp, ei) => {
      ctx.fillStyle = colors[ei];
      ctx.font = '9px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`${exp.dte}d`, w - pad.right - 40, pad.top + 14 + ei * 14);
    });

  }, [snapshot]);

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">Volatility Skew</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[200px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}

// ─── IV Interpretation ─────────────────────────────────────

function IVInterpretation() {
  const { snapshot } = useDashboardStore();
  if (!snapshot?.iv?.interpretation) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-accent-purple" />
          Volatility Context
        </span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm text-text-secondary leading-relaxed">{snapshot.iv.interpretation}</p>
      </div>
    </div>
  );
}

// ─── Main Volatility Tab ───────────────────────────────────

export default function VolatilityTab() {
  const { snapshot, loading } = useDashboardStore();

  if (loading.snapshot && !snapshot) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="panel p-8 flex items-center justify-center">
          <div className="flex items-center gap-3 text-text-muted font-mono">
            <div className="w-5 h-5 border-2 border-accent-purple/30 border-t-accent-purple rounded-full animate-spin" />
            Loading Polygon options snapshot & computing IV analytics...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Top row: gauge + stats + term structure */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <IVGauge />
        <IVStats />
        <TermStructureChart />
      </div>

      {/* Interpretation */}
      <IVInterpretation />

      {/* Skew */}
      <SkewChart />

      {/* Snapshot info */}
      {snapshot && (
        <div className="text-xs font-mono text-text-muted text-center py-2">
          Polygon snapshot: {snapshot.snapshotCount} contracts analyzed
        </div>
      )}
    </div>
  );
}
