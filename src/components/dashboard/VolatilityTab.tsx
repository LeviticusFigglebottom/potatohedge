'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { Thermometer, Brain, TrendingUp, TrendingDown } from 'lucide-react';

// ─── VIX Context Card ─────────────────────────────────────

function VIXCard() {
  const { snapshot } = useDashboardStore();
  const vix = snapshot?.vix;
  if (!vix) return null;

  const color = vix.price > 25 ? 'text-red-400' : vix.price > 18 ? 'text-amber-400' : 'text-green-400';
  const bg = vix.price > 25 ? 'border-red-500/20' : vix.price > 18 ? 'border-amber-500/20' : 'border-green-500/20';
  const label = vix.price > 35 ? 'Extreme Fear' : vix.price > 25 ? 'Elevated Fear' : vix.price > 18 ? 'Moderate' : vix.price > 13 ? 'Low Vol' : 'Complacency';

  // IV vs VIX spread
  const iv = snapshot?.iv;
  const ivPct = iv ? iv.currentIV * 100 : 0;
  const spread = ivPct > 0 ? ivPct - vix.price : 0;

  return (
    <div className={`panel p-4 border ${bg}`}>
      <div className="flex items-center gap-2 mb-3">
        <Thermometer className="w-3.5 h-3.5 text-accent-purple" />
        <span className="panel-title">Market VIX</span>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
          vix.price > 25 ? 'bg-red-500/10 text-red-400' :
          vix.price > 18 ? 'bg-amber-500/10 text-amber-400' :
          'bg-green-500/10 text-green-400'
        }`}>{label}</span>
      </div>

      <div className="flex items-end justify-between mb-3">
        <div className={`text-3xl font-mono font-bold ${color}`}>{vix.price.toFixed(2)}</div>
        <div className={`text-sm font-mono font-medium flex items-center gap-1 ${
          vix.changePct >= 0 ? 'text-red-400' : 'text-green-400'
        }`}>
          {vix.changePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {vix.changePct >= 0 ? '+' : ''}{vix.changePct.toFixed(2)}%
        </div>
      </div>

      {ivPct > 0 && (
        <div className="border-t border-border/30 pt-2">
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-mono text-text-muted">IV vs VIX Spread</span>
            <span className={`text-xs font-mono font-semibold ${
              spread > 5 ? 'text-red-400' : spread < -5 ? 'text-green-400' : 'text-text-primary'
            }`}>
              {spread > 0 ? '+' : ''}{spread.toFixed(1)}pp
            </span>
          </div>
          <div className="text-[9px] font-mono text-text-muted/60 mt-0.5">
            {spread > 10 ? 'Stock significantly more volatile than market' :
             spread > 5 ? 'Stock IV at premium to market' :
             spread < -5 ? 'Stock IV at discount — calm relative to market' :
             'Stock IV tracking near market levels'}
          </div>
        </div>
      )}
    </div>
  );
}

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
  const vix = snapshot?.vix;
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

  // Add VIX as reference
  if (vix) {
    stats.push({
      label: 'Market VIX',
      value: vix.price.toFixed(1),
      color: vix.price > 25 ? 'text-red-400' : vix.price > 18 ? 'text-amber-400' : 'text-green-400',
    });
  }

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

// ─── IV vs VIX History Chart ──────────────────────────────

function IVvsVIXChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;
    const ivSeries = snapshot?.ivTimeSeries;
    const vixSeries = snapshot?.vixTimeSeries;
    if (!ivSeries?.length) return;

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
    const pad = { top: 25, right: 60, bottom: 35, left: 55 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    // Build VIX lookup by date (rounded to day)
    const vixByDay = new Map<string, number>();
    if (vixSeries?.length) {
      for (const v of vixSeries) {
        const d = new Date(v.time * 1000);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        vixByDay.set(key, v.vix);
      }
    }

    const data = ivSeries;
    if (data.length < 5) return;

    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;

    // Collect all values for Y scale
    const allVals = data.flatMap(d => [d.hv20, d.ivProxy]);
    // Include VIX values in scale
    if (vixSeries?.length) {
      for (const v of vixSeries) {
        if (v.time >= minTime && v.time <= maxTime) allVals.push(v.vix);
      }
    }
    if (snapshot?.iv?.currentIV) allVals.push(snapshot.iv.currentIV);

    const minV = Math.min(...allVals) * 0.85;
    const maxV = Math.max(...allVals) * 1.1;

    const toX = (t: number) => pad.left + ((t - minTime) / (maxTime - minTime)) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minV) / (maxV - minV)) * ch;

    // Grid lines
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (ch / 5) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // HV20 area fill
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].hv20));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].hv20));
    }
    ctx.lineTo(toX(data[data.length - 1].time), pad.top + ch);
    ctx.lineTo(toX(data[0].time), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = '#00d4ff08';
    ctx.fill();

    // HV20 line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].hv20));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].hv20));
    }
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // IV Proxy line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].ivProxy));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].ivProxy));
    }
    ctx.strokeStyle = '#b388ff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // VIX history line (if available)
    if (vixSeries?.length) {
      const vixInRange = vixSeries.filter(v => v.time >= minTime && v.time <= maxTime);
      if (vixInRange.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(toX(vixInRange[0].time), toY(vixInRange[0].vix));
        for (let i = 1; i < vixInRange.length; i++) {
          ctx.lineTo(toX(vixInRange[i].time), toY(vixInRange[i].vix));
        }
        ctx.strokeStyle = '#ff3d57';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Current IV horizontal line
    if (snapshot?.iv?.currentIV) {
      const cy = toY(snapshot.iv.currentIV);
      ctx.strokeStyle = '#ffaa0060';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, cy); ctx.lineTo(w - pad.right, cy); ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffaa00';
      ctx.font = '9px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`IV ${(snapshot.iv.currentIV * 100).toFixed(0)}%`, w - pad.right + 4, cy + 3);
    }

    // Y axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const val = minV + ((maxV - minV) / 5) * (5 - i);
      ctx.fillText(`${(val * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 5) * i + 3);
    }

    // X axis labels
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, data.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (data.length - 1));
      const d = new Date(data[idx].time * 1000);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(data[idx].time), h - pad.bottom + 14);
    }

    // Legend
    const legendY = 12;
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'left';
    let lx = pad.left;
    // HV20
    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(lx, legendY - 4, 12, 2);
    ctx.fillText('HV 20d', lx + 16, legendY);
    lx += 80;
    // IV Proxy
    ctx.fillStyle = '#b388ff';
    ctx.fillRect(lx, legendY - 4, 12, 2);
    ctx.fillText('IV Proxy', lx + 16, legendY);
    lx += 85;
    // Current IV
    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(lx, legendY - 4, 12, 2);
    ctx.fillText('Current IV', lx + 16, legendY);
    // VIX
    if (vixSeries?.length) {
      lx += 95;
      ctx.fillStyle = '#ff3d57';
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = '#ff3d57';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, legendY - 3); ctx.lineTo(lx + 12, legendY - 3); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('VIX', lx + 16, legendY);
    }

  }, [snapshot]);

  if (!snapshot?.ivTimeSeries?.length) {
    return (
      <div className="panel p-8 flex items-center justify-center">
        <span className="text-sm font-mono text-text-muted">IV history requires snapshot data</span>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">IV / HV / VIX History</span>
        <span className="badge badge-purple">{snapshot.ivTimeSeries.length}d</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[280px]">
        <canvas ref={canvasRef} className="w-full h-full" />
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
    // Include VIX in Y scale if available
    const vixDecimal = snapshot.vix ? snapshot.vix.price / 100 : 0;
    const ivValues = data.map(d => d.atmIV);
    if (vixDecimal > 0) ivValues.push(vixDecimal);
    const minIV = Math.min(...ivValues) * 0.9;
    const maxIV = Math.max(...ivValues) * 1.1;

    const toX = (dte: number) => pad.left + ((dte - minDTE) / (maxDTE - minDTE)) * cw;
    const toY = (iv: number) => pad.top + ch - ((iv - minIV) / (maxIV - minIV)) * ch;

    // Grid
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // VIX horizontal reference line
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
    const exps = snapshot.skewSurface.slice(0, 3);
    if (exps.length === 0) return;

    const allPoints = exps.flatMap(e => e.points);
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

    // Spot vertical
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

// ─── Earnings Alert ───────────────────────────────────────

function EarningsAlert() {
  const { snapshot } = useDashboardStore();
  const earnings = snapshot?.earnings;
  if (!earnings) return null;

  const { nextEarnings, hasImminent, ivSignals } = earnings;

  // Only show if there's something to report
  if (!hasImminent && !nextEarnings && !ivSignals.termStructureBackwardation) return null;

  return (
    <div className={`panel border ${hasImminent ? 'border-amber-500/30 bg-amber-500/5' : 'border-border'}`}>
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <span className={hasImminent ? 'text-amber-400' : 'text-text-muted'}>
            {hasImminent ? '!' : 'i'}
          </span>
          Earnings Context
        </span>
        {hasImminent && <span className="badge badge-amber">Imminent</span>}
      </div>
      <div className="px-4 py-3 space-y-2">
        {nextEarnings && (
          <div className="flex justify-between items-center">
            <span className="text-xs font-mono text-text-muted">Next Earnings</span>
            <div className="text-right">
              <span className={`text-sm font-mono font-semibold ${nextEarnings.daysUntil <= 3 ? 'text-red-400' : nextEarnings.daysUntil <= 7 ? 'text-amber-400' : 'text-text-primary'}`}>
                {nextEarnings.date}
              </span>
              <span className="text-[10px] font-mono text-text-muted ml-2">
                ({nextEarnings.daysUntil}d)
                {nextEarnings.time !== 'unknown' && ` ${nextEarnings.time === 'bmo' ? 'Pre-Market' : 'After-Close'}`}
                {!nextEarnings.confirmed && ' (est.)'}
              </span>
            </div>
          </div>
        )}

        {/* IV signals */}
        <div className="grid grid-cols-3 gap-2 pt-1">
          <div className={`text-center p-1.5 rounded ${ivSignals.termStructureBackwardation ? 'bg-amber-500/10' : 'bg-bg-tertiary/30'}`}>
            <div className="text-[9px] font-mono text-text-muted">Backwardation</div>
            <div className={`text-xs font-mono font-semibold ${ivSignals.termStructureBackwardation ? 'text-amber-400' : 'text-text-muted'}`}>
              {ivSignals.termStructureBackwardation ? 'YES' : 'No'}
            </div>
          </div>
          <div className={`text-center p-1.5 rounded ${ivSignals.frontMonthIVPremium > 15 ? 'bg-amber-500/10' : 'bg-bg-tertiary/30'}`}>
            <div className="text-[9px] font-mono text-text-muted">Front IV Premium</div>
            <div className={`text-xs font-mono font-semibold ${ivSignals.frontMonthIVPremium > 15 ? 'text-amber-400' : 'text-text-muted'}`}>
              {ivSignals.frontMonthIVPremium > 0 ? '+' : ''}{ivSignals.frontMonthIVPremium.toFixed(1)}%
            </div>
          </div>
          <div className={`text-center p-1.5 rounded ${ivSignals.ivRankElevated ? 'bg-red-500/10' : 'bg-bg-tertiary/30'}`}>
            <div className="text-[9px] font-mono text-text-muted">IV Rank High</div>
            <div className={`text-xs font-mono font-semibold ${ivSignals.ivRankElevated ? 'text-red-400' : 'text-text-muted'}`}>
              {ivSignals.ivRankElevated ? 'YES' : 'No'}
            </div>
          </div>
        </div>

        {hasImminent && !nextEarnings?.confirmed && (
          <div className="text-[10px] font-mono text-amber-400/60 pt-1">
            IV term structure suggests an imminent binary event (earnings, FDA, etc.)
          </div>
        )}
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
      {/* Top row: VIX card + gauge + stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {snapshot?.vix ? <VIXCard /> : <IVGauge />}
        {snapshot?.vix ? <IVGauge /> : <IVStats />}
        {snapshot?.vix ? <IVStats /> : <TermStructureChart />}
      </div>

      {/* IV vs VIX History (upgraded from IV-only chart) */}
      <IVvsVIXChart />

      {/* Term structure (if VIX card bumped it from top row) */}
      {snapshot?.vix && <TermStructureChart />}

      {/* Earnings Alert */}
      <EarningsAlert />

      {/* Interpretation */}
      <IVInterpretation />

      {/* Skew */}
      <SkewChart />

      {/* Snapshot info */}
      {snapshot && (
        <div className="text-xs font-mono text-text-muted text-center py-2">
          Polygon snapshot: {snapshot.snapshotCount} contracts analyzed
          {snapshot.vix && ` | VIX: ${snapshot.vix.price.toFixed(2)}`}
        </div>
      )}
    </div>
  );
}
