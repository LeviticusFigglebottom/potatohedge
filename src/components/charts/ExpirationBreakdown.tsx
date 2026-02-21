'use client';

import { useEffect, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber } from '@/lib/utils/format';

/**
 * Grouped horizontal bar chart: GEX / Vanna / Charm per expiration.
 * Each metric gets ONE consistent color. Direction (left/right from zero)
 * indicates positive/negative. Limited to nearest 8 expirations for clarity.
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
      // Reserve space: top for legend, left for expiration labels
      const pad = { top: 28, right: 14, bottom: 10, left: 82 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, w, h);

      // Limit to 8 nearest expirations for readability
      const exps = multiGEX.perExpiration.slice(0, 8);

      const METRICS = [
        { key: 'totalGEX' as const, label: 'GEX', color: '#00e676' },
        { key: 'totalVanna' as const, label: 'Vanna', color: '#a855f7' },
        { key: 'totalCharm' as const, label: 'Charm', color: '#38bdf8' },
      ];

      // ── Legend at top ──
      let legX = pad.left;
      ctx.font = '9px "JetBrains Mono"';
      for (const m of METRICS) {
        ctx.fillStyle = m.color;
        ctx.fillRect(legX, 8, 10, 10);
        ctx.fillStyle = '#9ca3af';
        ctx.textAlign = 'left';
        ctx.fillText(m.label, legX + 14, 17);
        legX += ctx.measureText(m.label).width + 28;
      }

      // ── Scaling: find global max for normalization ──
      let globalMax = 1;
      for (const exp of exps) {
        for (const m of METRICS) {
          globalMax = Math.max(globalMax, Math.abs(exp[m.key]));
        }
      }

      // ── Layout: groups of 3 bars per expiration ──
      const groupGap = 8;
      const barGap = 2;
      const numMetrics = METRICS.length;
      const groupH = (ch - groupGap * (exps.length - 1)) / exps.length;
      const barH = Math.max(5, (groupH - barGap * (numMetrics - 1)) / numMetrics);
      const halfW = cw / 2;
      const zeroX = pad.left + halfW;

      // Zero line
      ctx.strokeStyle = '#ffffff18';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
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
        ctx.fillText(
          `${exp.expiration.slice(5)} (${exp.dte}d)`,
          pad.left - 6,
          groupY + groupH / 2 + 4,
        );

        for (let mi = 0; mi < numMetrics; mi++) {
          const m = METRICS[mi];
          const val = exp[m.key];
          const norm = val / globalMax; // -1 to +1
          const barLen = Math.abs(norm) * halfW;
          const barY = groupY + mi * (barH + barGap);
          const color = m.color;

          if (barLen < 1) continue;

          if (val >= 0) {
            // Right from center
            const grad = ctx.createLinearGradient(zeroX, 0, zeroX + barLen, 0);
            grad.addColorStop(0, hexAlpha(color, 0.35));
            grad.addColorStop(1, hexAlpha(color, 0.85));
            ctx.fillStyle = grad;
          } else {
            // Left from center
            const grad = ctx.createLinearGradient(zeroX - barLen, 0, zeroX, 0);
            grad.addColorStop(0, hexAlpha(color, 0.85));
            grad.addColorStop(1, hexAlpha(color, 0.35));
            ctx.fillStyle = grad;
          }

          ctx.beginPath();
          const bx = val >= 0 ? zeroX : zeroX - barLen;
          roundedRect(ctx, bx, barY, barLen, barH, 2);
          ctx.fill();

          // Value label beside bar
          if (barLen > 18) {
            const lx = val >= 0 ? zeroX + barLen + 4 : zeroX - barLen - 4;
            ctx.fillStyle = color;
            ctx.font = '8px "JetBrains Mono"';
            ctx.textAlign = val >= 0 ? 'left' : 'right';
            ctx.fillText(formatNumber(val), lx, barY + barH - 1);
          }
        }
      }
    };

    draw();

    const obs = new ResizeObserver(draw);
    obs.observe(container);
    return () => obs.disconnect();
  }, [multiGEX]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="panel-title">Exposure by Expiration — {symbol}</span>
      </div>
      <div ref={containerRef} className="relative flex-1 min-h-[180px]">
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

function hexAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
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
