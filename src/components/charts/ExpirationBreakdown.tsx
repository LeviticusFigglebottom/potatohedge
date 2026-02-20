'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber } from '@/lib/utils/format';

/**
 * Horizontal stacked bars showing GEX, Vanna, and Charm contribution
 * per expiration. Helps visualize which expirations dominate the
 * gamma/vanna/charm landscape — critical for anticipating pin risk
 * and expiration-driven vol changes.
 */
export default function ExpirationBreakdown() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { multiGEX, symbol } = useDashboardStore();

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !multiGEX?.perExpiration?.length) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.scale(dpr, dpr);

      const w = rect.width, h = rect.height;
      const pad = { top: 8, right: 14, bottom: 6, left: 78 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, w, h);

      const exps = multiGEX.perExpiration;
      const metrics = [
        { key: 'totalGEX' as const, label: 'GEX', posColor: '#00e676', negColor: '#ff3d57' },
        { key: 'totalVanna' as const, label: 'Vanna', posColor: '#a855f7', negColor: '#ff3d57' },
        { key: 'totalCharm' as const, label: 'Charm', posColor: '#00d4ff', negColor: '#a855f7' },
      ];

      const rowsPerExp = metrics.length;
      const totalRows = exps.length * rowsPerExp;
      const groupGap = 6;
      const barGap = 1;
      const groupH = (ch - groupGap * (exps.length - 1)) / exps.length;
      const barH = Math.max(4, (groupH - barGap * (rowsPerExp - 1)) / rowsPerExp);

      // Find max absolute value per metric for independent scaling
      const maxAbs: Record<string, number> = {};
      for (const m of metrics) {
        maxAbs[m.key] = Math.max(1, ...exps.map(e => Math.abs(e[m.key])));
      }

      // Zero line
      const zeroX = pad.left + cw / 2;
      ctx.strokeStyle = '#ffffff10';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(zeroX, pad.top);
      ctx.lineTo(zeroX, pad.top + ch);
      ctx.stroke();
      ctx.setLineDash([]);

      for (let ei = 0; ei < exps.length; ei++) {
        const exp = exps[ei];
        const groupY = pad.top + ei * (groupH + groupGap);

        // Expiration label
        ctx.fillStyle = '#9ca3af';
        ctx.font = '10px "JetBrains Mono"';
        ctx.textAlign = 'right';
        ctx.fillText(`${exp.expiration.slice(5)} (${exp.dte}d)`, pad.left - 6, groupY + groupH / 2 + 4);

        for (let mi = 0; mi < metrics.length; mi++) {
          const m = metrics[mi];
          const val = exp[m.key];
          const norm = val / maxAbs[m.key]; // -1 to +1
          const barY = groupY + mi * (barH + barGap);
          const barLen = Math.abs(norm) * (cw / 2);

          if (val >= 0) {
            // Bar extends right from center
            const gradient = ctx.createLinearGradient(zeroX, barY, zeroX + barLen, barY);
            gradient.addColorStop(0, hexToRgba(m.posColor, 0.3));
            gradient.addColorStop(1, hexToRgba(m.posColor, 0.8));
            ctx.fillStyle = gradient;
            ctx.beginPath();
            roundedRect(ctx, zeroX, barY, barLen, barH, 2);
            ctx.fill();
          } else {
            // Bar extends left from center
            const gradient = ctx.createLinearGradient(zeroX - barLen, barY, zeroX, barY);
            gradient.addColorStop(0, hexToRgba(m.negColor, 0.8));
            gradient.addColorStop(1, hexToRgba(m.negColor, 0.3));
            ctx.fillStyle = gradient;
            ctx.beginPath();
            roundedRect(ctx, zeroX - barLen, barY, barLen, barH, 2);
            ctx.fill();
          }

          // Value label on the bar
          const labelX = val >= 0 ? zeroX + barLen + 4 : zeroX - barLen - 4;
          ctx.fillStyle = val >= 0 ? m.posColor : m.negColor;
          ctx.font = '8px "JetBrains Mono"';
          ctx.textAlign = val >= 0 ? 'left' : 'right';
          if (barLen > 20) {
            ctx.fillText(formatNumber(val), labelX, barY + barH - 1);
          }
        }
      }

      // Metric legend at top-right
      const legX = w - 14;
      ctx.font = '8px "JetBrains Mono"';
      ctx.textAlign = 'right';
      metrics.forEach((m, i) => {
        ctx.fillStyle = m.posColor;
        ctx.fillRect(legX - 48, pad.top + i * 12, 6, 6);
        ctx.fillStyle = '#9ca3af';
        ctx.fillText(m.label, legX, pad.top + i * 12 + 7);
      });
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [multiGEX]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="panel-title">Exposure by Expiration — {symbol}</span>
      </div>
      <div ref={containerRef} className="relative flex-1 min-h-[160px]">
        {!multiGEX?.perExpiration?.length ? (
          <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm font-mono">
            No data
          </div>
        ) : (
          <canvas ref={canvasRef} className="w-full h-full" />
        )}
      </div>
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
