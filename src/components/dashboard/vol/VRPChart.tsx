'use client';

import { useEffect, useRef, useState } from 'react';
import { useDashboardStore, type SnapshotData } from '@/hooks/useDashboardStore';
import InfoTip from './InfoTip';

type Timeframe = '1M' | '3M' | '6M' | '1Y';
type HVKey = 'hv10' | 'hv20' | 'hv30' | 'hv60';

const TF_DAYS: Record<Timeframe, number> = { '1M': 21, '3M': 63, '6M': 126, '1Y': 252 };
const HV_LABELS: Record<HVKey, string> = { hv10: '10d', hv20: '20d', hv30: '30d', hv60: '60d' };

export default function VRPChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();
  const [tf, setTf] = useState<Timeframe>('6M');
  const [hvKey, setHvKey] = useState<HVKey>('hv20');

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

    // Filter by timeframe
    const maxPts = TF_DAYS[tf];
    const data = ivSeries.slice(-maxPts);
    if (data.length < 5) return;

    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;

    // Collect all values for Y scale
    const allVals: number[] = [];
    for (const d of data) {
      allVals.push(d.ivProxy, d[hvKey]);
    }
    if (vixSeries?.length) {
      for (const v of vixSeries) {
        if (v.time >= minTime && v.time <= maxTime) allVals.push(v.vix);
      }
    }
    if (snapshot?.iv?.currentIV) allVals.push(snapshot.iv.currentIV);

    const sorted = [...allVals].filter(v => v > 0).sort((a, b) => a - b);
    if (sorted.length < 2) return;
    const p2 = sorted[Math.floor(sorted.length * 0.02)];
    const p98 = sorted[Math.floor(sorted.length * 0.98)];
    const minV = p2 * 0.85;
    const maxV = p98 * 1.15;

    const toX = (t: number) => pad.left + ((t - minTime) / (maxTime - minTime)) * cw;
    const toY = (v: number) => {
      const clamped = Math.max(minV, Math.min(maxV, v));
      return pad.top + ch - ((clamped - minV) / (maxV - minV)) * ch;
    };

    // Grid
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (ch / 5) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // VRP shading: fill between IV proxy and HV
    // Green when IV > HV (sellers' edge), Red when IV < HV (buyers' edge)
    for (let i = 1; i < data.length; i++) {
      const x0 = toX(data[i - 1].time), x1 = toX(data[i].time);
      const ivY0 = toY(data[i - 1].ivProxy), ivY1 = toY(data[i].ivProxy);
      const hvY0 = toY(data[i - 1][hvKey]), hvY1 = toY(data[i][hvKey]);
      const ivAbove = data[i].ivProxy > data[i][hvKey];

      ctx.beginPath();
      ctx.moveTo(x0, ivY0);
      ctx.lineTo(x1, ivY1);
      ctx.lineTo(x1, hvY1);
      ctx.lineTo(x0, hvY0);
      ctx.closePath();
      ctx.fillStyle = ivAbove ? '#00e67612' : '#ff3d5712';
      ctx.fill();
    }

    // HV line
    ctx.beginPath();
    ctx.moveTo(toX(data[0].time), toY(data[0][hvKey]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(data[i].time), toY(data[i][hvKey]));
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

    // VIX overlay (dashed)
    if (vixSeries?.length) {
      const vixInRange = vixSeries.filter(v => v.time >= minTime && v.time <= maxTime);
      if (vixInRange.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(toX(vixInRange[0].time), toY(vixInRange[0].vix));
        for (let i = 1; i < vixInRange.length; i++) {
          ctx.lineTo(toX(vixInRange[i].time), toY(vixInRange[i].vix));
        }
        ctx.strokeStyle = '#ff3d57';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Current IV horizontal reference
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

    // Current VRP value (top-right badge)
    const lastPt = data[data.length - 1];
    const vrpVal = (lastPt.ivProxy - lastPt[hvKey]) * 100;
    ctx.font = 'bold 10px "JetBrains Mono"';
    ctx.textAlign = 'right';
    ctx.fillStyle = vrpVal > 0 ? '#00e676' : '#ff3d57';
    ctx.fillText(`VRP: ${vrpVal > 0 ? '+' : ''}${vrpVal.toFixed(1)}pp`, w - pad.right - 4, pad.top + 12);

    // Y axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const val = minV + ((maxV - minV) / 5) * (5 - i);
      ctx.fillText(`${(val * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 5) * i + 3);
    }

    // X axis dates
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

    ctx.fillStyle = '#00d4ff';
    ctx.fillRect(lx, legendY - 4, 12, 2); lx += 14;
    ctx.fillText(`HV ${HV_LABELS[hvKey]}`, lx, legendY); lx += 55;

    ctx.fillStyle = '#b388ff';
    ctx.fillRect(lx, legendY - 4, 12, 2); lx += 14;
    ctx.fillText('IV Proxy', lx, legendY); lx += 65;

    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(lx, legendY - 4, 12, 2); lx += 14;
    ctx.fillText('Current IV', lx, legendY); lx += 75;

    if (vixSeries?.length) {
      ctx.strokeStyle = '#ff3d57';
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx, legendY - 3); ctx.lineTo(lx + 12, legendY - 3); ctx.stroke();
      ctx.setLineDash([]);
      lx += 14;
      ctx.fillStyle = '#ff3d57';
      ctx.fillText('VIX', lx, legendY);
    }

  }, [snapshot, tf, hvKey]);

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
        <div className="flex items-center gap-1.5">
          <span className="panel-title">Volatility Risk Premium (IV vs Realized)</span>
          <InfoTip text="The Volatility Risk Premium (VRP) is the spread between implied and realized volatility. When IV > HV (green shading), options are 'expensive' — sellers have a statistical edge. When IV < HV (red shading), options may be underpriced — buying premium can be attractive. This is the core edge exploited by systematic vol sellers (Sinclair, Positional Options Trading Ch. 3)." />
        </div>
        <div className="flex items-center gap-2">
          {/* HV window picker */}
          <div className="flex gap-0.5">
            {(Object.keys(HV_LABELS) as HVKey[]).map(k => (
              <button key={k} onClick={() => setHvKey(k)}
                className={`px-1.5 py-0.5 text-[9px] font-mono rounded transition-colors ${hvKey === k ? 'bg-accent-cyan/20 text-accent-cyan' : 'text-text-muted hover:text-text-secondary'}`}>
                {HV_LABELS[k]}
              </button>
            ))}
          </div>
          <div className="w-px h-4 bg-border/30" />
          {/* Timeframe picker */}
          <div className="flex gap-0.5">
            {(['1M', '3M', '6M', '1Y'] as Timeframe[]).map(t => (
              <button key={t} onClick={() => setTf(t)}
                className={`px-1.5 py-0.5 text-[9px] font-mono rounded transition-colors ${tf === t ? 'bg-accent-purple/20 text-accent-purple' : 'text-text-muted hover:text-text-secondary'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[300px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      {/* VRP context */}
      {(() => {
        const last = snapshot.ivTimeSeries![snapshot.ivTimeSeries!.length - 1];
        const vrp = last.ivProxy - last[hvKey];
        const vrpPp = vrp * 100;
        return (
          <div className="px-4 py-2.5 border-t border-border/20 text-[11px] font-mono text-text-secondary leading-relaxed">
            {vrpPp > 5
              ? `VRP is +${vrpPp.toFixed(1)}pp — IV significantly exceeds realized vol. Strong edge for premium sellers (iron condors, credit spreads, strangles). The market is pricing more risk than has materialized.`
              : vrpPp > 1
              ? `VRP is +${vrpPp.toFixed(1)}pp — IV modestly above realized. Mild seller's edge; standard for most equities.`
              : vrpPp > -1
              ? `VRP near zero (${vrpPp > 0 ? '+' : ''}${vrpPp.toFixed(1)}pp) — IV ≈ HV. Options are fairly priced; no clear vol edge.`
              : vrpPp > -5
              ? `VRP is ${vrpPp.toFixed(1)}pp — IV below realized vol. Options may be cheap; consider long premium strategies (straddles, debit spreads).`
              : `VRP is ${vrpPp.toFixed(1)}pp — IV significantly below realized. Rare condition — long vol strategies have a historical edge here.`}
          </div>
        );
      })()}
    </div>
  );
}
