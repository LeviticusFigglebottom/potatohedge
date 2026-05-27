'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';
import type { StrikeExposure } from '@/lib/math/blackScholes';
import { detectPocketsAcrossExpirations, type Pocket } from '@/lib/math/pockets';

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
  /** Detected pockets across all expirations. Only rendered on the
   *  netGEX panel — pocket semantics are gamma-specific (see
   *  pockets.ts module header for rationale). Pass empty array on
   *  other panels. */
  pockets: Pocket[];
  onHoverPocket: (pocket: Pocket | null) => void;
  onClickPocket: (pocket: Pocket | null) => void;
  showYAxis: boolean; // only left panels show Y-axis
  showXAxis: boolean; // only bottom panels show X-axis
}

function HeatPanel({
  config, gridData, strikes, expirations, xMode, colorMode, spot,
  gammaFlip, callWall, putWall,
  hoveredStrike, onHoverStrike, pockets, onHoverPocket, onClickPocket,
  showYAxis, showXAxis,
}: HeatPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageCache = useRef<HTMLCanvasElement | null>(null);
  // Pocket pixel positions are populated during draw() and consumed by
  // the mouse handlers for hit-testing. Stored as a ref because the
  // values depend on canvas dimensions which change on resize.
  const pocketPositionsRef = useRef<Array<{ pocket: Pocket; x: number; y: number }>>([]);

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

      // ── Pocket overlay (GEX panel only) ───────────────────────────
      // Void      → open amber circle (r=4)        — locally thin
      // Sign-flip → filled amber diamond (~5px)    — opposite-sign island
      // Dead-zone → open amber square (5px side)   — absolute thin, beyond walls
      // Dead zones use a slightly more orange amber (#EF9F27) to
      // distinguish them visually from void/sign-flip ticks in the
      // same color family.
      // Pocket pixel positions cached in ref for mouse hit-testing.
      const positions: Array<{ pocket: Pocket; x: number; y: number }> = [];
      if (config.metric === 'netGEX' && pockets.length > 0 && expirations.length > 0) {
        const expIndexByDate = new Map<string, number>();
        expirations.forEach((e, i) => expIndexByDate.set(e.date, i));

        for (const p of pockets) {
          if (p.strike < minS || p.strike > maxS) continue;
          const expIdx = expIndexByDate.get(p.expiry);
          if (expIdx === undefined) continue;
          const x = toX(expIdx);
          const y = toY(p.strike);
          positions.push({ pocket: p, x, y });

          ctx.save();
          if (p.type === 'void') {
            ctx.strokeStyle = '#ffaa00';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.stroke();
          } else if (p.type === 'sign_flip') {
            ctx.fillStyle = '#ffaa00';
            ctx.beginPath();
            ctx.moveTo(x, y - 5);
            ctx.lineTo(x + 5, y);
            ctx.lineTo(x, y + 5);
            ctx.lineTo(x - 5, y);
            ctx.closePath();
            ctx.fill();
          } else if (p.type === 'dead_zone') {
            // Open amber square, 5px side, slightly more-orange shade
            // to distinguish from void/sign-flip in the same family.
            ctx.strokeStyle = '#EF9F27';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
          }
          ctx.restore();
        }
      }
      pocketPositionsRef.current = positions;

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
      hoveredStrike, config, showYAxis, showXAxis, pockets]);

  // ── Mouse handlers ───────────────────────────────────────────────
  // Two concerns sharing the same canvas:
  //   1. Strike crosshair — fires on every panel, snaps to nearest strike
  //   2. Pocket hit-testing — netGEX panel only, ~10-12px radius
  // Pocket positions live in pocketPositionsRef (populated by draw()).

  const POCKET_HOVER_RADIUS = 10;
  const POCKET_CLICK_RADIUS = 12;

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pad = { top: 22, bottom: showXAxis ? 42 : 8 };
    const ch = rect.height - pad.top - pad.bottom;
    const frac = 1 - (my - pad.top) / ch;
    const minS = strikes[0], maxS = strikes[strikes.length - 1];
    const strike = minS + frac * (maxS - minS);
    let closest = strikes[0];
    let minDist = Infinity;
    for (const s of strikes) {
      const d = Math.abs(s - strike);
      if (d < minDist) { minDist = d; closest = s; }
    }
    onHoverStrike(closest);

    // Pocket hit-test (netGEX panel only — empty positions on others)
    if (config.metric === 'netGEX' && pocketPositionsRef.current.length > 0) {
      let nearest: Pocket | null = null;
      let nearestDist = POCKET_HOVER_RADIUS;
      for (const p of pocketPositionsRef.current) {
        const dx = mx - p.x;
        const dy = my - p.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = p.pocket;
        }
      }
      onHoverPocket(nearest);
    }
  }, [strikes, onHoverStrike, showXAxis, config.metric, onHoverPocket]);

  const handleMouseLeave = useCallback(() => {
    onHoverStrike(null);
    if (config.metric === 'netGEX') onHoverPocket(null);
  }, [onHoverStrike, onHoverPocket, config.metric]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (config.metric !== 'netGEX') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let nearest: Pocket | null = null;
    let nearestDist = POCKET_CLICK_RADIUS;
    for (const p of pocketPositionsRef.current) {
      const dx = mx - p.x;
      const dy = my - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = p.pocket;
      }
    }
    if (nearest) onClickPocket(nearest);
  }, [config.metric, onClickPocket]);

  return (
    <div ref={containerRef} className="relative min-h-[200px]">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
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

// ─── Pocket overlays ─────────────────────────────────────────────────

/** Small read-only tooltip rendered on hover. Pinned to the top-right
 *  of the heatmap grid (absolute position) so it doesn't follow the
 *  cursor — feedback from twin review on AVWAP work was that
 *  cursor-following tooltips on dense canvases feel jittery. The user
 *  scans down to read the badge once they spot a tick. */
function PocketHoverTooltip({ pocket, spot }: { pocket: Pocket; spot: number }) {
  const distLabel = pocket.distPct >= 0
    ? `+${(pocket.distPct * 100).toFixed(2)}%`
    : `${(pocket.distPct * 100).toFixed(2)}%`;
  const detail = pocket.type === 'void'
    ? `thinness ${pocket.thinness?.toFixed(3) ?? '—'}`
    : pocket.type === 'sign_flip'
      ? `z ${pocket.z?.toFixed(2) ?? '—'}`
      : `deadness ${pocket.deadness?.toFixed(3) ?? '—'}`;
  // Dead-zones use a slightly different amber shade to mirror the
  // marker color; voids and sign_flips share the standard amber.
  const tone = pocket.type === 'dead_zone' ? 'text-amber-400' : 'text-amber-300';
  return (
    <div className="pointer-events-none absolute top-2 right-2 z-10 bg-bg-primary/90 border border-amber-500/40 rounded px-2.5 py-1.5 backdrop-blur-sm shadow-lg">
      <div className="flex items-center gap-2 text-[10px] font-mono">
        <span className={`font-bold uppercase ${tone}`}>{pocket.type.replace('_', ' ')}</span>
        <span className="text-text-primary">${pocket.strike}</span>
        <span className="text-text-muted">({distLabel} from ${spot.toFixed(0)})</span>
      </div>
      <div className="text-[9px] font-mono text-text-muted mt-0.5">
        {pocket.expiry} · {pocket.dte}d · {detail}
      </div>
    </div>
  );
}

/** Click-triggered chain-detail popover. Renders over the entire
 *  heatmap surface. Closes on outside-click and Escape.
 *
 *  Content:
 *   - top row: pocket type, strike, expiry/DTE, distPct, GEX (signed)
 *   - exposure breakdown from multiGEX.perExpiration: callGEX/putGEX,
 *     callDEX/putDEX, callVanna/putVanna, callCharm/putCharm
 *   - secondary section: async fetch of /api/market/chain for this
 *     expiry, then pull the strike's call + put contracts to show OI,
 *     IV, last delta, last gamma per side. Renders a "Loading chain
 *     detail..." state until the fetch resolves.
 */
interface MinimalContract {
  strike: number;
  openInterest?: number;
  impliedVolatility?: number;
  delta?: number;
  gamma?: number;
}
interface MinimalChain {
  calls?: MinimalContract[];
  puts?: MinimalContract[];
}

function PocketDetailPopover({
  pocket, symbol, spot, perExpiration, onClose,
}: {
  pocket: Pocket;
  symbol: string;
  spot: number;
  perExpiration: Array<{ expiration: string; exposures: StrikeExposure[] }>;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [chain, setChain] = useState<MinimalChain | null>(null);
  const [chainLoading, setChainLoading] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);

  // Find the exposure data we already have in multiGEX
  const exposure = useMemo<StrikeExposure | null>(() => {
    const expSlice = perExpiration.find((e) => e.expiration === pocket.expiry);
    if (!expSlice) return null;
    return expSlice.exposures.find((x) => x.strike === pocket.strike) ?? null;
  }, [perExpiration, pocket]);

  // Async chain fetch on mount / pocket change
  useEffect(() => {
    let cancelled = false;
    setChainLoading(true);
    setChainError(null);
    setChain(null);
    fetch(`/api/market/chain?symbol=${symbol}&expiration=${pocket.expiry}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setChain(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setChainError(err instanceof Error ? err.message : 'chain fetch failed');
      })
      .finally(() => {
        if (!cancelled) setChainLoading(false);
      });
    return () => { cancelled = true; };
  }, [symbol, pocket]);

  // Outside-click + Escape to dismiss
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const callMatch = chain?.calls?.find((c) => Math.abs(c.strike - pocket.strike) < 1e-6);
  const putMatch = chain?.puts?.find((p) => Math.abs(p.strike - pocket.strike) < 1e-6);
  const distLabel = pocket.distPct >= 0
    ? `+${(pocket.distPct * 100).toFixed(2)}%`
    : `${(pocket.distPct * 100).toFixed(2)}%`;
  const detail = pocket.type === 'void'
    ? `thinness ${pocket.thinness?.toFixed(3) ?? '—'}`
    : pocket.type === 'sign_flip'
      ? `z ${pocket.z?.toFixed(2) ?? '—'}`
      : `deadness ${pocket.deadness?.toFixed(3) ?? '—'}${pocket.perExpiryPeak ? ` (vs peak ${formatNumber(pocket.perExpiryPeak)})` : ''}`;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center p-6 pointer-events-none">
      <div
        ref={popoverRef}
        className="pointer-events-auto bg-bg-primary border border-amber-500/50 rounded-lg shadow-2xl max-w-md w-full"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-3 py-2 border-b border-border/40">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono font-bold uppercase text-amber-300">
                {pocket.type.replace('_', ' ')}
              </span>
              <span className="text-sm font-mono font-bold text-text-primary">
                ${pocket.strike}
              </span>
              <span className="text-[10px] font-mono text-text-muted">
                {distLabel} from ${spot.toFixed(0)}
              </span>
            </div>
            <div className="text-[10px] font-mono text-text-muted">
              {pocket.expiry} · {pocket.dte}d · {detail}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-base leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Exposure section — from multiGEX (no fetch required) */}
        {exposure && (
          <div className="px-3 py-2 border-b border-border/40">
            <div className="text-[9px] font-mono text-text-muted uppercase tracking-wider mb-1">
              Dealer exposure at strike
            </div>
            <div className="grid grid-cols-4 gap-2 text-[10px] font-mono">
              <ExposureCell label="GEX" net={exposure.netGEX} call={exposure.callGEX} put={exposure.putGEX} />
              <ExposureCell label="DEX" net={exposure.netDEX} call={exposure.callDEX} put={exposure.putDEX} />
              <ExposureCell label="Vanna" net={exposure.netVanna} call={exposure.callVanna} put={exposure.putVanna} />
              <ExposureCell label="Charm" net={exposure.netCharm} call={exposure.callCharm} put={exposure.putCharm} />
            </div>
          </div>
        )}

        {/* Chain detail section — async */}
        <div className="px-3 py-2">
          <div className="text-[9px] font-mono text-text-muted uppercase tracking-wider mb-1">
            Chain detail (per side)
          </div>
          {chainLoading && (
            <div className="text-[10px] font-mono text-text-muted animate-pulse">Loading chain detail...</div>
          )}
          {chainError && (
            <div className="text-[10px] font-mono text-amber-400">Failed to load: {chainError}</div>
          )}
          {!chainLoading && !chainError && (callMatch || putMatch) && (
            <div className="grid grid-cols-5 gap-2 text-[10px] font-mono">
              <div className="col-span-1" />
              <div className="text-text-muted">OI</div>
              <div className="text-text-muted">IV</div>
              <div className="text-text-muted">Δ</div>
              <div className="text-text-muted">Γ</div>
              {callMatch && (
                <>
                  <div className="text-green-400">Call</div>
                  <div className="text-text-secondary">{callMatch.openInterest ?? '—'}</div>
                  <div className="text-text-secondary">{callMatch.impliedVolatility != null ? (callMatch.impliedVolatility * 100).toFixed(1) + '%' : '—'}</div>
                  <div className="text-text-secondary">{callMatch.delta?.toFixed(3) ?? '—'}</div>
                  <div className="text-text-secondary">{callMatch.gamma?.toFixed(4) ?? '—'}</div>
                </>
              )}
              {putMatch && (
                <>
                  <div className="text-red-400">Put</div>
                  <div className="text-text-secondary">{putMatch.openInterest ?? '—'}</div>
                  <div className="text-text-secondary">{putMatch.impliedVolatility != null ? (putMatch.impliedVolatility * 100).toFixed(1) + '%' : '—'}</div>
                  <div className="text-text-secondary">{putMatch.delta?.toFixed(3) ?? '—'}</div>
                  <div className="text-text-secondary">{putMatch.gamma?.toFixed(4) ?? '—'}</div>
                </>
              )}
            </div>
          )}
          {!chainLoading && !chainError && !callMatch && !putMatch && (
            <div className="text-[10px] font-mono text-text-muted">
              No contracts at ${pocket.strike} in the chain response.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExposureCell({ label, net, call, put }: { label: string; net: number; call: number; put: number }) {
  const sign = (n: number) => (n >= 0 ? '+' : '');
  const tone = (n: number) => (n >= 0 ? 'text-blue-400' : 'text-red-400');
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-text-muted text-[9px]">{label}</span>
      <span className={`${tone(net)} font-semibold`}>{sign(net)}{formatNumber(net)}</span>
      <span className="text-green-400 text-[9px]">c {sign(call)}{formatNumber(call)}</span>
      <span className="text-red-400 text-[9px]">p {sign(put)}{formatNumber(put)}</span>
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
  const [hoveredPocket, setHoveredPocket] = useState<Pocket | null>(null);
  const [clickedPocket, setClickedPocket] = useState<Pocket | null>(null);

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

  /** Pockets beyond this signed-distance threshold from spot are
   *  computed (and still feed the persistence detector in commit 6)
   *  but NOT rendered as overlay ticks. Pockets that far OTM aren't
   *  actionable scalp levels — they're structural artifacts. Matches
   *  the metric-card ±2% alpha zone with a small buffer. */
  const POCKET_OVERLAY_MAX_DIST_PCT = 0.03;

  // Run pocket detection across all expirations. Uses the FULL per-
  // expiration exposures from multiGEX rather than the strike-thinned
  // grid above — pocket semantics work best on the densest available
  // chain data, and the heatmap thinning is a presentation concern.
  //
  // Wall exclusion: the labeled callWall / putWall strikes are passed
  // to the detector wrapper which drops any pocket within ±$0.50 of
  // those strikes. The wall IS structure; pockets near it are
  // wall-shoulder math artifacts, not exceptions to wall structure.
  const pockets = useMemo<Pocket[]>(() => {
    if (!multiGEX?.perExpiration?.length) return [];

    const detected = detectPocketsAcrossExpirations(
      multiGEX.perExpiration,
      multiGEX.spotPrice,
      {
        callWall: multiGEX.aggregated.callWall,
        putWall: multiGEX.aggregated.putWall,
      },
    );

    if (process.env.NODE_ENV !== 'production' && detected.length > 0) {
      const voids = detected.filter((p) => p.type === 'void').length;
      const flips = detected.filter((p) => p.type === 'sign_flip').length;
      const dzs = detected.filter((p) => p.type === 'dead_zone').length;
      console.log(`[GammaHeatmap] detected ${detected.length} pockets (${voids} void, ${flips} sign_flip, ${dzs} dead_zone):`, detected);

      // Suspicious sign-flip diagnostic: any sign-flip with |z| > 5
      // gets its ±2 strike flanks dumped to console. With the v2 gates
      // this should never trigger on a wall-adjacent strike.
      const suspiciousFlips = detected.filter((p) => p.type === 'sign_flip' && Math.abs(p.z ?? 0) > 5);
      if (suspiciousFlips.length > 0) {
        console.warn(`[GammaHeatmap] ${suspiciousFlips.length} suspicious sign-flip(s) with |z| > 5:`);
        for (const p of suspiciousFlips) {
          const slice = multiGEX.perExpiration.find((e) => e.expiration === p.expiry);
          if (!slice) continue;
          const flanks = slice.exposures
            .filter((e) => Math.abs(e.strike - p.strike) <= 2.5)
            .sort((a, b) => a.strike - b.strike)
            .map((e) => `${e.strike}:${e.netGEX.toFixed(0)}`);
          console.warn(`  sign_flip ${p.strike} (${p.expiry}, ${p.dte}d, z=${p.z?.toFixed(2)}): flanks ${flanks.join(' ')}`);
        }
      }

      // Suspicious dead-zone diagnostic: any single expiry producing
      // more than 6 dead-zones is likely a tuning issue (expiry-
      // relevance ratio too loose for that expiry's structure, or
      // absoluteFloorRatio needs tightening). Dump the strike list +
      // per-expiry peak so the calibration can be adjusted.
      const dzByExpiry = new Map<string, Pocket[]>();
      for (const p of detected) {
        if (p.type !== 'dead_zone') continue;
        if (!dzByExpiry.has(p.expiry)) dzByExpiry.set(p.expiry, []);
        dzByExpiry.get(p.expiry)!.push(p);
      }
      for (const [exp, list] of dzByExpiry) {
        if (list.length > 6) {
          const strikes = list.map((p) => `$${p.strike}`).join(', ');
          const peak = list[0].perExpiryPeak;
          console.warn(`[GammaHeatmap] ${list.length} dead_zones in ${exp} (peak ${peak ? formatNumber(peak) : '—'}): ${strikes}`);
        }
      }
    }
    return detected;
  }, [multiGEX]);

  /** Subset rendered as overlay ticks — clipped to ±POCKET_OVERLAY_MAX_DIST_PCT
   *  of spot. The full `pockets` array still feeds the click popover lookup
   *  and (in commit 6) the persistence detector. */
  const pocketsForOverlay = useMemo<Pocket[]>(
    () => pockets.filter((p) => Math.abs(p.distPct) <= POCKET_OVERLAY_MAX_DIST_PCT),
    [pockets],
  );

  const onHoverStrike = useCallback((s: number | null) => setHoveredStrike(s), []);
  const onHoverPocket = useCallback((p: Pocket | null) => setHoveredPocket(p), []);
  const onClickPocket = useCallback((p: Pocket | null) => setClickedPocket(p), []);

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
          {/* Pocket marker legend — inline glyphs match the canvas
              tick shapes. Open circle = void, filled diamond = sign-
              flip, open square = dead zone (slightly oranger amber). */}
          <span className="flex items-center gap-2 text-[10px] font-mono text-text-muted/80 border-l border-border/40 pl-3">
            <span className="flex items-center gap-1"><span className="text-amber-300">○</span>void</span>
            <span className="flex items-center gap-1"><span className="text-amber-300">◆</span>sign-flip</span>
            <span className="flex items-center gap-1"><span className="text-amber-400">□</span>dead zone</span>
          </span>
          <span className="text-[10px] font-mono text-text-muted">
            {expirations.length} exp × {strikes.length} strikes | ${strikes[0]?.toFixed(0)}–${strikes[strikes.length - 1]?.toFixed(0)} (spot {formatCurrency(spot)})
          </span>
        </div>
      </div>

      {/* 2×2 heatmap grid with pocket overlay (GEX panel only) */}
      <div className="relative grid grid-cols-2 gap-px bg-border/20">
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
            // Pockets only matter on the GEX panel — other panels get
            // an empty array (HeatPanel's draw skips overlay work too).
            // Note: pass the OVERLAY-filtered subset (within ±3% of
            // spot); the full pocket list is retained for persistence
            // detection and the click-popover strike lookup, but
            // rendering and hit-testing operate on the visible subset
            // only.
            pockets={config.metric === 'netGEX' ? pocketsForOverlay : []}
            onHoverPocket={onHoverPocket}
            onClickPocket={onClickPocket}
            showYAxis={i % 2 === 0}  // left panels
            showXAxis={i >= 2}        // bottom panels
          />
        ))}

        {/* Hover tooltip — small, follows pocket position. Suppressed
            when the click popover is open so the two don't overlap. */}
        {hoveredPocket && !clickedPocket && (
          <PocketHoverTooltip pocket={hoveredPocket} spot={spot} />
        )}
      </div>

      {/* Click popover — strike chain detail. Renders outside the
          panel grid so it can absolutely-position over the entire
          heatmap surface. */}
      {clickedPocket && (
        <PocketDetailPopover
          pocket={clickedPocket}
          symbol={symbol}
          spot={spot}
          perExpiration={multiGEX.perExpiration}
          onClose={() => setClickedPocket(null)}
        />
      )}

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
