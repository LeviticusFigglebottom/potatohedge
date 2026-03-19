'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import InfoTip from './InfoTip';

// ─── Enhanced IV Stats ─────────────────────────────────────

export function IVStats() {
  const { snapshot } = useDashboardStore();
  const iv = snapshot?.iv;
  const hv = snapshot?.historicalVol;
  if (!iv) return null;

  const vrp = hv ? (iv.currentIV - hv.hv20) * 100 : 0;

  const stats: { label: string; value: string; color: string; tip?: string }[] = [
    { label: 'Current IV', value: `${(iv.currentIV * 100).toFixed(1)}%`, color: 'text-text-primary',
      tip: 'Current implied volatility from nearest ATM options. Reflects the market\'s expected annualized move.' },
    { label: 'IV Rank', value: `${iv.ivRank}`, color: iv.ivRank > 70 ? 'text-accent-red' : iv.ivRank < 30 ? 'text-accent-green' : 'text-accent-amber',
      tip: 'Where current IV sits in its 52-week range: 0 = at the low, 100 = at the high. Above 70 = rich (sell), below 30 = cheap (buy).' },
    { label: 'IV Pctile', value: `${iv.ivPercentile}%`, color: iv.ivPercentile > 70 ? 'text-accent-red' : iv.ivPercentile < 30 ? 'text-accent-green' : 'text-text-secondary',
      tip: 'Percentage of days over the past year when IV was LOWER than today. More robust than IV Rank for skewed distributions.' },
    { label: 'IV/HV', value: iv.ivHvRatio.toFixed(2), color: iv.ivHvRatio > 1.3 ? 'text-accent-red' : iv.ivHvRatio < 0.8 ? 'text-accent-green' : 'text-text-primary',
      tip: 'Implied / Historical vol ratio. >1.3 = IV overestimates realized risk (sell edge). <0.8 = IV underestimates (buy edge). This IS the Volatility Risk Premium.' },
    { label: 'VRP', value: `${vrp > 0 ? '+' : ''}${vrp.toFixed(1)}pp`, color: vrp > 3 ? 'text-accent-green' : vrp < -3 ? 'text-accent-red' : 'text-text-secondary',
      tip: 'Volatility Risk Premium = IV − HV20. Positive = sellers\' edge, negative = options may be underpriced.' },
    { label: 'HV 10d', value: hv ? `${(hv.hv10 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary',
      tip: '10-day realized volatility — captures recent short-term moves. Compare to IV to gauge very near-term mispricing.' },
    { label: 'HV 20d', value: hv ? `${(hv.hv20 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary',
      tip: '20-day realized volatility — the standard window. The benchmark for comparing against implied vol.' },
    { label: 'HV 30d', value: hv ? `${(hv.hv30 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary',
      tip: '30-day realized volatility — aligns with monthly option cycles. Good for comparing against 30-DTE IV.' },
    { label: 'HV 60d', value: hv ? `${(hv.hv60 * 100).toFixed(1)}%` : '—', color: 'text-text-secondary',
      tip: '60-day realized volatility — longer-term trend. Smooths out short-term noise.' },
    { label: '52w High', value: `${(iv.iv52wHigh * 100).toFixed(1)}%`, color: 'text-accent-red' },
    { label: '52w Low', value: `${(iv.iv52wLow * 100).toFixed(1)}%`, color: 'text-accent-green' },
    { label: '30d MA', value: `${(iv.iv30dMA * 100).toFixed(1)}%`, color: iv.currentIV > iv.iv30dMA ? 'text-accent-red' : 'text-accent-green',
      tip: '30-day moving average of IV. IV above this = rising vol trend. Below = falling vol trend.' },
  ];

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <span className="panel-title">IV / HV Statistics</span>
          <InfoTip text="Key volatility metrics for edge identification. The IV/HV ratio and VRP are the primary signals: when IV significantly exceeds realized vol, selling premium has a statistical edge. When IV is below realized, buying premium may be warranted (Sinclair, Positional Options Trading Ch. 3-4)." />
        </div>
      </div>
      <div className="divide-y divide-border/20">
        {stats.map((s) => (
          <div key={s.label} className="px-4 py-1.5 flex justify-between items-center">
            <span className="text-[10px] font-mono text-text-muted flex items-center gap-0.5">
              {s.label}
              {s.tip && <InfoTip text={s.tip} />}
            </span>
            <span className={`text-sm font-mono font-medium ${s.color}`}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── IV Gauge ──────────────────────────────────────────────

export function IVGauge() {
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

    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, 2 * Math.PI);
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#1a1a25';
    ctx.lineCap = 'round';
    ctx.stroke();

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

    const needleAngle = startAngle + (iv.ivRank / 100) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(needleAngle) * (r - 20), cy + Math.sin(needleAngle) * (r - 20));
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e8e8ef';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#e8e8ef';
    ctx.fill();

    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'center';
    ctx.fillText('0', cx - r - 2, cy + 14);
    ctx.fillText('100', cx + r + 2, cy + 14);
    ctx.fillText('50', cx, cy - r + 6);
  }, [snapshot, iv]);

  if (!iv) return null;

  const rankColor = iv.ivRank > 70 ? 'text-accent-red' : iv.ivRank < 30 ? 'text-accent-green' : 'text-accent-amber';

  return (
    <div className="panel p-4 flex flex-col items-center">
      <div className="flex items-center gap-1">
        <span className="panel-title mb-0">IV Rank</span>
        <InfoTip text="IV Rank measures where current implied volatility sits within its 52-week high-low range. 0 = at the yearly low, 100 = at the yearly high. Above 50 favors selling, below 50 favors buying. Above 80 or below 20 = strong signal." />
      </div>
      <canvas ref={canvasRef} className="mt-2" />
      <div className={`text-3xl font-mono font-bold mt-1 ${rankColor}`}>{iv.ivRank}</div>
      <div className="text-xs font-mono text-text-muted mt-1">
        Percentile: {iv.ivPercentile}%
      </div>
    </div>
  );
}

// ─── Enhanced Term Structure ───────────────────────────────

export function TermStructureChart() {
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

    const maxDTE = Math.max(...data.map(d => d.dte));
    const vixDecimal = snapshot.vix ? snapshot.vix.price / 100 : 0;
    const ivValues = data.map(d => d.atmIV);
    if (vixDecimal > 0) ivValues.push(vixDecimal);
    const minIV = Math.min(...ivValues) * 0.9;
    const maxIV = Math.max(...ivValues) * 1.1;

    const toX = (dte: number) => pad.left + (dte / maxDTE) * cw;
    const toY = (iv: number) => pad.top + ch - ((iv - minIV) / (maxIV - minIV)) * ch;

    // Grid
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // VIX reference
    if (vixDecimal > 0 && vixDecimal >= minIV && vixDecimal <= maxIV) {
      const vy = toY(vixDecimal);
      ctx.strokeStyle = '#ff3d5740';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, vy); ctx.lineTo(w - pad.right, vy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff3d57';
      ctx.font = '8px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`VIX ${snapshot.vix!.price.toFixed(0)}`, w - pad.right + 4, vy + 3);
    }

    // Term structure line + fill
    ctx.beginPath();
    ctx.moveTo(toX(data[0].dte), toY(data[0].atmIV));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].dte), toY(data[i].atmIV));
    }
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.lineTo(toX(data[data.length - 1].dte), pad.top + ch);
    ctx.lineTo(toX(data[0].dte), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = '#b388ff10';
    ctx.fill();

    // Points
    data.forEach(d => {
      ctx.beginPath();
      ctx.arc(toX(d.dte), toY(d.atmIV), 3.5, 0, 2 * Math.PI);
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
    for (let i = 0; i <= 4; i++) {
      const iv = minIV + ((maxIV - minIV) / 4) * (4 - i);
      ctx.textAlign = 'right';
      ctx.fillText(`${(iv * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 4) * i + 3);
    }
  }, [snapshot]);

  const ts = snapshot?.termStructure?.filter(d => d.dte > 0 && d.dte <= 180) ?? [];
  const isBackwardation = ts.length >= 2 && ts[0].atmIV > ts[ts.length - 1].atmIV;

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <span className="panel-title">IV Term Structure</span>
          <InfoTip text="The IV term structure plots ATM implied volatility across expirations. Normal 'contango' (upward slope) means far-dated options are more expensive — typical equilibrium. 'Backwardation' (inverted) means near-term IV exceeds long-term — signals imminent event risk (earnings, FDA, etc.). Calendar spreads exploit term structure steepness: sell near-term high IV, buy far-term lower IV (Sinclair, Ch. 7)." />
        </div>
        {ts.length >= 2 && (
          <span className={`badge ${isBackwardation ? 'badge-red' : 'badge-green'}`}>
            {isBackwardation ? 'Backwardation' : 'Contango'}
          </span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-[200px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      <div className="px-4 py-2 border-t border-border/20 text-[11px] font-mono text-text-secondary">
        {isBackwardation
          ? 'Inverted term structure — near-term IV exceeds far-term. Market pricing imminent event risk. Selling near-term premium is risky; calendar spreads (short near, long far) can exploit the inversion.'
          : ts.length >= 2
          ? 'Normal contango — far-dated IV exceeds near-term. Standard environment for diagonal and calendar spreads.'
          : 'Insufficient expirations for term structure analysis.'}
      </div>
    </div>
  );
}

// ─── Enhanced Skew Chart ──────────────────────────────────

export function SkewChart() {
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
    const exps = snapshot.skewSurface.slice(0, 3);
    if (exps.length === 0) return;

    const allPoints = exps.flatMap(e => e.points);
    if (allPoints.length === 0) return;
    const minIV = Math.min(...allPoints.map(p => p.iv)) * 0.9;
    const maxIV = Math.max(...allPoints.map(p => p.iv)) * 1.1;

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

    // ATM line
    const sx = toX(spot);
    ctx.strokeStyle = '#e8e8ef20';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(sx, pad.top); ctx.lineTo(sx, h - pad.bottom); ctx.stroke();
    ctx.setLineDash([]);

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

  // Compute 25-delta skew for the nearest expiration
  const skew25d = (() => {
    if (!snapshot?.skewSurface?.length) return null;
    const nearest = snapshot.skewSurface[0];
    const puts = nearest.points.filter(p => p.type === 'put' && p.delta < -0.15 && p.delta > -0.35);
    const calls = nearest.points.filter(p => p.type === 'call' && p.delta > 0.15 && p.delta < 0.35);
    if (puts.length === 0 || calls.length === 0) return null;
    const put25IV = puts.reduce((s, p) => s + p.iv, 0) / puts.length;
    const call25IV = calls.reduce((s, p) => s + p.iv, 0) / calls.length;
    return { put25IV, call25IV, skew: (put25IV - call25IV) * 100, dte: nearest.dte };
  })();

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <span className="panel-title">Volatility Skew</span>
          <InfoTip text="The skew curve shows IV across strikes for the nearest expirations. The typical 'smirk' pattern (higher IV for OTM puts) reflects demand for downside protection. The 25-delta skew (put IV − call IV) quantifies this: high values mean puts are expensive relative to calls. You can exploit steep skew by selling OTM put spreads or trading risk reversals (Sinclair, Ch. 6: Skew Trading)." />
        </div>
        {skew25d && (
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${skew25d.skew > 5 ? 'bg-red-500/10 text-red-400' : skew25d.skew < 1 ? 'bg-green-500/10 text-green-400' : 'bg-bg-tertiary text-text-muted'}`}>
            25Δ Skew: {skew25d.skew.toFixed(1)}pp
          </span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-[200px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      {skew25d && (
        <div className="px-4 py-2 border-t border-border/20 text-[11px] font-mono text-text-secondary">
          {skew25d.skew > 8
            ? `25Δ skew at ${skew25d.skew.toFixed(1)}pp (${skew25d.dte}d) — very steep. OTM puts are significantly more expensive than calls. Heavy demand for downside protection or crash hedging. Selling put spreads has a richness edge.`
            : skew25d.skew > 3
            ? `25Δ skew at ${skew25d.skew.toFixed(1)}pp (${skew25d.dte}d) — moderately steep. Normal put premium for most equities.`
            : skew25d.skew > 0
            ? `25Δ skew at ${skew25d.skew.toFixed(1)}pp (${skew25d.dte}d) — relatively flat. Limited directional bias in wings.`
            : `25Δ skew at ${skew25d.skew.toFixed(1)}pp (${skew25d.dte}d) — inverted (calls > puts). Unusual; indicates strong upside demand or short squeeze dynamics.`}
        </div>
      )}
    </div>
  );
}
