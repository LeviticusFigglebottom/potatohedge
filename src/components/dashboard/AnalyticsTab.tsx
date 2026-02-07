'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';
import {
  BarChart3, Activity, TrendingUp, TrendingDown, Shield,
  Thermometer, Zap, Target, AlertTriangle, Gauge, Brain,
} from 'lucide-react';
import MetricExplorer from './MetricExplorer';

// ─── IV / HV History Chart ──────────────────────────────────────

function IVHistoryChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !snapshot?.ivTimeSeries?.length) return;
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

    const data = snapshot.ivTimeSeries;
    if (data.length < 5) return;

    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;
    const allVals = data.flatMap(d => [d.hv20, d.ivProxy]);
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

    // Current IV horizontal line
    if (snapshot.iv?.currentIV) {
      const cy = toY(snapshot.iv.currentIV);
      ctx.strokeStyle = '#ffaa0060';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, cy); ctx.lineTo(w - pad.right, cy); ctx.stroke();
      ctx.setLineDash([]);

      // Label
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

    // X axis labels — show dates
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, data.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (data.length - 1));
      const d = new Date(data[idx].time * 1000);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      ctx.fillText(label, toX(data[idx].time), h - pad.bottom + 14);
    }

    // Legend
    const legendY = 12;
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'left';
    // HV20
    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(pad.left, legendY - 4, 12, 2);
    ctx.fillText('HV 20d', pad.left + 16, legendY);
    // IV Proxy
    ctx.fillStyle = '#b388ff';
    ctx.fillRect(pad.left + 80, legendY - 4, 12, 2);
    ctx.fillText('IV Proxy', pad.left + 96, legendY);
    // Current IV
    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(pad.left + 170, legendY - 4, 12, 2);
    ctx.fillText('Current IV', pad.left + 186, legendY);

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
        <span className="panel-title">IV / HV History (Rolling 20d)</span>
        <span className="badge badge-purple">{snapshot.ivTimeSeries.length}d</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[280px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}

// ─── IV Rank History Chart ──────────────────────────────────────

function IVRankHistoryChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !snapshot?.ivTimeSeries?.length) return;
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

    const data = snapshot.ivTimeSeries;
    if (data.length < 5) return;

    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;

    const toX = (t: number) => pad.left + ((t - minTime) / (maxTime - minTime)) * cw;
    const toY = (rank: number) => pad.top + ch - (rank / 100) * ch;

    // Zone fills
    // Low zone (0-30): green tint
    ctx.fillStyle = '#00e67608';
    ctx.fillRect(pad.left, toY(30), cw, toY(0) - toY(30));
    // High zone (70-100): red tint
    ctx.fillStyle = '#ff3d5708';
    ctx.fillRect(pad.left, toY(100), cw, toY(70) - toY(100));

    // Zone boundaries
    ctx.strokeStyle = '#00e67620';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad.left, toY(30)); ctx.lineTo(w - pad.right, toY(30)); ctx.stroke();
    ctx.strokeStyle = '#ff3d5720';
    ctx.beginPath(); ctx.moveTo(pad.left, toY(70)); ctx.lineTo(w - pad.right, toY(70)); ctx.stroke();
    ctx.setLineDash([]);

    // IV Rank area fill
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].ivRank));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].ivRank));
    }
    ctx.lineTo(toX(data[data.length - 1].time), pad.top + ch);
    ctx.lineTo(toX(data[0].time), pad.top + ch);
    ctx.closePath();
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
    gradient.addColorStop(0, '#ff3d5715');
    gradient.addColorStop(0.5, '#ffaa0010');
    gradient.addColorStop(1, '#00e67610');
    ctx.fillStyle = gradient;
    ctx.fill();

    // IV Rank line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0].ivRank));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i].ivRank));
    }
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Current IV Rank dot
    const last = data[data.length - 1];
    ctx.beginPath();
    ctx.arc(toX(last.time), toY(last.ivRank), 4, 0, 2 * Math.PI);
    ctx.fillStyle = last.ivRank > 70 ? '#ff3d57' : last.ivRank < 30 ? '#00e676' : '#ffaa00';
    ctx.fill();

    // Y axis
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    [0, 20, 30, 50, 70, 80, 100].forEach(v => {
      ctx.fillText(`${v}`, pad.left - 5, toY(v) + 3);
    });

    // X axis dates
    ctx.textAlign = 'center';
    const labelCount = Math.min(6, data.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (data.length - 1));
      const d = new Date(data[idx].time * 1000);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, toX(data[idx].time), h - pad.bottom + 14);
    }

    // Zone labels
    ctx.font = '8px "JetBrains Mono"';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#00e67640';
    ctx.fillText('Cheap', w - pad.right + 4, toY(15));
    ctx.fillStyle = '#ff3d5740';
    ctx.fillText('Expensive', w - pad.right + 4, toY(85));

  }, [snapshot]);

  if (!snapshot?.ivTimeSeries?.length) return null;

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <span className="panel-title">IV Rank History</span>
        <span className={`badge ${
          (snapshot.iv?.ivRank ?? 50) > 70 ? 'badge-red' :
          (snapshot.iv?.ivRank ?? 50) < 30 ? 'badge-green' : 'badge-amber'
        }`}>
          Current: {snapshot.iv?.ivRank ?? '—'}
        </span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[220px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}

// ─── Per-Expiration Metrics Table ────────────────────────────────

function PerExpirationTable() {
  const { multiGEX } = useDashboardStore();
  if (!multiGEX?.perExpiration?.length) return null;

  const perExp = multiGEX.perExpiration;
  const agg = multiGEX.aggregated;
  const vol = multiGEX.volume;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Per-Expiration Breakdown</span>
        <span className="badge badge-cyan">{perExp.length} exp</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border text-text-muted">
              <th className="px-3 py-2 text-left">Expiration</th>
              <th className="px-3 py-2 text-right">DTE</th>
              <th className="px-3 py-2 text-right">Vol P/C</th>
              <th className="px-3 py-2 text-right">OI P/C</th>
              <th className="px-3 py-2 text-right">Net GEX</th>
              <th className="px-3 py-2 text-right">Net DEX</th>
              <th className="px-3 py-2 text-right">Vanna</th>
              <th className="px-3 py-2 text-right">Charm</th>
              <th className="px-3 py-2 text-right">Call Vol</th>
              <th className="px-3 py-2 text-right">Put Vol</th>
            </tr>
          </thead>
          <tbody>
            {perExp.map((exp) => (
              <tr key={exp.expiration} className="border-b border-border/20 hover:bg-bg-hover/30">
                <td className="px-3 py-2 text-text-secondary">{exp.expiration}</td>
                <td className="px-3 py-2 text-right text-text-muted">{exp.dte}d</td>
                <td className={`px-3 py-2 text-right ${exp.volumePCR > 1.2 ? 'text-accent-red' : exp.volumePCR < 0.8 ? 'text-accent-green' : 'text-text-primary'}`}>
                  {exp.volumePCR.toFixed(2)}
                </td>
                <td className={`px-3 py-2 text-right ${exp.oiPCR > 1.2 ? 'text-accent-red' : exp.oiPCR < 0.8 ? 'text-accent-green' : 'text-text-primary'}`}>
                  {exp.oiPCR.toFixed(2)}
                </td>
                <td className={`px-3 py-2 text-right ${exp.totalGEX >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                  {formatNumber(exp.totalGEX)}
                </td>
                <td className={`px-3 py-2 text-right ${exp.totalDEX < 0 ? 'text-accent-amber' : 'text-text-primary'}`}>
                  {formatNumber(exp.totalDEX)}
                </td>
                <td className="px-3 py-2 text-right text-text-muted">{formatNumber(exp.totalVanna)}</td>
                <td className="px-3 py-2 text-right text-text-muted">{formatNumber(exp.totalCharm)}</td>
                <td className="px-3 py-2 text-right text-accent-green">{formatNumber(exp.callVolume, 0)}</td>
                <td className="px-3 py-2 text-right text-accent-red">{formatNumber(exp.putVolume, 0)}</td>
              </tr>
            ))}
            {/* Totals row */}
            <tr className="border-t border-border bg-bg-tertiary/30 font-semibold">
              <td className="px-3 py-2 text-text-primary">Total</td>
              <td className="px-3 py-2 text-right text-text-muted">—</td>
              <td className={`px-3 py-2 text-right ${(vol?.volumePCR ?? 0) > 1.2 ? 'text-accent-red' : (vol?.volumePCR ?? 0) < 0.8 ? 'text-accent-green' : 'text-text-primary'}`}>
                {(vol?.volumePCR ?? 0).toFixed(2)}
              </td>
              <td className={`px-3 py-2 text-right ${(vol?.oiPCR ?? 0) > 1.2 ? 'text-accent-red' : (vol?.oiPCR ?? 0) < 0.8 ? 'text-accent-green' : 'text-text-primary'}`}>
                {(vol?.oiPCR ?? 0).toFixed(2)}
              </td>
              <td className={`px-3 py-2 text-right ${(agg?.totalGEX ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {formatNumber(agg?.totalGEX ?? 0)}
              </td>
              <td className={`px-3 py-2 text-right ${(agg?.totalDEX ?? 0) < 0 ? 'text-accent-amber' : 'text-text-primary'}`}>
                {formatNumber(agg?.totalDEX ?? 0)}
              </td>
              <td className="px-3 py-2 text-right text-text-muted">{formatNumber(agg?.totalVanna ?? 0)}</td>
              <td className="px-3 py-2 text-right text-text-muted">{formatNumber(agg?.totalCharm ?? 0)}</td>
              <td className="px-3 py-2 text-right text-accent-green">{formatNumber(vol?.totalCallVol ?? 0, 0)}</td>
              <td className="px-3 py-2 text-right text-accent-red">{formatNumber(vol?.totalPutVol ?? 0, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Volume Analysis Panel ──────────────────────────────────────

function VolumeAnalysis() {
  const { multiGEX, quote } = useDashboardStore();
  if (!multiGEX?.volume) return null;

  const vol = multiGEX.volume;
  const ctx = multiGEX.context?.volume;
  const totalVol = vol.totalCallVol + vol.totalPutVol;
  const callPct = totalVol > 0 ? (vol.totalCallVol / totalVol) * 100 : 50;
  const putPct = totalVol > 0 ? (vol.totalPutVol / totalVol) * 100 : 50;

  // Stock volume context
  const stockVolRatio = quote && quote.avgVolume > 0 ? quote.volume / quote.avgVolume : 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Volume Analysis</span>
      </div>
      <div className="px-4 py-3 space-y-4">
        {/* Options Volume Bar */}
        <div>
          <div className="flex justify-between text-xs font-mono text-text-muted mb-1">
            <span>Call Volume: {formatNumber(vol.totalCallVol, 0)}</span>
            <span>Put Volume: {formatNumber(vol.totalPutVol, 0)}</span>
          </div>
          <div className="h-3 rounded-full bg-bg-tertiary overflow-hidden flex">
            <div
              className="h-full bg-accent-green/40 transition-all"
              style={{ width: `${callPct}%` }}
            />
            <div
              className="h-full bg-accent-red/40 transition-all"
              style={{ width: `${putPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono text-text-muted mt-0.5">
            <span>{callPct.toFixed(0)}% calls</span>
            <span>{putPct.toFixed(0)}% puts</span>
          </div>
        </div>

        {/* PCR Comparison */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-bg-tertiary/30 rounded-lg p-3">
            <div className="text-[10px] font-mono text-text-muted mb-1">Volume P/C Ratio</div>
            <div className={`text-lg font-mono font-semibold ${
              vol.volumePCR > 1.2 ? 'text-accent-red' :
              vol.volumePCR < 0.8 ? 'text-accent-green' : 'text-text-primary'
            }`}>
              {vol.volumePCR.toFixed(3)}
            </div>
            <div className="text-[10px] font-mono text-text-muted">Today&apos;s flow</div>
          </div>
          <div className="bg-bg-tertiary/30 rounded-lg p-3">
            <div className="text-[10px] font-mono text-text-muted mb-1">OI P/C Ratio</div>
            <div className={`text-lg font-mono font-semibold ${
              vol.oiPCR > 1.2 ? 'text-accent-red' :
              vol.oiPCR < 0.8 ? 'text-accent-green' : 'text-text-primary'
            }`}>
              {vol.oiPCR.toFixed(3)}
            </div>
            <div className="text-[10px] font-mono text-text-muted">Accumulated positioning</div>
          </div>
        </div>

        {/* PCR divergence */}
        {Math.abs(vol.volumePCR - vol.oiPCR) / Math.max(vol.oiPCR, 0.01) > 0.15 && (
          <div className="bg-bg-tertiary/20 rounded-lg px-3 py-2">
            <div className="text-xs text-text-secondary font-mono">
              {vol.volumePCR > vol.oiPCR
                ? `Today's flow (${vol.volumePCR.toFixed(2)}) is ${((vol.volumePCR / vol.oiPCR - 1) * 100).toFixed(0)}% more put-heavy than accumulated positioning (${vol.oiPCR.toFixed(2)}) — bearish shift in today's activity.`
                : `Today's flow (${vol.volumePCR.toFixed(2)}) is ${((1 - vol.volumePCR / vol.oiPCR) * 100).toFixed(0)}% more call-heavy than accumulated positioning (${vol.oiPCR.toFixed(2)}) — bullish shift in today's activity.`
              }
            </div>
          </div>
        )}

        {/* Stock volume context */}
        {stockVolRatio > 0 && (
          <div className="bg-bg-tertiary/20 rounded-lg px-3 py-2">
            <div className="text-xs text-text-secondary font-mono">
              Stock volume: {formatNumber(quote?.volume ?? 0, 0)} ({(stockVolRatio * 100).toFixed(0)}% of avg)
              {stockVolRatio > 1.5 ? ' — elevated activity' :
               stockVolRatio < 0.5 ? ' — unusually low' : ''}
            </div>
          </div>
        )}

        {/* Volume context interpretation */}
        {ctx?.interpretation && ctx.interpretation !== 'Volume within normal ranges.' && (
          <div className="border-t border-border/20 pt-2">
            <p className="text-xs text-text-secondary font-mono leading-relaxed">{ctx.interpretation}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Dealer Exposure Summary ────────────────────────────────────

function DealerExposureSummary() {
  const { multiGEX } = useDashboardStore();
  if (!multiGEX?.aggregated) return null;

  const agg = multiGEX.aggregated;
  const spot = multiGEX.spotPrice;
  const perExp = multiGEX.perExpiration;

  // Find which expiration contributes most GEX
  const sortedByGEX = [...perExp].sort((a, b) => Math.abs(b.totalGEX) - Math.abs(a.totalGEX));
  const topGEXExp = sortedByGEX[0];

  // Levels
  const levels = [
    { label: 'Call Wall', value: agg.callWall, color: 'text-accent-green' },
    { label: 'Put Wall', value: agg.putWall, color: 'text-accent-red' },
    { label: 'Gamma Flip', value: agg.gammaFlip, color: 'text-accent-amber' },
    { label: 'Max Pain', value: multiGEX.maxPain?.strike ?? null, color: 'text-accent-cyan' },
  ];

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Dealer Exposure Summary</span>
      </div>
      <div className="px-4 py-3 space-y-3">
        {/* Key levels with distance */}
        <div className="grid grid-cols-2 gap-2">
          {levels.map(lev => {
            if (lev.value === null) return null;
            const dist = spot > 0 ? ((lev.value - spot) / spot * 100) : 0;
            return (
              <div key={lev.label} className="bg-bg-tertiary/30 rounded-lg p-2">
                <div className="text-[10px] font-mono text-text-muted">{lev.label}</div>
                <div className={`text-sm font-mono font-semibold ${lev.color}`}>
                  {formatCurrency(lev.value)}
                </div>
                <div className="text-[10px] font-mono text-text-muted">
                  {dist > 0 ? '+' : ''}{dist.toFixed(1)}% from spot
                </div>
              </div>
            );
          })}
        </div>

        {/* Greeks summary */}
        <div className="grid grid-cols-4 gap-2 border-t border-border/20 pt-3">
          <div className="text-center">
            <div className="text-[10px] font-mono text-text-muted">Net GEX</div>
            <div className={`text-sm font-mono font-semibold ${agg.totalGEX >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
              {formatNumber(agg.totalGEX)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-mono text-text-muted">Net DEX</div>
            <div className={`text-sm font-mono font-semibold ${agg.totalDEX < 0 ? 'text-accent-amber' : 'text-text-primary'}`}>
              {formatNumber(agg.totalDEX)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-mono text-text-muted">Net Vanna</div>
            <div className="text-sm font-mono font-semibold text-text-secondary">
              {formatNumber(agg.totalVanna)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] font-mono text-text-muted">Net Charm</div>
            <div className="text-sm font-mono font-semibold text-text-secondary">
              {formatNumber(agg.totalCharm)}
            </div>
          </div>
        </div>

        {/* Dominant expiration */}
        {topGEXExp && (
          <div className="border-t border-border/20 pt-2">
            <p className="text-xs text-text-secondary font-mono">
              Largest GEX contribution: {topGEXExp.expiration} ({topGEXExp.dte}d DTE) at {formatNumber(topGEXExp.totalGEX)}
              {perExp.length > 1 && ` — ${((Math.abs(topGEXExp.totalGEX) / Math.max(1, Math.abs(agg.totalGEX))) * 100).toFixed(0)}% of total`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Metric Context Cards ───────────────────────────────────────

function MetricContextCards() {
  const { multiGEX, snapshot, quote } = useDashboardStore();

  const insights: { icon: React.ElementType; color: string; title: string; text: string }[] = [];

  // IV context
  if (snapshot?.iv) {
    const iv = snapshot.iv;
    if (iv.ivRank <= 20) {
      insights.push({
        icon: Thermometer, color: 'text-accent-green',
        title: 'IV Rank: Near Lows',
        text: `IV Rank at ${iv.ivRank} — options are historically cheap. Current IV (${(iv.currentIV * 100).toFixed(1)}%) is near the 52-week low of ${(iv.iv52wLow * 100).toFixed(1)}%. Favor buying strategies (long straddles, debit spreads).`,
      });
    } else if (iv.ivRank >= 80) {
      insights.push({
        icon: Thermometer, color: 'text-accent-red',
        title: 'IV Rank: Near Highs',
        text: `IV Rank at ${iv.ivRank} — options are historically expensive. Current IV (${(iv.currentIV * 100).toFixed(1)}%) is near the 52-week high of ${(iv.iv52wHigh * 100).toFixed(1)}%. Favor selling strategies (iron condors, credit spreads).`,
      });
    }

    if (iv.ivHvRatio < 0.8) {
      insights.push({
        icon: Activity, color: 'text-accent-amber',
        title: 'IV/HV Divergence',
        text: `IV/HV ratio is ${iv.ivHvRatio.toFixed(2)} — implied volatility is significantly below realized. The market is pricing less risk than recent moves justify. Options may be underpriced.`,
      });
    } else if (iv.ivHvRatio > 1.3) {
      insights.push({
        icon: Activity, color: 'text-accent-purple',
        title: 'IV Premium Elevated',
        text: `IV/HV ratio is ${iv.ivHvRatio.toFixed(2)} — implied volatility significantly exceeds realized. Options are pricing more risk than recent moves suggest. Potential vol overpricing.`,
      });
    }
  }

  // Volume PCR divergence from OI
  if (multiGEX?.volume) {
    const vol = multiGEX.volume;
    const divergence = vol.oiPCR > 0 ? (vol.volumePCR - vol.oiPCR) / vol.oiPCR : 0;
    if (Math.abs(divergence) > 0.25) {
      insights.push({
        icon: BarChart3, color: divergence > 0 ? 'text-accent-red' : 'text-accent-green',
        title: `PCR Shift: ${divergence > 0 ? 'Bearish' : 'Bullish'} Today`,
        text: `Volume P/C (${vol.volumePCR.toFixed(2)}) has shifted ${(Math.abs(divergence) * 100).toFixed(0)}% ${divergence > 0 ? 'higher' : 'lower'} than OI P/C (${vol.oiPCR.toFixed(2)}). Today's flow is ${divergence > 0 ? 'more put-heavy' : 'more call-heavy'} than accumulated positioning.`,
      });
    }
  }

  // GEX regime
  if (multiGEX?.aggregated) {
    const gex = multiGEX.aggregated;
    const gammaFlip = gex.gammaFlip;
    const spot = multiGEX.spotPrice;
    if (gammaFlip && spot) {
      const dist = ((spot - gammaFlip) / spot * 100);
      if (Math.abs(dist) < 0.5) {
        insights.push({
          icon: Shield, color: 'text-accent-amber',
          title: 'Gamma Flip Zone',
          text: `Spot ($${spot.toFixed(2)}) is within 0.5% of the gamma flip ($${gammaFlip.toFixed(2)}). This is a regime transition zone — expect increased volatility and potential whipsaw.`,
        });
      }
    }
  }

  // Stock volume
  if (quote && quote.avgVolume > 0) {
    const ratio = quote.volume / quote.avgVolume;
    if (ratio > 2) {
      insights.push({
        icon: Gauge, color: 'text-accent-cyan',
        title: 'Elevated Stock Volume',
        text: `Stock volume is ${ratio.toFixed(1)}x the 20-day average — likely catalyst-driven activity. Watch for continuation or reversal patterns.`,
      });
    } else if (ratio < 0.4) {
      insights.push({
        icon: Gauge, color: 'text-text-muted',
        title: 'Low Stock Volume',
        text: `Stock volume at ${(ratio * 100).toFixed(0)}% of average — thin liquidity may lead to wider spreads and erratic price action.`,
      });
    }
  }

  if (insights.length === 0) {
    insights.push({
      icon: Brain, color: 'text-accent-purple',
      title: 'No Anomalies Detected',
      text: 'All metrics are within normal ranges. No significant divergences between current values and historical baselines.',
    });
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-accent-purple" />
          Metric Insights
        </span>
        <span className="badge badge-purple">{insights.length} signals</span>
      </div>
      <div className="divide-y divide-border/20">
        {insights.map((ins, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-1">
              <ins.icon className={`w-3.5 h-3.5 ${ins.color}`} />
              <span className={`text-xs font-mono font-semibold ${ins.color}`}>{ins.title}</span>
            </div>
            <p className="text-xs text-text-secondary font-mono leading-relaxed pl-5">{ins.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── OI Concentration Panel ─────────────────────────────────────

function OIConcentrationPanel() {
  const { multiGEX } = useDashboardStore();
  const oi = multiGEX?.context?.oi;
  if (!oi) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">OI Concentration</span>
      </div>
      <div className="px-4 py-3">
        <div className="grid grid-cols-2 gap-4">
          {/* Top Call Strikes */}
          <div>
            <div className="text-[10px] font-mono text-accent-green mb-2">Top Call Strikes</div>
            {oi.topCallStrikes.slice(0, 5).map((s, i) => (
              <div key={i} className="flex justify-between items-center py-0.5">
                <span className="text-xs font-mono text-text-secondary">${s.strike}</span>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full bg-accent-green/40 rounded-full" style={{ width: `${Math.min(100, s.pctOfTotal)}%` }} />
                  </div>
                  <span className="text-[10px] font-mono text-text-muted w-8 text-right">{s.pctOfTotal.toFixed(0)}%</span>
                </div>
              </div>
            ))}
          </div>
          {/* Top Put Strikes */}
          <div>
            <div className="text-[10px] font-mono text-accent-red mb-2">Top Put Strikes</div>
            {oi.topPutStrikes.slice(0, 5).map((s, i) => (
              <div key={i} className="flex justify-between items-center py-0.5">
                <span className="text-xs font-mono text-text-secondary">${s.strike}</span>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
                    <div className="h-full bg-accent-red/40 rounded-full" style={{ width: `${Math.min(100, s.pctOfTotal)}%` }} />
                  </div>
                  <span className="text-[10px] font-mono text-text-muted w-8 text-right">{s.pctOfTotal.toFixed(0)}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {oi.interpretation && oi.interpretation !== 'OI well-distributed across strikes.' && (
          <p className="text-xs text-text-secondary font-mono mt-3 pt-2 border-t border-border/20">{oi.interpretation}</p>
        )}
      </div>
    </div>
  );
}

// ─── Main Analytics Tab ─────────────────────────────────────────

export default function AnalyticsTab() {
  const { snapshot, multiGEX, loading } = useDashboardStore();

  if ((loading.snapshot || loading.multiGEX) && !snapshot && !multiGEX) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="panel p-8 flex items-center justify-center">
          <div className="flex items-center gap-3 text-text-muted font-mono">
            <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
            Loading analytics data...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Metric Explorer — backward-looking history for any metric */}
      <MetricExplorer />

      {/* Metric Insights — anomalies and context */}
      <MetricContextCards />

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <IVHistoryChart />
        <IVRankHistoryChart />
      </div>

      {/* Volume Analysis and Dealer Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <VolumeAnalysis />
        <DealerExposureSummary />
      </div>

      {/* Per-Expiration Table */}
      <PerExpirationTable />

      {/* OI Concentration */}
      <OIConcentrationPanel />
    </div>
  );
}
