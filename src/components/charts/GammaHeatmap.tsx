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
  grid: number[][];      // [expIdx][strikeIdx] — raw values, clipped for absolute mode
  gridNorm: number[][];  // [expIdx][strikeIdx] — per-column normalized to [-1, 1]
  maxAbs: number;        // ramp scale for absolute mode (post-clip)
}

// ─── Color normalization mode ────────────────────────────────────────
//
// 'absolute'   — single color scale across the whole grid. Good for
//                "where's the literal biggest GEX". Pin-day 0DTE columns
//                can blow out the ramp; we clip outliers to OUTLIER_CLIP_K×
//                the median column-max so other columns stay visible.
// 'per-column' — each expiry column normalized to its own [-1, 1]. Good
//                for "where's the wall structure at this expiry" and is
//                what you want for pocket detection. Loses cross-expiry
//                magnitude comparability.

export type ColorMode = 'absolute' | 'per-column';

const COLOR_MODE_OPTIONS: { mode: ColorMode; label: string }[] = [
  { mode: 'absolute', label: 'absolute' },
  { mode: 'per-column', label: 'per-col' },
];

/** Outlier-clip factor for the absolute ramp: column maxes >K× the median
 *  of all column maxes get clipped so a single 0DTE pin column doesn't
 *  dominate the entire colormap. 5× is empirically conservative — a real
 *  outlier still saturates the ramp, but other columns stay readable. */
const OUTLIER_CLIP_K = 5;

// ─── X-axis scale transforms ─────────────────────────────────────────
//
// Linear DTE compresses the 0-7d region you actually trade and balloons
// the 30d region you want as context. sqrt(DTE) maps cleanly:
//   DTE  0  →  0,   1 → 1.00,   3 → 1.73,   7 → 2.65,
//        14 → 3.74, 30 → 5.48, 45 → 6.71
// log(1+DTE) is even more aggressive on the near end if you want to
// inspect 0DTE/1DTE structure separately from the rest.

export type XScaleMode = 'linear' | 'sqrt' | 'log';

const X_SCALE_OPTIONS: { mode: XScaleMode; label: string }[] = [
  { mode: 'linear', label: 'DTE' },
  { mode: 'sqrt', label: '√DTE' },
  { mode: 'log', label: 'log(1+DTE)' },
];

/** Map a DTE value to its position on the canvas (0..1). */
function xTransform(mode: XScaleMode, dte: number, maxDTE: number): number {
  const d = Math.max(0, dte);
  const m = Math.max(1, maxDTE);
  if (mode === 'sqrt') return Math.sqrt(d) / Math.sqrt(m);
  if (mode === 'log') return Math.log(1 + d) / Math.log(1 + m);
  return d / m;
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
  expirations: { dte: number }[],
  xMode: XScaleMode,
  maxAbs: number,
  upW: number,
  upH: number,
): ImageData {
  const numExps = grid.length;
  const numStrikes = grid[0]?.length ?? 0;
  const imageData = new ImageData(upW, upH);

  if (numExps === 0 || numStrikes === 0) return imageData;

  // Precompute each column's transformed canvas position [0,1] using the
  // chosen x-axis scale. When xMode='linear' this falls back to evenly
  // spaced columns (the previous behavior) IF all expirations are evenly
  // DTE-spaced — for actual SPY chains they aren't, so even 'linear' here
  // is now strictly DTE-proportional rather than index-proportional. That
  // intentionally fixes a subtle bug where the previous renderer treated
  // a 3-day gap between two expiries as visually identical to a 7-day gap.
  const maxDTE = Math.max(1, expirations[numExps - 1]?.dte ?? 1);
  const colT: number[] = expirations.map((e) => xTransform(xMode, e.dte, maxDTE));

  // Binary-search-style bracketing helper. Returns [i0, i1, fx] such that
  // colT[i0] <= t <= colT[i1] and fx is the fractional position within
  // that span. Linear scan is fine here — numExps is at most ~15.
  const bracket = (t: number): [number, number, number] => {
    if (t <= colT[0]) return [0, 0, 0];
    if (t >= colT[numExps - 1]) return [numExps - 1, numExps - 1, 0];
    let i0 = 0;
    for (let i = 0; i < numExps - 1; i++) {
      if (colT[i] <= t && t <= colT[i + 1]) { i0 = i; break; }
    }
    const i1 = i0 + 1;
    const span = colT[i1] - colT[i0] || 1e-9;
    return [i0, i1, (t - colT[i0]) / span];
  };

  for (let py = 0; py < upH; py++) {
    // Y-axis: top = highest strike, bottom = lowest strike
    const gy = (1 - py / (upH - 1)) * (numStrikes - 1);
    const y0 = Math.floor(gy), y1 = Math.min(y0 + 1, numStrikes - 1);
    const fy = gy - y0;

    for (let px = 0; px < upW; px++) {
      const t = px / (upW - 1);
      const [x0, x1, fx] = bracket(t);

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
  xMode: XScaleMode;
  colorMode: ColorMode;
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
  config, gridData, strikes, expirations, xMode, colorMode, spot,
  gammaFlip, callWall, putWall,
  hoveredStrike, onHoverStrike, showYAxis, showXAxis,
}: HeatPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageCache = useRef<HTMLCanvasElement | null>(null);

  // Pre-render the interpolated surface image.
  // In per-column mode the input grid is already normalized to [-1, 1]
  // per column, so we pass maxAbs=1; in absolute mode the grid carries
  // raw (outlier-clipped) values and the ramp scale is gridData.maxAbs.
  useEffect(() => {
    const sourceGrid = colorMode === 'per-column' ? gridData.gridNorm : gridData.grid;
    if (!sourceGrid.length || !sourceGrid[0]?.length) return;
    const upW = 256, upH = 256;
    const rampMaxAbs = colorMode === 'per-column' ? 1 : gridData.maxAbs;
    const imgData = renderSmoothSurface(sourceGrid, expirations, xMode, rampMaxAbs, upW, upH);
    const off = document.createElement('canvas');
    off.width = upW;
    off.height = upH;
    off.getContext('2d')!.putImageData(imgData, 0, 0);
    imageCache.current = off;
  }, [gridData, expirations, xMode, colorMode]);

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
        bottom: showXAxis ? 42 : 8,
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
      // X position uses the chosen scale transform on the column's DTE, so
      // labels and tick marks land at the same place the surface bitmap
      // rendered them.
      const maxDTE = Math.max(1, expirations[expirations.length - 1]?.dte ?? 1);
      const toX = (expIdx: number) => pad.left + xTransform(xMode, expirations[expIdx]?.dte ?? 0, maxDTE) * cw;

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

      // Key levels (subtle dashed lines). Wall labels anchor inboard
      // (pad.left + 60) instead of at the plot's left edge — with the
      // densified Y-axis (~31 strikes after the chain widening in PR1
      // commit 1) the strike-price labels in the left gutter were
      // visually colliding with the wall callouts at pad.left + 3.
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
        ctx.fillText(label, pad.left + 60, ly - 3);
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

      // Y-axis: strike price labels — show ~6 evenly spaced
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
        // Rotated Y-axis title
        ctx.save();
        ctx.fillStyle = '#4b5563';
        ctx.font = '8px "JetBrains Mono"';
        ctx.textAlign = 'center';
        ctx.translate(8, pad.top + ch / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('STRIKE PRICE', 0, 0);
        ctx.restore();
      }

      // X-axis: expiration date labels
      if (showXAxis) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '9px "JetBrains Mono"';
        ctx.textAlign = 'center';
        // Minimum-pixel-separation thinning. The sqrt(DTE) x-axis can
        // place two adjacent expirations <15px apart (e.g. 7d & 9d, or
        // 35d & 37d) — index-based xStep thinning (the old behavior)
        // didn't account for that and produced overlapping labels like
        // "35d37d". Walk left-to-right and drop any label whose
        // pixel-position is within MIN_LABEL_GAP_PX of the last drawn
        // one. Always keep first + last; if last is too close to the
        // previous kept label, drop that previous one and keep last.
        const MIN_LABEL_GAP_PX = 28;
        const keep = new Set<number>();
        let lastX = -Infinity;
        for (let i = 0; i < expirations.length; i++) {
          const x = toX(i);
          if (i === 0 || x - lastX >= MIN_LABEL_GAP_PX) {
            keep.add(i);
            lastX = x;
          }
        }
        const lastIdx = expirations.length - 1;
        if (lastIdx >= 0 && !keep.has(lastIdx)) {
          const lastXC = toX(lastIdx);
          // Sweep back and remove any kept labels within the gap of the
          // forced-last so we don't render an overlap on the right edge.
          for (let i = lastIdx - 1; i >= 0; i--) {
            if (!keep.has(i)) continue;
            if (lastXC - toX(i) < MIN_LABEL_GAP_PX) keep.delete(i);
            else break;
          }
          keep.add(lastIdx);
        }
        expirations.forEach((exp, i) => {
          if (!keep.has(i)) return;
          const x = toX(i);
          ctx.fillStyle = '#6b7280';
          ctx.fillText(exp.date.slice(5), x, pad.top + ch + 14);
          ctx.fillStyle = '#555570';
          ctx.fillText(`${exp.dte}d`, x, pad.top + ch + 26);
        });
        // X-axis title
        ctx.fillStyle = '#4b5563';
        ctx.font = '8px "JetBrains Mono"';
        ctx.textAlign = 'center';
        ctx.fillText('EXPIRATION', pad.left + cw / 2, pad.top + ch + 34);
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
      if (colorMode === 'per-column') {
        // Per-column ramp is unitless; labels show z-direction not magnitude.
        ctx.fillText('+col max', legX + legW + 2, legY + 6);
        ctx.fillText('-col max', legX + legW + 2, legY + legH);
      } else {
        ctx.fillText(`+${abbreviate(gridData.maxAbs)}`, legX + legW + 2, legY + 6);
        ctx.fillText(`-${abbreviate(gridData.maxAbs)}`, legX + legW + 2, legY + legH);
      }
    };

    draw();

    const obs = new ResizeObserver(draw);
    obs.observe(container);
    return () => obs.disconnect();
  }, [gridData, strikes, expirations, xMode, colorMode, spot, gammaFlip, callWall, putWall,
      hoveredStrike, config, showYAxis, showXAxis]);

  // Mouse handler
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = canvas.getBoundingClientRect();
    const my = e.clientY - rect.top;
    const pad = { top: 22, bottom: showXAxis ? 42 : 8 };
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
  // Default to sqrt(DTE) per the extended-surface spec — near-dated detail
  // gets ~32% of the canvas, 7-30d gets ~50%, 30-45d the tail ~18%.
  const [xMode, setXMode] = useState<XScaleMode>('sqrt');
  // Default to per-column for the pocket-detection use case: structure
  // per expiry is the actionable signal; absolute mode is the toggle for
  // "where's the literal biggest GEX" overall positioning checks.
  const [colorMode, setColorMode] = useState<ColorMode>('per-column');

  // Pre-compute shared data
  const { strikes, grids, expirations } = useMemo(() => {
    if (!multiGEX?.perExpiration?.length) {
      return { strikes: [] as number[], grids: {} as Record<MetricKey, GridData>, expirations: [] as { date: string; dte: number }[] };
      // (return early when no data; below returns the populated tensor)
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

    // Build grids for each metric. For each metric we produce TWO grids:
    //   `grid`     — raw values with outlier-clip applied (absolute mode)
    //   `gridNorm` — each column normalized to [-1, 1] (per-column mode)
    // and `maxAbs` is the post-clip global max for the absolute ramp.
    const metrics: MetricKey[] = ['netGEX', 'netDEX', 'netVanna', 'netCharm'];
    const result: Record<string, GridData> = {};

    const median = (arr: number[]): number => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };

    for (const metric of metrics) {
      // First pass — collect raw values and per-column maxes
      const raw: number[][] = [];
      const colMaxes: number[] = [];
      for (const exp of exps) {
        const row = new Array(sortedStrikes.length).fill(0);
        let colMax = 0;
        for (const e of exp.exposures) {
          const idx = strikeIndex.get(e.strike);
          if (idx !== undefined) {
            row[idx] = e[metric];
            colMax = Math.max(colMax, Math.abs(e[metric]));
          }
        }
        raw.push(row);
        colMaxes.push(colMax);
      }

      // Outlier clip for absolute mode: any column whose max exceeds
      // OUTLIER_CLIP_K × median(colMaxes) gets its cell magnitudes clamped
      // so 0DTE pin columns don't dominate the colormap. Only applied to
      // `grid` (absolute); `gridNorm` is unaffected because per-column
      // normalization already isolates each column's dynamic range.
      const medianCol = median(colMaxes.filter((m) => m > 0));
      const ceiling = medianCol > 0 ? medianCol * OUTLIER_CLIP_K : Infinity;
      const grid: number[][] = raw.map((row) =>
        row.map((v) => (Math.abs(v) > ceiling ? Math.sign(v) * ceiling : v)),
      );
      const maxAbs = grid.reduce(
        (m, row) => row.reduce((mm, v) => Math.max(mm, Math.abs(v)), m),
        0,
      ) || 1;

      // Per-column normalization for per-column mode.
      const gridNorm: number[][] = raw.map((row, ci) => {
        const cm = colMaxes[ci];
        return cm > 0 ? row.map((v) => v / cm) : row.map(() => 0);
      });

      result[metric] = { grid, gridNorm, maxAbs };
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
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1 text-[10px] font-mono">
            <span className="text-text-muted/60">x:</span>
            {X_SCALE_OPTIONS.map((opt) => (
              <button
                key={opt.mode}
                onClick={() => setXMode(opt.mode)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  xMode === opt.mode
                    ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30'
                    : 'text-text-muted hover:text-text-secondary border border-transparent'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[10px] font-mono">
            <span className="text-text-muted/60">color:</span>
            {COLOR_MODE_OPTIONS.map((opt) => (
              <button
                key={opt.mode}
                onClick={() => setColorMode(opt.mode)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  colorMode === opt.mode
                    ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30'
                    : 'text-text-muted hover:text-text-secondary border border-transparent'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] font-mono text-text-muted">
            {expirations.length} exp × {strikes.length} strikes | ${strikes[0]?.toFixed(0)}–${strikes[strikes.length - 1]?.toFixed(0)} (spot {formatCurrency(spot)})
          </span>
        </div>
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
            xMode={xMode}
            colorMode={colorMode}
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
