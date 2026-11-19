/**
 * lightweight-charts v4 series primitives for Flow Desk:
 *   BandFill  — filled band between two lines, coloured per segment (ELMo-D ribbon)
 *   Rects     — time/price rectangles (consolidation boxes)
 *   Segments  — horizontal level segments (liquidity shelves)
 */

import type {
  IChartApi, ISeriesApi, ISeriesPrimitive, ISeriesPrimitivePaneRenderer, ISeriesPrimitivePaneView,
  SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts';

type Target = Parameters<ISeriesPrimitivePaneRenderer['draw']>[0];

abstract class Base implements ISeriesPrimitive<Time> {
  protected chart: IChartApi | null = null;
  protected series: ISeriesApi<SeriesType> | null = null;
  private request: (() => void) | null = null;
  private view: ISeriesPrimitivePaneView;

  constructor(private z: 'bottom' | 'normal' | 'top' = 'bottom') {
    const renderer: ISeriesPrimitivePaneRenderer = { draw: (t) => this.draw(t) };
    this.view = { renderer: () => renderer, zOrder: () => this.z };
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<SeriesType>;
    this.request = p.requestUpdate;
  }
  detached() { this.chart = null; this.series = null; this.request = null; }
  paneViews() { return [this.view]; }
  updateAllViews() {}
  protected refresh() { this.request?.(); }

  protected x(t: Time): number | null {
    return this.chart?.timeScale().timeToCoordinate(t) ?? null;
  }
  protected y(v: number): number | null {
    return this.series?.priceToCoordinate(v) ?? null;
  }
  protected abstract draw(target: Target): void;
}

export interface Band {
  upper: number[];
  lower: number[];
  /** per bar: true = bull colour, false = bear colour, null = skip */
  bull: (boolean | null)[];
}

export class BandFill extends Base {
  private times: Time[] = [];
  private bands: Band[] = [];
  constructor(private bullColor: string, private bearColor: string) { super('bottom'); }

  set(times: Time[], bands: Band[]) { this.times = times; this.bands = bands; this.refresh(); }

  protected draw(target: Target) {
    if (!this.chart || !this.series || this.times.length < 2) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const from = Math.max(1, Math.floor(range?.from ?? 1) - 1);
    const to = Math.min(this.times.length - 1, Math.ceil(range?.to ?? this.times.length) + 1);
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const b of this.bands) {
        for (let i = from; i <= to; i++) {
          const state = b.bull[i];
          if (state == null) continue;
          const vals = [b.upper[i - 1], b.lower[i - 1], b.upper[i], b.lower[i]];
          if (!vals.every(Number.isFinite)) continue;
          const x0 = this.x(this.times[i - 1]);
          const x1 = this.x(this.times[i]);
          const ys = vals.map((v) => this.y(v));
          if (x0 == null || x1 == null || ys.some((v) => v == null)) continue;
          ctx.fillStyle = state ? this.bullColor : this.bearColor;
          ctx.beginPath();
          ctx.moveTo(x0, ys[0]!);
          ctx.lineTo(x1, ys[2]!);
          ctx.lineTo(x1, ys[3]!);
          ctx.lineTo(x0, ys[1]!);
          ctx.closePath();
          ctx.fill();
        }
      }
    });
  }
}

export interface Rect { from: Time; to: Time; top: number; bottom: number; fill: string; stroke: string }

export class Rects extends Base {
  private rects: Rect[] = [];
  constructor() { super('bottom'); }
  set(rects: Rect[]) { this.rects = rects; this.refresh(); }
  protected draw(target: Target) {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const r of this.rects) {
        const x0 = this.x(r.from), x1 = this.x(r.to), y0 = this.y(r.top), y1 = this.y(r.bottom);
        if (x0 == null || x1 == null || y0 == null || y1 == null) continue;
        ctx.fillStyle = r.fill;
        ctx.strokeStyle = r.stroke;
        ctx.lineWidth = 1;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      }
    });
  }
}

export interface Segment { from: Time; to: Time | null; price: number; color: string; dashed?: boolean; label?: string }

export class Segments extends Base {
  private segs: Segment[] = [];
  constructor() { super('normal'); }
  set(segs: Segment[]) { this.segs = segs; this.refresh(); }
  protected draw(target: Target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.font = '10px "JetBrains Mono", monospace';
      for (const s of this.segs) {
        const x0 = this.x(s.from);
        const x1 = s.to == null ? mediaSize.width : this.x(s.to);
        const y = this.y(s.price);
        if (x0 == null || x1 == null || y == null) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1;
        ctx.setLineDash(s.dashed ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(y) + 0.5);
        ctx.lineTo(x1, Math.round(y) + 0.5);
        ctx.stroke();
        if (s.label && s.to == null) {
          ctx.fillStyle = s.color;
          ctx.fillText(s.label, Math.max(x0, 4) + 2, y - 3);
        }
      }
      ctx.setLineDash([]);
    });
  }
}
