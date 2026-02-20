'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber } from '@/lib/utils/format';

type MetricKey = 'netGEX' | 'netDEX' | 'netVanna' | 'netCharm';

const METRIC_LABELS: Record<MetricKey, string> = {
  netGEX: 'Gamma (GEX)',
  netDEX: 'Delta (DEX)',
  netVanna: 'Vanna',
  netCharm: 'Charm',
};

const METRIC_COLORS: Record<MetricKey, { pos: string; neg: string }> = {
  netGEX: { pos: '0, 230, 118', neg: '255, 61, 87' },     // green / red
  netDEX: { pos: '0, 212, 255', neg: '255, 170, 0' },     // cyan / amber
  netVanna: { pos: '168, 85, 247', neg: '255, 61, 87' },   // purple / red
  netCharm: { pos: '0, 212, 255', neg: '168, 85, 247' },   // cyan / purple
};

interface CellInfo {
  strike: number;
  expiration: string;
  dte: number;
  value: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function GammaHeatmap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const cellMapRef = useRef<CellInfo[]>([]);
  const { multiGEX, symbol } = useDashboardStore();
  const [metric, setMetric] = useState<MetricKey>('netGEX');
  const [hoveredCell, setHoveredCell] = useState<CellInfo | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

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
      const pad = { top: 10, right: 56, bottom: 40, left: 78 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      // Background
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, w, h);

      const spot = multiGEX.spotPrice;
      const exps = multiGEX.perExpiration;

      // Get all unique strikes within ±8% of spot across all expirations
      const allStrikes = new Set<number>();
      for (const exp of exps) {
        for (const e of exp.exposures) {
          if (e.strike >= spot * 0.92 && e.strike <= spot * 1.08) {
            allStrikes.add(e.strike);
          }
        }
      }
      const strikes = Array.from(allStrikes).sort((a, b) => a - b);
      if (strikes.length === 0 || exps.length === 0) return;

      // Build value matrix and find max absolute value for color normalization
      let maxAbs = 0;
      const matrix = new Map<string, number>();
      for (const exp of exps) {
        for (const e of exp.exposures) {
          if (!allStrikes.has(e.strike)) continue;
          const key = `${exp.expiration}:${e.strike}`;
          const val = e[metric];
          matrix.set(key, val);
          maxAbs = Math.max(maxAbs, Math.abs(val));
        }
      }
      if (maxAbs === 0) maxAbs = 1;

      const cellW = cw / strikes.length;
      const cellH = ch / exps.length;
      const colors = METRIC_COLORS[metric];

      // Store cell info for hover detection
      const cells: CellInfo[] = [];

      // Draw cells — nearest expiration at bottom
      for (let row = 0; row < exps.length; row++) {
        const exp = exps[row];
        const yIdx = exps.length - 1 - row;
        const y = pad.top + yIdx * cellH;

        for (let col = 0; col < strikes.length; col++) {
          const strike = strikes[col];
          const x = pad.left + col * cellW;
          const key = `${exp.expiration}:${strike}`;
          const val = matrix.get(key) ?? 0;
          const norm = val / maxAbs; // -1 to +1
          const abs = Math.min(1, Math.abs(norm));
          const alpha = 0.06 + abs * 0.88;
          const rgb = norm >= 0 ? colors.pos : colors.neg;

          ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
          ctx.fillRect(x, y, cellW - 0.5, cellH - 0.5);

          cells.push({ strike, expiration: exp.expiration, dte: exp.dte, value: val, x, y, w: cellW, h: cellH });
        }
      }
      cellMapRef.current = cells;

      // Spot price vertical line
      const minS = strikes[0], maxS = strikes[strikes.length - 1];
      if (spot >= minS && spot <= maxS) {
        const frac = (spot - minS) / (maxS - minS);
        const sx = pad.left + frac * cw;
        ctx.strokeStyle = '#00d4ffaa';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.beginPath();
        ctx.moveTo(sx, pad.top);
        ctx.lineTo(sx, pad.top + ch);
        ctx.stroke();
        ctx.setLineDash([]);
        // Label
        ctx.fillStyle = '#00d4ff';
        ctx.font = '10px "JetBrains Mono"';
        ctx.textAlign = 'center';
        ctx.fillText(`SPOT $${spot.toFixed(0)}`, sx, pad.top + ch + 12);
      }

      // Gamma flip vertical line (only for GEX metric)
      if (metric === 'netGEX') {
        const gf = multiGEX.aggregated.gammaFlip;
        if (gf && gf >= minS && gf <= maxS) {
          const frac = (gf - minS) / (maxS - minS);
          const gfX = pad.left + frac * cw;
          ctx.strokeStyle = '#ffaa0070';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(gfX, pad.top);
          ctx.lineTo(gfX, pad.top + ch);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#ffaa00';
          ctx.font = '9px "JetBrains Mono"';
          ctx.textAlign = 'center';
          ctx.fillText(`FLIP`, gfX, pad.top + ch + 24);
        }
      }

      // Y-axis labels (expirations) — nearest at bottom
      ctx.fillStyle = '#9ca3af';
      ctx.font = '10px "JetBrains Mono"';
      ctx.textAlign = 'right';
      for (let row = 0; row < exps.length; row++) {
        const yIdx = exps.length - 1 - row;
        const y = pad.top + yIdx * cellH + cellH / 2 + 4;
        const label = `${exps[row].expiration.slice(5)} (${exps[row].dte}d)`;
        ctx.fillText(label, pad.left - 6, y);
      }

      // X-axis labels (strikes)
      const labelEvery = Math.max(1, Math.floor(strikes.length / 8));
      ctx.textAlign = 'center';
      ctx.fillStyle = '#555570';
      ctx.font = '9px "JetBrains Mono"';
      for (let i = 0; i < strikes.length; i += labelEvery) {
        const x = pad.left + i * cellW + cellW / 2;
        ctx.fillText(`$${strikes[i]}`, x, pad.top + ch + 28);
      }

      // Color legend bar
      const legX = w - 48, legY = pad.top, legW = 10, legH = ch;
      const steps = 40;
      const stepH = legH / steps;
      for (let i = 0; i < steps; i++) {
        const norm = 1 - (i / (steps - 1)) * 2;
        const abs = Math.min(1, Math.abs(norm));
        const alpha = 0.06 + abs * 0.88;
        const rgb = norm >= 0 ? colors.pos : colors.neg;
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        ctx.fillRect(legX, legY + i * stepH, legW, stepH + 0.5);
      }
      ctx.fillStyle = '#9ca3af';
      ctx.font = '8px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`+${abbreviate(maxAbs)}`, legX + legW + 3, legY + 8);
      ctx.fillText('0', legX + legW + 3, legY + legH / 2 + 3);
      ctx.fillText(`-${abbreviate(maxAbs)}`, legX + legW + 3, legY + legH - 2);
    };

    draw();

    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [multiGEX, metric]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cell = cellMapRef.current.find(c =>
      mx >= c.x && mx < c.x + c.w && my >= c.y && my < c.y + c.h
    );
    setHoveredCell(cell ?? null);
    setTooltipPos({ x: mx + 14, y: my - 8 });
  }, []);

  const handleMouseLeave = useCallback(() => setHoveredCell(null), []);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span className="panel-title">Exposure Heatmap — {symbol}</span>
        <div className="flex gap-1">
          {(Object.keys(METRIC_LABELS) as MetricKey[]).map(k => (
            <button
              key={k}
              onClick={() => setMetric(k)}
              className={`text-[10px] px-2 py-0.5 rounded font-mono transition-colors ${
                metric === k
                  ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                  : 'text-text-muted hover:text-text-secondary border border-transparent'
              }`}
            >
              {METRIC_LABELS[k]}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="relative flex-1 min-h-[280px]">
        {!multiGEX?.perExpiration?.length ? (
          <div className="absolute inset-0 flex items-center justify-center text-text-muted text-sm font-mono">
            No expiration data
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="w-full h-full cursor-crosshair"
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            />
            {hoveredCell && (
              <div
                ref={tooltipRef}
                className="absolute pointer-events-none z-10 bg-bg-primary/95 border border-border rounded-lg px-3 py-2 text-xs font-mono shadow-xl backdrop-blur-sm"
                style={{ left: tooltipPos.x, top: tooltipPos.y }}
              >
                <div className="text-text-secondary mb-1">
                  <span className="text-accent-cyan font-semibold">${hoveredCell.strike}</span>
                  {' — '}
                  <span>{hoveredCell.expiration.slice(5)}</span>
                  <span className="text-text-muted"> ({hoveredCell.dte}d)</span>
                </div>
                <div className={hoveredCell.value >= 0 ? 'text-accent-green font-semibold' : 'text-accent-red font-semibold'}>
                  {METRIC_LABELS[metric]}: {hoveredCell.value >= 0 ? '+' : ''}{formatNumber(hoveredCell.value)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function abbreviate(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
