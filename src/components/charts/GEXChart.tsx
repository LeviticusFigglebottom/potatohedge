'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';

export default function GEXChart({ compact }: { compact?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { multiGEX, loading, symbol } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !multiGEX?.aggregated?.exposures) return;
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
    const pad = { top: 24, right: 55, bottom: 36, left: 16 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    const spot = multiGEX.spotPrice;
    const allExp = multiGEX.aggregated.exposures.filter(e => Math.abs(e.netGEX) > 0);
    if (allExp.length === 0) return;

    // Focus near spot ±8%
    const near = allExp.filter(e => e.strike >= spot * 0.92 && e.strike <= spot * 1.08);
    const data = near.length > 5 ? near : allExp;
    const maxAbs = Math.max(...data.map(e => Math.abs(e.netGEX)));
    const barW = Math.max(2, (cw / data.length) - 1.5);

    // Draw bars
    data.forEach((e, i) => {
      const x = pad.left + (i / data.length) * cw;
      const norm = e.netGEX / maxAbs;
      const barH = Math.abs(norm) * (ch / 2);
      const y = e.netGEX >= 0 ? pad.top + ch / 2 - barH : pad.top + ch / 2;

      const gradient = ctx.createLinearGradient(x, y, x, y + barH);
      if (e.netGEX >= 0) {
        gradient.addColorStop(0, '#00e67660');
        gradient.addColorStop(1, '#00e67618');
      } else {
        gradient.addColorStop(0, '#ff3d5718');
        gradient.addColorStop(1, '#ff3d5760');
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barW, barH);

      ctx.strokeStyle = e.netGEX >= 0 ? '#00e67650' : '#ff3d5750';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, barW, barH);
    });

    // Zero line
    ctx.strokeStyle = '#8888a020';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + ch / 2);
    ctx.lineTo(w - pad.right, pad.top + ch / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const minS = data[0].strike, maxS = data[data.length - 1].strike;
    const toX = (price: number) => pad.left + ((price - minS) / (maxS - minS)) * cw;

    // Spot line
    if (spot >= minS && spot <= maxS) {
      const sx = toX(spot);
      ctx.strokeStyle = '#00d4ff50';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(sx, pad.top); ctx.lineTo(sx, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#00d4ff';
      ctx.font = `${compact ? 9 : 10}px "JetBrains Mono"`;
      ctx.textAlign = 'center';
      ctx.fillText(`SPOT $${spot.toFixed(0)}`, sx, pad.top - 6);
    }

    // Gamma flip
    const gf = multiGEX.aggregated.gammaFlip;
    if (gf && gf >= minS && gf <= maxS) {
      const fx = toX(gf);
      ctx.strokeStyle = '#ffaa0070';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(fx, pad.top); ctx.lineTo(fx, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffaa00';
      ctx.font = `${compact ? 9 : 10}px "JetBrains Mono"`;
      ctx.textAlign = 'center';
      ctx.fillText(`γ FLIP $${gf.toFixed(0)}`, fx, h - pad.bottom + 12);
    }

    // Call wall
    const cwall = multiGEX.aggregated.callWall;
    if (cwall && cwall >= minS && cwall <= maxS) {
      const cx = toX(cwall);
      ctx.strokeStyle = '#00e67640';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(cx, pad.top); ctx.lineTo(cx, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Put wall
    const pwall = multiGEX.aggregated.putWall;
    if (pwall && pwall >= minS && pwall <= maxS) {
      const px = toX(pwall);
      ctx.strokeStyle = '#ff3d5740';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(px, pad.top); ctx.lineTo(px, h - pad.bottom); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Axis labels
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    ctx.fillText(`+${formatNumber(maxAbs)}`, w - 2, pad.top + 12);
    ctx.fillText(`-${formatNumber(maxAbs)}`, w - 2, h - pad.bottom - 5);

    const labelEvery = Math.max(1, Math.floor(data.length / 6));
    data.forEach((e, i) => {
      if (i % labelEvery === 0) {
        const x = pad.left + (i / data.length) * cw + barW / 2;
        ctx.fillStyle = '#555570';
        ctx.textAlign = 'center';
        ctx.fillText(`$${e.strike}`, x, h - pad.bottom + 24);
      }
    });
  }, [multiGEX, compact]);

  const gex = multiGEX?.aggregated;
  const nExp = multiGEX?.expirationsCovered?.length ?? 0;

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="panel-title">GEX Profile — {symbol}</span>
          {nExp > 0 && <span className="badge badge-cyan text-[10px]">{nExp} exp</span>}
        </div>
        {gex && (
          <span className={`badge ${gex.totalGEX >= 0 ? 'badge-green' : 'badge-red'}`}>
            Net: {gex.totalGEX >= 0 ? '+' : ''}{formatNumber(gex.totalGEX)}
          </span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-[220px] relative">
        {loading.multiGEX && !multiGEX ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 text-text-muted text-sm font-mono">
              <div className="w-4 h-4 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
              Computing multi-exp GEX...
            </div>
          </div>
        ) : !multiGEX?.aggregated ? (
          <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm font-mono">Loading...</div>
        ) : (
          <canvas ref={canvasRef} className="w-full h-full" />
        )}
      </div>
      {gex && (
        <div className="px-4 py-2 border-t border-border flex flex-wrap gap-4 text-xs font-mono">
          {gex.gammaFlip !== null && <div><span className="text-text-muted">γ Flip: </span><span className="text-accent-amber font-medium">{formatCurrency(gex.gammaFlip)}</span></div>}
          {gex.callWall !== null && <div><span className="text-text-muted">Call Wall: </span><span className="text-accent-green font-medium">{formatCurrency(gex.callWall)}</span></div>}
          {gex.putWall !== null && <div><span className="text-text-muted">Put Wall: </span><span className="text-accent-red font-medium">{formatCurrency(gex.putWall)}</span></div>}
        </div>
      )}
    </div>
  );
}
