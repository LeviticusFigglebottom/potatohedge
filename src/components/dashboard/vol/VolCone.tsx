'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import InfoTip from './InfoTip';

export default function VolCone() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { snapshot } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !snapshot?.volCone?.length) return;
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
    const pad = { top: 25, right: 50, bottom: 40, left: 55 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const cone = snapshot.volCone;
    if (cone.length < 2) return;

    // Y scale from all values
    const allVals = cone.flatMap(c => [c.p5, c.p95, c.current]);
    const currentIV = snapshot.iv?.currentIV ?? 0;
    if (currentIV > 0) allVals.push(currentIV);
    const minV = Math.min(...allVals) * 0.85;
    const maxV = Math.max(...allVals) * 1.15;

    // X: evenly space windows
    const n = cone.length;
    const toX = (i: number) => pad.left + (i / (n - 1)) * cw;
    const toY = (v: number) => {
      const clamped = Math.max(minV, Math.min(maxV, v));
      return pad.top + ch - ((clamped - minV) / (maxV - minV)) * ch;
    };

    // Grid
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // 5th-95th percentile band (outer)
    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(toX(i), toY(cone[i].p95));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(toX(i), toY(cone[i].p5));
    ctx.closePath();
    ctx.fillStyle = '#b388ff08';
    ctx.fill();
    ctx.strokeStyle = '#b388ff20';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 25th-75th percentile band (inner)
    ctx.beginPath();
    for (let i = 0; i < n; i++) ctx.lineTo(toX(i), toY(cone[i].p75));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(toX(i), toY(cone[i].p25));
    ctx.closePath();
    ctx.fillStyle = '#b388ff12';
    ctx.fill();
    ctx.strokeStyle = '#b388ff30';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Median line
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0) ctx.moveTo(toX(i), toY(cone[i].median));
      else ctx.lineTo(toX(i), toY(cone[i].median));
    }
    ctx.strokeStyle = '#b388ff60';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Current HV dots (connected)
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === 0) ctx.moveTo(toX(i), toY(cone[i].current));
      else ctx.lineTo(toX(i), toY(cone[i].current));
    }
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw dots for current HV
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(toX(i), toY(cone[i].current), 4, 0, 2 * Math.PI);
      // Color based on percentile position
      const pctPos = (cone[i].current - cone[i].p5) / (cone[i].p95 - cone[i].p5 || 1);
      ctx.fillStyle = pctPos > 0.75 ? '#ff3d57' : pctPos > 0.5 ? '#ffaa00' : pctPos > 0.25 ? '#00e676' : '#00d4ff';
      ctx.fill();
      ctx.strokeStyle = '#12121a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Current IV horizontal line
    if (currentIV > 0) {
      const ivY = toY(currentIV);
      ctx.strokeStyle = '#ffaa0050';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, ivY); ctx.lineTo(w - pad.right, ivY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffaa00';
      ctx.font = '9px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`IV ${(currentIV * 100).toFixed(0)}%`, w - pad.right + 4, ivY + 3);
    }

    // X axis labels (window names)
    ctx.fillStyle = '#555570';
    ctx.font = '10px "JetBrains Mono"';
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      ctx.fillText(`${cone[i].window}d`, toX(i), h - pad.bottom + 14);
    }

    // Y axis labels
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = minV + ((maxV - minV) / 4) * (4 - i);
      ctx.fillText(`${(val * 100).toFixed(0)}%`, pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    // Legend
    ctx.font = '8px "JetBrains Mono"';
    ctx.textAlign = 'left';
    let lx = pad.left + 4;
    const ly = pad.top + 10;
    ctx.fillStyle = '#b388ff20';
    ctx.fillRect(lx, ly - 5, 10, 10); lx += 14;
    ctx.fillStyle = '#8888a0';
    ctx.fillText('5th–95th pctile', lx, ly + 2); lx += 85;

    ctx.fillStyle = '#b388ff30';
    ctx.fillRect(lx, ly - 5, 10, 10); lx += 14;
    ctx.fillText('25th–75th', lx, ly + 2); lx += 62;

    ctx.strokeStyle = '#b388ff60';
    ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 10, ly); ctx.stroke();
    ctx.setLineDash([]);
    lx += 14;
    ctx.fillText('Median', lx, ly + 2); lx += 48;

    ctx.fillStyle = '#00d4ff';
    ctx.beginPath(); ctx.arc(lx + 3, ly - 1, 3, 0, 2 * Math.PI); ctx.fill();
    lx += 10;
    ctx.fillStyle = '#8888a0';
    ctx.fillText('Current HV', lx, ly + 2);

  }, [snapshot]);

  if (!snapshot?.volCone?.length || snapshot.volCone.length < 2) return null;

  // Determine where current IV sits relative to the cone
  const currentIV = snapshot.iv?.currentIV ?? 0;
  const hv20Cone = snapshot.volCone.find(c => c.window === 20);

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <span className="panel-title">Volatility Cone</span>
          <InfoTip text="The volatility cone (Sinclair, Ch. 4) shows the historical distribution of realized volatility at each measurement window (10d to 90d). The bands represent percentile ranges — if current HV (dots) is near the top, the stock has been unusually volatile recently. The dashed IV line shows where implied vol sits. When IV is ABOVE the 75th percentile band across most windows, options are rich — sell premium. When IV is BELOW the 25th percentile, options are cheap — buy premium." />
        </div>
        {hv20Cone && currentIV > 0 && (
          <span className={`badge ${currentIV > hv20Cone.p75 ? 'badge-red' : currentIV < hv20Cone.p25 ? 'badge-green' : 'badge-amber'}`}>
            IV {currentIV > hv20Cone.p75 ? 'Rich' : currentIV < hv20Cone.p25 ? 'Cheap' : 'Fair'}
          </span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-[240px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      {hv20Cone && currentIV > 0 && (
        <div className="px-4 py-2 border-t border-border/20 text-[11px] font-mono text-text-secondary">
          {currentIV > hv20Cone.p95
            ? 'IV is above the 95th percentile of historical realized vol — extreme overpricing. Strong statistical edge for vol sellers.'
            : currentIV > hv20Cone.p75
            ? 'IV is above the 75th percentile cone — options are historically expensive relative to how much this stock actually moves.'
            : currentIV < hv20Cone.p5
            ? 'IV is below the 5th percentile of realized vol — extremely cheap. Long vol positions (straddles, strangles) have historical edge.'
            : currentIV < hv20Cone.p25
            ? 'IV is below the 25th percentile cone — options are historically cheap. Favor long premium strategies.'
            : 'IV is within the normal range of the vol cone — no extreme mispricing detected.'}
        </div>
      )}
    </div>
  );
}
