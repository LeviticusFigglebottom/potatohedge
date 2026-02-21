'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import InfoTip from './InfoTip';

/** Map 0..1 to a blue→cyan→green→yellow→red color for dark backgrounds */
function ivColor(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  if (t < 0.25) {
    const s = t / 0.25;
    return [30 + s * (-30), 50 + s * 150, 180 + s * 40];
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return [0, 200 + s * 30, 220 - s * 140];
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return [s * 220, 230 - s * 30, 80 - s * 60];
  } else {
    const s = (t - 0.75) / 0.25;
    return [220 + s * 35, 200 - s * 150, 20 - s * 20];
  }
}

export default function VolSurface() {
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
    const pad = { top: 20, right: 70, bottom: 40, left: 55 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const spot = snapshot.spotPrice;
    const exps = snapshot.skewSurface.filter(e => e.dte >= 2 && e.dte <= 180);
    if (exps.length < 2) return;

    // Collect all IV values for color scale
    const allIVs: number[] = [];
    for (const exp of exps) {
      for (const p of exp.points) allIVs.push(p.iv);
    }
    if (allIVs.length < 5) return;
    allIVs.sort((a, b) => a - b);
    const minIV = allIVs[Math.floor(allIVs.length * 0.03)];
    const maxIV = allIVs[Math.floor(allIVs.length * 0.97)];
    const ivRange = maxIV - minIV || 0.01;

    // Grid: X = moneyness (-10% to +10%), Y = DTE
    const moneyMin = -0.10, moneyMax = 0.10;
    const dteMin = 0, dteMax = Math.min(180, Math.max(...exps.map(e => e.dte)) * 1.1);

    const gridW = Math.min(120, Math.floor(cw / 3));
    const gridH = Math.min(60, Math.floor(ch / 3));

    const toX = (m: number) => pad.left + ((m - moneyMin) / (moneyMax - moneyMin)) * cw;
    const toY = (dte: number) => pad.top + ch - ((dte - dteMin) / (dteMax - dteMin)) * ch;

    // Build flat list of all data points as (moneyness, dte, iv)
    const pts: { m: number; dte: number; iv: number }[] = [];
    for (const exp of exps) {
      for (const p of exp.points) {
        const m = (p.strike - spot) / spot;
        if (m >= moneyMin && m <= moneyMax) {
          pts.push({ m, dte: exp.dte, iv: p.iv });
        }
      }
    }
    if (pts.length < 5) return;

    // Render heatmap using IDW interpolation
    const cellW = cw / gridW;
    const cellH = ch / gridH;

    for (let gx = 0; gx < gridW; gx++) {
      for (let gy = 0; gy < gridH; gy++) {
        const m = moneyMin + (gx + 0.5) / gridW * (moneyMax - moneyMin);
        const dte = dteMin + (gy + 0.5) / gridH * (dteMax - dteMin);

        // IDW: inverse distance weighted average of nearby points
        let wSum = 0, ivSum = 0;
        const mScale = (moneyMax - moneyMin); // normalize distances
        const dteScale = (dteMax - dteMin);

        for (const p of pts) {
          const dm = (p.m - m) / mScale;
          const dd = (p.dte - dte) / dteScale;
          const dist2 = dm * dm + dd * dd;
          if (dist2 < 0.001) { wSum = 1; ivSum = p.iv; break; } // exact match
          const weight = 1 / (dist2 * dist2); // IDW power=4 for sharper locality
          wSum += weight;
          ivSum += p.iv * weight;
        }

        if (wSum === 0) continue;
        const interpIV = ivSum / wSum;
        const t = (interpIV - minIV) / ivRange;
        const [r, g, b] = ivColor(t);

        ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
        const px = pad.left + gx * cellW;
        const py = pad.top + ch - (gy + 1) * cellH;
        ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
      }
    }

    // ATM line (moneyness = 0)
    const atmX = toX(0);
    ctx.strokeStyle = '#e8e8ef30';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(atmX, pad.top); ctx.lineTo(atmX, pad.top + ch); ctx.stroke();
    ctx.setLineDash([]);

    // Expiration markers on right
    ctx.fillStyle = '#8888a0';
    ctx.font = '8px "JetBrains Mono"';
    ctx.textAlign = 'left';
    for (const exp of exps) {
      const y = toY(exp.dte);
      if (y >= pad.top && y <= pad.top + ch) {
        ctx.strokeStyle = '#8888a020';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
        ctx.fillText(`${exp.dte}d`, w - pad.right + 4, y + 3);
      }
    }

    // X axis labels (moneyness)
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'center';
    for (let m = -10; m <= 10; m += 5) {
      const x = toX(m / 100);
      ctx.fillText(m === 0 ? 'ATM' : `${m > 0 ? '+' : ''}${m}%`, x, h - pad.bottom + 14);
    }

    // Y axis labels (DTE)
    ctx.textAlign = 'right';
    const dteSteps = [7, 14, 30, 60, 90, 120, 180].filter(d => d <= dteMax);
    for (const d of dteSteps) {
      const y = toY(d);
      if (y >= pad.top && y <= pad.top + ch) {
        ctx.fillText(`${d}d`, pad.left - 5, y + 3);
      }
    }

    // Color legend bar on right
    const barX = w - 16, barW = 8, barTop = pad.top, barH = ch;
    for (let i = 0; i < barH; i++) {
      const t = 1 - i / barH;
      const [r, g, b] = ivColor(t);
      ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
      ctx.fillRect(barX, barTop + i, barW, 1.5);
    }
    ctx.fillStyle = '#555570';
    ctx.font = '7px "JetBrains Mono"';
    ctx.textAlign = 'left';
    ctx.fillText(`${(maxIV * 100).toFixed(0)}%`, barX - 1, barTop - 3);
    ctx.fillText(`${(minIV * 100).toFixed(0)}%`, barX - 1, barTop + barH + 8);

    // Title overlays
    ctx.font = '8px "JetBrains Mono"';
    ctx.fillStyle = '#8888a060';
    ctx.textAlign = 'left';
    ctx.fillText('← OTM Puts', pad.left + 4, pad.top + ch - 4);
    ctx.textAlign = 'right';
    ctx.fillText('OTM Calls →', w - pad.right - 4, pad.top + ch - 4);

  }, [snapshot]);

  if (!snapshot?.skewSurface?.length || snapshot.skewSurface.length < 2) {
    return null;
  }

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-1.5">
          <span className="panel-title">Implied Volatility Surface</span>
          <InfoTip text="The IV surface shows implied volatility across strikes (x-axis, as moneyness) and expirations (y-axis, DTE). Hot colors = high IV, cool colors = low IV. The 'smile' or 'smirk' shape reveals how the market prices tail risk. Steep put-side gradient = expensive downside protection. Flat surface = uniform vol expectations. Use this to identify relative value: sell where IV is locally high, buy where it's low (Sinclair, Ch. 6: Trading the Surface)." />
        </div>
        <span className="badge badge-purple">
          {snapshot.skewSurface.filter(e => e.dte >= 2 && e.dte <= 180).length} expirations
        </span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-[280px]">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}
