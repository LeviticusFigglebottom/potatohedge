'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';
import type { StrikeExposure } from '@/lib/math/blackScholes';

// ─── Types ───────────────────────────────────────────────────────────

type MetricKey = 'netGEX' | 'netDEX' | 'netVanna' | 'netCharm';

interface PanelConfig {
  metric: MetricKey;
  label: string;
  unit: string;
}

const PANELS: PanelConfig[] = [
  { metric: 'netGEX', label: 'Gamma (GEX)', unit: '$γ' },
  { metric: 'netDEX', label: 'Delta (DEX)', unit: '$Δ' },
  { metric: 'netVanna', label: 'Vanna', unit: 'ν' },
  { metric: 'netCharm', label: 'Charm', unit: 'Θ_Δ' },
];

interface GridData {
  grid: number[][]; // [expIdx][strikeIdx]
  maxAbs: number;
}

// ─── Diverging colormap (blue ← dark → red) ─────────────────────────

function surfaceColor(t: number): [number, number, number] {
  // t: -1 to +1. Dark center, blue for positive, red/orange for negative.
  const c = Math.max(-1, Math.min(1, t));
  const a = Math.abs(c);

  if (c >= 0) {
    // Positive → cool blue
    return [
      Math.round(16 + 14 * a),
      Math.round(18 + 110 * a),
      Math.round(28 + 220 * a),
    ];
  } else {
    // Negative → warm red/orange
    return [
      Math.round(16 + 230 * a),
      Math.round(18 + 60 * a * (1 - a * 0.4)),
      Math.round(28 + 15 * a),
    ];
  }
}

// ─── Bilinear interpolation renderer ─────────────────────────────────

function renderSmoothSurface(
  grid: number[][],
  maxAbs: number,
  upW: number,
  upH: number,
): ImageData {
  const numExps = grid.length;
  const numStrikes = grid[0]?.length ?? 0;
  const imageData = new ImageData(upW, upH);

  if (numExps === 0 || numStrikes === 0) return imageData;

  for (let py = 0; py < upH; py++) {
    // Y-axis: top = highest strike, bottom = lowest strike
    const gy = (1 - py / (upH - 1)) * (numStrikes - 1);
    const y0 = Math.floor(gy), y1 = Math.min(y0 + 1, numStrikes - 1);
    const fy = gy - y0;

    for (let px = 0; px < upW; px++) {
      const gx = (px / (upW - 1)) * (numExps - 1);
      const x0 = Math.floor(gx), x1 = Math.min(x0 + 1, numExps - 1);
      const fx = gx - x0;

      // Bilinear interpolation
      const v00 = grid[x0][y0], v10 = grid[x1][y0];
      const v01 = grid[x0][y1], v11 = grid[x1][y1];
      const val = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
                  v01 * (1 - fx) * fy + v11 * fx * fy;

      const norm = maxAbs > 0 ? val / maxAbs : 0;
      const [r, g, b] = surfaceColor(norm);

      const idx = (py * upW + px) * 4;
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = 255;
    }
  }

  return imageData;
}

// ─── Single heatmap panel ────────────────────────────────────────────

interface HeatPanelProps {
  config: PanelConfig;
  gridData: GridData;
  strikes: number[];
  expirations: { date: string; dte: number }[];
  spot: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  hoveredStrike: number | null;
  onHoverStrike: (strike: number | null) => void;
  showYAxis: boolean; // only left panels show Y-axis
  showXAxis: boolean; // only bottom panels show X-axis
}

function HeatPanel({
  config, gridData, strikes, expirations, spot,
  gammaFlip, callWall, putWall,
  hoveredStrike, onHoverStrike, showYAxis, showXAxis,
}: HeatPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageCache = useRef<HTMLCanvasElement | null>(null);

  // Pre-render the interpolated surface image
  useEffect(() => {
    if (!gridData.grid.length || !gridData.grid[0]?.length) return;
    const upW = 256, upH = 256;
    const imgData = renderSmoothSurface(gridData.grid, gridData.maxAbs, upW, upH);
    const off = document.createElement('canvas');
    off.width = upW;
    off.height = upH;
    off.getContext('2d')!.putImageData(imgData, 0, 0);
    imageCache.current = off;
  }, [gridData]);

  // Draw to visible canvas
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || !imageCache.current) return;

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
      const pad = {
        top: 22,
        right: 42,
        bottom: showXAxis ? 34 : 8,
        left: showYAxis ? 52 : 8,
      };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      // Background
      ctx.fillStyle = '#0c0e14';
      ctx.fillRect(0, 0, w, h);

      // Draw smooth surface
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(imageCache.current!, pad.left, pad.top, cw, ch);

      // Panel border
      ctx.strokeStyle = '#1f293780';
      ctx.lineWidth = 1;
      ctx.strokeRect(pad.left, pad.top, cw, ch);

      const minS = strikes[0], maxS = strikes[strikes.length - 1];
      const sRange = maxS - minS || 1;
      const toY = (strike: number) => pad.top + ch - ((strike - minS) / sRange) * ch;
      const toX = (expIdx: number) => pad.left + (expIdx / Math.max(1, expirations.length - 1)) * cw;

      // Spot price horizontal line
      if (spot >= minS && spot <= maxS) {
        const sy = toY(spot);
        ctx.strokeStyle = '#ffffffcc';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, sy);
        ctx.lineTo(pad.left + cw, sy);
        ctx.stroke();
        ctx.setLineDash([]);
        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px "JetBrains Mono"';
        ctx.textAlign = 'right';
        ctx.fillText(`SPOT $${spot.toFixed(0)}`, pad.left + cw - 4, sy - 4);
      }

      // Key levels (subtle dashed lines)
      const drawLevel = (price: number | null, color: string, label: string) => {
        if (!price || price < minS || price > maxS) return;
        const ly = toY(price);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.left, ly);
        ctx.lineTo(pad.left + cw, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = '8px "JetBrains Mono"';
        ctx.textAlign = 'left';
        ctx.fillText(label, pad.left + 3, ly - 3);
      };

      if (config.metric === 'netGEX') {
        drawLevel(gammaFlip, '#ffaa00aa', 'γ FLIP');
        drawLevel(callWall, '#00e67680', 'CALL WALL');
        drawLevel(putWall, '#ff3d5780', 'PUT WALL');
      }

      // Hovered strike crosshair
      if (hoveredStrike !== null && hoveredStrike >= minS && hoveredStrike <= maxS) {
        const hy = toY(hoveredStrike);
        ctx.strokeStyle = '#ffffff40';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(pad.left, hy);
        ctx.lineTo(pad.left + cw, hy);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Y-axis labels (strikes) — show ~6 evenly spaced labels
      if (showYAxis) {
        const numLabels = 6;
        const labelEvery = Math.max(1, Math.floor(strikes.length / numLabels));
        ctx.fillStyle = '#6b7280';
        ctx.font = '9px "JetBrains Mono"';
        ctx.textAlign = 'right';
        for (let i = 0; i < strikes.length; i += labelEvery) {
          const y = toY(strikes[i]);
          ctx.fillText(`$${strikes[i].toFixed(0)}`, pad.left - 5, y + 3);
        }
        // Always label the last strike
        if (strikes.length > 1) {
          const lastY = toY(strikes[strikes.length - 1]);
          ctx.fillText(`$${strikes[strikes.length - 1].toFixed(0)}`, pad.left - 5, lastY + 3);
        }
      }

      // X-axis labels (expirations)
      if (showXAxis) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '9px "JetBrains Mono"';
        ctx.textAlign = 'center';
        expirations.forEach((exp, i) => {
          const x = toX(i);
          ctx.fillText(exp.date.slice(5), x, pad.top + ch + 14);
          ctx.fillStyle = '#555570';
          ctx.fillText(`${exp.dte}d`, x, pad.top + ch + 26);
          ctx.fillStyle = '#6b7280';
        });
      }

      // Panel title
      ctx.fillStyle = '#9ca3af';
      ctx.font = 'bold 10px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(config.label, pad.left + 4, pad.top - 6);

      // Color legend
      const legX = pad.left + cw + 6, legY = pad.top, legW = 8, legH = ch;
      const steps = 60;
      const stepH = legH / steps;
      for (let i = 0; i < steps; i++) {
        const t = 1 - (i / (steps - 1)) * 2;
        const [r, g, b] = surfaceColor(t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(legX, legY + i * stepH, legW, stepH + 0.5);
      }
      ctx.fillStyle = '#6b7280';
      ctx.font = '7px "JetBrains Mono"';
      ctx.textAlign = 'left';
      ctx.fillText(`+${abbreviate(gridData.maxAbs)}`, legX + legW + 2, legY + 6);
      ctx.fillText(`-${abbreviate(gridData.maxAbs)}`, legX + legW + 2, legY + legH);
    };

    draw();

    const obs = new ResizeObserver(draw);
    obs.observe(container);
    return () => obs.disconnect();
  }, [gridData, strikes, expirations, spot, gammaFlip, callWall, putWall,
      hoveredStrike, config, showYAxis, showXAxis]);

  // Mouse handler
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = canvas.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const pad = { top: 22, bottom: showXAxis ? 34 : 8 };
    const ch = rect.height - pad.top - pad.bottom;
    const frac = 1 - (my - pad.top) / ch;
    const minS = strikes[0], maxS = strikes[strikes.length - 1];
    const strike = minS + frac * (maxS - minS);
    // Snap to nearest strike
    let closest = strikes[0];
    let minDist = Infinity;
    for (const s of strikes) {
      const d = Math.abs(s - strike);
      if (d < minDist) { minDist = d; closest = s; }
    }
    onHoverStrike(closest);
  }, [strikes, onHoverStrike, showXAxis]);

  const handleMouseLeave = useCallback(() => onHoverStrike(null), [onHoverStrike]);

  return (
    <div ref={containerRef} className="relative min-h-[200px]">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  );
}

// ─── Positioning insights bar ────────────────────────────────────────

interface InsightsProps {
  hoveredStrike: number | null;
  strikes: number[];
  spot: number;
  aggregatedExposures: StrikeExposure[];
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
}

function PositioningInsights({
  hoveredStrike, strikes, spot, aggregatedExposures,
  gammaFlip, callWall, putWall,
}: InsightsProps) {
  if (!hoveredStrike) {
    // Default view: overall positioning summary
    const totalGEX = aggregatedExposures.reduce((s, e) => s + e.netGEX, 0);
    const regime = totalGEX >= 0 ? 'LONG' : 'SHORT';
    const regimeColor = totalGEX >= 0 ? 'text-blue-400' : 'text-red-400';
    const regimeBg = totalGEX >= 0 ? 'bg-blue-500/10' : 'bg-red-500/10';

    return (
      <div className={`px-4 py-3 border-t border-border/40 ${regimeBg}`}>
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`text-xs font-mono font-bold ${regimeColor}`}>
            {regime} GAMMA REGIME
          </span>
          <span className="text-xs text-text-muted font-mono">
            {totalGEX >= 0
              ? 'Dealer hedging dampens moves — range-bound, mean-reversion expected'
              : 'Dealer hedging amplifies moves — trending, breakout-prone regime'}
          </span>
        </div>
        <div className="flex gap-4 mt-2 text-[10px] font-mono text-text-muted flex-wrap">
          {gammaFlip && (
            <span>
              γ Flip: <span className="text-amber-400">{formatCurrency(gammaFlip)}</span>
              <span className="ml-1">({((gammaFlip - spot) / spot * 100).toFixed(1)}%)</span>
            </span>
          )}
          {callWall && (
            <span>
              Call Wall: <span className="text-green-400">{formatCurrency(callWall)}</span>
              <span className="ml-1">({((callWall - spot) / spot * 100).toFixed(1)}%)</span>
            </span>
          )}
          {putWall && (
            <span>
              Put Wall: <span className="text-red-400">{formatCurrency(putWall)}</span>
              <span className="ml-1">({((putWall - spot) / spot * 100).toFixed(1)}%)</span>
            </span>
          )}
          <span>
            Net GEX: <span className={totalGEX >= 0 ? 'text-blue-400' : 'text-red-400'}>
              {totalGEX >= 0 ? '+' : ''}{formatNumber(totalGEX)}
            </span>
          </span>
        </div>
        <div className="mt-2 text-[10px] font-mono text-text-muted/60">
          Hover over the surface to analyze positioning at specific price levels
        </div>
      </div>
    );
  }

  // Find exposure data at hovered strike
  const exp = aggregatedExposures.find(e => e.strike === hoveredStrike);
  const dist = ((hoveredStrike - spot) / spot * 100);
  const distLabel = dist > 0 ? `+${dist.toFixed(1)}%` : `${dist.toFixed(1)}%`;

  if (!exp) {
    return (
      <div className="px-4 py-3 border-t border-border/40">
        <span className="text-xs font-mono text-text-muted">
          ${hoveredStrike} ({distLabel} from spot) — No exposure data at this strike
        </span>
      </div>
    );
  }

  // Determine gamma regime at this strike
  const gammaRegime = exp.netGEX >= 0 ? 'LONG' : 'SHORT';
  const gammaColor = exp.netGEX >= 0 ? 'text-blue-400' : 'text-red-400';
  const gammaBg = exp.netGEX >= 0 ? 'bg-blue-500/8' : 'bg-red-500/8';

  // Build insight bullets
  const insights: string[] = [];

  // Gamma insight
  if (exp.netGEX >= 0) {
    insights.push(`Dealers are LONG gamma — price moves toward $${hoveredStrike} will be dampened (mean-reversion zone)`);
  } else {
    insights.push(`Dealers are SHORT gamma — price moves toward $${hoveredStrike} will be amplified (acceleration zone)`);
  }

  // Delta insight
  if (Math.abs(exp.netDEX) > 0) {
    const dexDir = exp.netDEX >= 0 ? 'long' : 'short';
    const hedge = exp.netDEX >= 0 ? 'sell to rebalance (downward pressure)' : 'buy to rebalance (upward pressure)';
    insights.push(`Net dealer delta is ${dexDir} ${formatNumber(Math.abs(exp.netDEX))} — dealers must ${hedge}`);
  }

  // Vanna insight
  if (Math.abs(exp.netVanna) > 0) {
    if (exp.netVanna > 0) {
      insights.push(`Positive vanna (${formatNumber(exp.netVanna)}) — if IV drops, dealers lose delta → must buy (supportive). If IV spikes, dealers sell (resistance)`);
    } else {
      insights.push(`Negative vanna (${formatNumber(exp.netVanna)}) — if IV drops, dealers gain delta → must sell (pressure). If IV spikes, dealers buy (supportive)`);
    }
  }

  // Charm insight
  if (Math.abs(exp.netCharm) > 0) {
    if (exp.netCharm > 0) {
      insights.push(`Positive charm — delta naturally increases with time here, building buying pressure into expiration`);
    } else {
      insights.push(`Negative charm — delta decays with time here, building selling pressure into expiration`);
    }
  }

  // Proximity insight
  if (gammaFlip && Math.abs(hoveredStrike - gammaFlip) / spot < 0.005) {
    insights.push('⚡ At the gamma flip — transitional zone where vol regime shifts. Expect increased volatility');
  }
  if (callWall && Math.abs(hoveredStrike - callWall) / spot < 0.005) {
    insights.push('🛑 At the call wall — maximum dealer gamma resistance. Strong ceiling, difficult to break above');
  }
  if (putWall && Math.abs(hoveredStrike - putWall) / spot < 0.005) {
    insights.push('🛑 At the put wall — maximum dealer gamma support. Strong floor, difficult to break below');
  }

  return (
    <div className={`px-4 py-3 border-t border-border/40 ${gammaBg}`}>
      <div className="flex items-center gap-3 mb-2">
        <span className="text-xs font-mono font-bold text-text-primary">
          ${hoveredStrike}
        </span>
        <span className={`text-[10px] font-mono ${dist >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {distLabel} from spot
        </span>
        <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${gammaBg} ${gammaColor}`}>
          {gammaRegime} γ
        </span>
      </div>
      <div className="flex gap-4 mb-2 text-[10px] font-mono flex-wrap">
        <span>GEX: <span className={exp.netGEX >= 0 ? 'text-blue-400' : 'text-red-400'}>{formatNumber(exp.netGEX)}</span></span>
        <span>DEX: <span className={exp.netDEX >= 0 ? 'text-cyan-400' : 'text-amber-400'}>{formatNumber(exp.netDEX)}</span></span>
        <span>Vanna: <span className="text-purple-400">{formatNumber(exp.netVanna)}</span></span>
        <span>Charm: <span className="text-text-secondary">{formatNumber(exp.netCharm)}</span></span>
      </div>
      <div className="space-y-1">
        {insights.map((text, i) => (
          <div key={i} className="text-[10px] font-mono text-text-muted leading-relaxed flex gap-1.5">
            <span className="text-text-muted/40 shrink-0">›</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────

export default function GammaHeatmap() {
  const { multiGEX, symbol } = useDashboardStore();
  const [hoveredStrike, setHoveredStrike] = useState<number | null>(null);

  // Pre-compute shared data
  const { strikes, grids, expirations } = useMemo(() => {
    if (!multiGEX?.perExpiration?.length) {
      return { strikes: [] as number[], grids: {} as Record<MetricKey, GridData>, expirations: [] as { date: string; dte: number }[] };
    }

    const spot = multiGEX.spotPrice;
    const exps = multiGEX.perExpiration;

    // Collect strikes near spot with actual exposure data
    // Use ±4% range, then further limit to ~40 strikes for readability
    const loBound = spot * 0.96;
    const hiBound = spot * 1.04;
    const allStrikes = new Set<number>();
    for (const exp of exps) {
      for (const e of exp.exposures) {
        if (e.strike >= loBound && e.strike <= hiBound) {
          allStrikes.add(e.strike);
        }
      }
    }
    let sortedStrikes = Array.from(allStrikes).sort((a, b) => a - b);

    // If still too many strikes, thin to ~40 evenly spaced around spot
    const MAX_STRIKES = 40;
    if (sortedStrikes.length > MAX_STRIKES) {
      const step = Math.ceil(sortedStrikes.length / MAX_STRIKES);
      // Always keep the strike nearest to spot
      const nearestIdx = sortedStrikes.reduce((best, s, i) =>
        Math.abs(s - spot) < Math.abs(sortedStrikes[best] - spot) ? i : best, 0);
      const thinned = new Set<number>();
      for (let i = 0; i < sortedStrikes.length; i += step) thinned.add(sortedStrikes[i]);
      thinned.add(sortedStrikes[nearestIdx]); // ensure spot-nearest is included
      thinned.add(sortedStrikes[sortedStrikes.length - 1]); // ensure top
      sortedStrikes = Array.from(thinned).sort((a, b) => a - b);
    }

    // Build index for fast lookup
    const strikeIndex = new Map<number, number>();
    sortedStrikes.forEach((s, i) => strikeIndex.set(s, i));

    // Build grids for each metric
    const metrics: MetricKey[] = ['netGEX', 'netDEX', 'netVanna', 'netCharm'];
    const result: Record<string, GridData> = {};

    for (const metric of metrics) {
      const grid: number[][] = [];
      let maxAbs = 0;

      for (const exp of exps) {
        const row = new Array(sortedStrikes.length).fill(0);
        for (const e of exp.exposures) {
          const idx = strikeIndex.get(e.strike);
          if (idx !== undefined) {
            row[idx] = e[metric];
            maxAbs = Math.max(maxAbs, Math.abs(e[metric]));
          }
        }
        grid.push(row);
      }

      result[metric] = { grid, maxAbs: maxAbs || 1 };
    }

    const expInfo = exps.map(e => ({ date: e.expiration, dte: e.dte }));

    return { strikes: sortedStrikes, grids: result as Record<MetricKey, GridData>, expirations: expInfo };
  }, [multiGEX]);

  const onHoverStrike = useCallback((s: number | null) => setHoveredStrike(s), []);

  if (!multiGEX?.perExpiration?.length || strikes.length === 0) {
    return (
      <div className="panel p-8 flex items-center justify-center">
        <span className="text-text-muted text-sm font-mono">No expiration data for exposure surface</span>
      </div>
    );
  }

  const spot = multiGEX.spotPrice;
  const { gammaFlip, callWall, putWall, exposures: aggregatedExposures } = multiGEX.aggregated;

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Exposure Surface — {symbol}</span>
        <span className="text-[10px] font-mono text-text-muted">
          {expirations.length} exp × {strikes.length} strikes | ${strikes[0]?.toFixed(0)}–${strikes[strikes.length - 1]?.toFixed(0)} (spot ${formatCurrency(spot)})
        </span>
      </div>

      {/* 2×2 heatmap grid */}
      <div className="grid grid-cols-2 gap-px bg-border/20">
        {PANELS.map((config, i) => (
          <HeatPanel
            key={config.metric}
            config={config}
            gridData={grids[config.metric]}
            strikes={strikes}
            expirations={expirations}
            spot={spot}
            gammaFlip={gammaFlip}
            callWall={callWall}
            putWall={putWall}
            hoveredStrike={hoveredStrike}
            onHoverStrike={onHoverStrike}
            showYAxis={i % 2 === 0}  // left panels
            showXAxis={i >= 2}        // bottom panels
          />
        ))}
      </div>

      {/* Positioning insights */}
      <PositioningInsights
        hoveredStrike={hoveredStrike}
        strikes={strikes}
        spot={spot}
        aggregatedExposures={aggregatedExposures}
        gammaFlip={gammaFlip}
        callWall={callWall}
        putWall={putWall}
      />
    </div>
  );
}

// ─── Utilities ───────────────────────────────────────────────────────

function abbreviate(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}
