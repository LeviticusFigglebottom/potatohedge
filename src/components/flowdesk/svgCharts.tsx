'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { C } from './chart/theme';

/** Callback ref + observed width. */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(800);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(Math.max(300, el.clientWidth || 800));
    ro.current = new ResizeObserver((es) => setW(Math.max(300, es[0].contentRect.width)));
    ro.current.observe(el);
  }, []);
  return [ref, w];
}

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / n)));
  const err = (hi - lo) / n / step;
  const s = step * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const out: number[] = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9; v += s) out.push(+v.toPrecision(12));
  return out;
}

// ─── Bars by strike ─────────────────────────────────────────

export function StrikeBars({ rows, color, spot, fmt, height = 220, label }: {
  rows: { strike: number; value: number }[]; color: string; spot: number; fmt: (v: number) => string; height?: number; label: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 64, r: 12, t: 10, b: 26 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
  const y = (v: number) => pad.t + ih / 2 - (v / max) * (ih / 2);
  const bw = rows.length ? iw / rows.length : iw;
  const kMin = rows[0]?.strike ?? 0, kMax = rows[rows.length - 1]?.strike ?? 1;
  const xSpot = rows.length > 1 ? pad.l + ((spot - kMin) / (kMax - kMin)) * (iw - bw) + bw / 2 : null;
  const labelEvery = Math.ceil(rows.length / Math.max(1, Math.floor(iw / 44)));
  const ticks = [-max, -max / 2, 0, max / 2, max];
  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} className="font-mono" role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.border : C.grid} />
            <text x={pad.l - 6} y={y(t) + 3} fontSize={9} textAnchor="end" fill={C.muted}>{fmt(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = pad.l + i * bw;
          const y0 = y(0), y1 = y(r.value);
          return (
            <g key={r.strike} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x} y={pad.t} width={bw} height={ih} fill="transparent" />
              <rect x={x + Math.min(1, bw * 0.15)} y={Math.min(y0, y1)} width={Math.max(1, bw - Math.min(2, bw * 0.3))} height={Math.max(0.5, Math.abs(y1 - y0))}
                fill={color} opacity={hover == null || hover === i ? (r.value >= 0 ? 0.9 : 0.55) : 0.35} rx={Math.min(2, bw / 4)} />
              {i % labelEvery === 0 && <text x={x + bw / 2} y={height - 8} fontSize={9} textAnchor="middle" fill={C.muted}>{r.strike}</text>}
            </g>
          );
        })}
        {xSpot != null && <>
          <line x1={xSpot} x2={xSpot} y1={pad.t} y2={pad.t + ih} stroke={C.amber} strokeDasharray="4 3" />
          <text x={xSpot + 4} y={pad.t + 10} fontSize={10} fill={C.amber}>spot {spot.toFixed(2)}</text>
        </>}
      </svg>
      {hover != null && rows[hover] && (
        <div className="absolute pointer-events-none bg-bg-primary/95 border border-border rounded px-2 py-1 text-[11px] font-mono"
          style={{ left: Math.min(width - 160, pad.l + hover * bw + 8), top: 8 }}>
          <div className="text-text-primary">Strike {rows[hover].strike}</div>
          <div className="text-text-secondary">{label}: {fmt(rows[hover].value)}</div>
        </div>
      )}
    </div>
  );
}

// ─── Multi-line chart (shared x; optional independent y per series) ───

export interface LineSeries { id: string; label: string; color: string; points: { x: number; y: number }[]; dashed?: boolean; fmt?: (v: number) => string }

export function LinesChart({ series, height = 260, xFmt, yFmt, marker, independentY = false, xLabels, legendExtra }: {
  series: LineSeries[]; height?: number; xFmt: (x: number) => string; yFmt: (y: number) => string;
  marker?: { x: number; label: string }; independentY?: boolean; xLabels?: { x: number; label: string }[]; legendExtra?: ReactNode;
}) {
  const [ref, width] = useWidth();
  const [hx, setHx] = useState<number | null>(null);
  const axisW = independentY ? 52 : 56;
  const nLeft = independentY ? Math.ceil(series.length / 2) : 1;
  const nRight = independentY ? Math.floor(series.length / 2) : 0;
  const pad = { l: axisW * nLeft + 8, r: axisW * nRight + 12, t: 12, b: 26 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const X = (x: number) => pad.l + (xMax > xMin ? ((x - xMin) / (xMax - xMin)) * iw : iw / 2);
  const scales = useMemo(() => {
    const mk = (pts: number[]) => {
      let lo = Math.min(...pts), hi = Math.max(...pts);
      if (independentY) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; if (lo < 0) { lo = -m; hi = m; } }
      if (hi === lo) { hi += 1; lo -= 1; }
      const padY = (hi - lo) * 0.06;
      return { lo: lo - padY, hi: hi + padY };
    };
    if (!independentY) { const all = mk(series.flatMap((s) => s.points.map((p) => p.y))); return series.map(() => all); }
    return series.map((s) => mk(s.points.map((p) => p.y)));
  }, [series, independentY]);
  const Y = (k: number, y: number) => pad.t + ih - ((y - scales[k].lo) / (scales[k].hi - scales[k].lo)) * ih;
  const allX = [...new Set(xs)].sort((a, b) => a - b);
  const nearest = hx == null ? null : allX.reduce((b, x) => (Math.abs(x - hx) < Math.abs(b - hx) ? x : b), allX[0]);

  return (
    <div ref={ref} className="relative w-full">
      <div className="flex flex-wrap gap-3 text-[11px] font-mono text-text-secondary mb-1">
        {series.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span className="w-4" style={{ borderTop: `2px ${s.dashed ? 'dashed' : 'solid'} ${s.color}` }} />{s.label}
          </span>
        ))}
        {legendExtra}
      </div>
      <svg width={width} height={height} className="font-mono" role="img" aria-label={series.map((s) => s.label).join(', ')}
        onMouseMove={(e) => { const x = e.nativeEvent.offsetX; setHx(xMin + ((x - pad.l) / iw) * (xMax - xMin)); }}
        onMouseLeave={() => setHx(null)}>
        {!independentY && niceTicks(scales[0].lo, scales[0].hi).map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(0, t)} y2={Y(0, t)} stroke={C.grid} />
            <text x={pad.l - 6} y={Y(0, t) + 3} fontSize={9} textAnchor="end" fill={C.muted}>{yFmt(t)}</text>
          </g>
        ))}
        {independentY && series.map((s, k) => {
          const leftSide = k < nLeft;
          const ax = leftSide ? pad.l - 8 - axisW * (nLeft - 1 - k) : width - pad.r + 8 + axisW * (k - nLeft);
          const f = s.fmt ?? yFmt;
          return (
            <g key={s.id}>
              <line x1={ax} x2={ax} y1={pad.t} y2={pad.t + ih} stroke={s.color} strokeOpacity={0.6} />
              {[scales[k].lo, 0, scales[k].hi].filter((v) => v >= scales[k].lo && v <= scales[k].hi).map((t) => (
                <text key={t} x={leftSide ? ax - 3 : ax + 3} y={Y(k, t) + 3} fontSize={9} textAnchor={leftSide ? 'end' : 'start'} fill={C.text}>{f(t)}</text>
              ))}
              <text x={ax} y={height - 6} fontSize={9} textAnchor="middle" fill={C.text}>{s.label.split(' ')[0]}</text>
            </g>
          );
        })}
        {independentY && <line x1={pad.l} x2={width - pad.r} y1={pad.t + ih / 2} y2={pad.t + ih / 2} stroke={C.border} />}
        {(xLabels ?? niceTicks(xMin, xMax, Math.floor(iw / 80)).map((x) => ({ x, label: xFmt(x) }))).map((t) => (
          <text key={t.x} x={X(t.x)} y={height - 8} fontSize={9} textAnchor="middle" fill={C.muted}>{t.label}</text>
        ))}
        {marker && <>
          <line x1={X(marker.x)} x2={X(marker.x)} y1={pad.t} y2={pad.t + ih} stroke={C.amber} strokeDasharray="4 3" />
          <text x={X(marker.x) + 4} y={pad.t + 10} fontSize={10} fill={C.amber}>{marker.label}</text>
        </>}
        {series.map((s, k) => (
          <polyline key={s.id} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined}
            strokeLinejoin="round" points={s.points.map((p) => `${X(p.x)},${Y(k, p.y)}`).join(' ')} />
        ))}
        {series.map((s, k) => s.points.length <= 24 && s.points.map((p) => (
          <circle key={`${s.id}-${p.x}`} cx={X(p.x)} cy={Y(k, p.y)} r={3} fill={s.color} stroke={C.bg} strokeWidth={1.5} />
        )))}
        {nearest != null && <line x1={X(nearest)} x2={X(nearest)} y1={pad.t} y2={pad.t + ih} stroke={C.text} strokeOpacity={0.4} />}
      </svg>
      {nearest != null && (
        <div className="absolute pointer-events-none bg-bg-primary/95 border border-border rounded px-2 py-1 text-[11px] font-mono"
          style={{ left: Math.min(width - 190, X(nearest) + 10), top: 24 }}>
          <div className="text-text-primary">{xFmt(nearest)}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === nearest);
            return p ? <div key={s.id} className="text-text-secondary"><span style={{ color: s.color }}>■</span> {s.label}: {(s.fmt ?? yFmt)(p.y)}</div> : null;
          })}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, color, height = 36, width = 160 }: { values: number[]; color: string; height?: number; width?: number }) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * width},${height - 2 - (hi > lo ? ((v - lo) / (hi - lo)) * (height - 4) : (height - 4) / 2)}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label="sparkline">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
