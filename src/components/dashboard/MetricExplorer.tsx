'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { METRIC_DEFINITIONS, type DailyMetricRecord } from '@/lib/metricHistory';
import { formatNumber, formatCurrency } from '@/lib/utils/format';
import { History, TrendingUp, TrendingDown, Minus } from 'lucide-react';

type MetricKey = (typeof METRIC_DEFINITIONS)[number]['key'];

// ─── Mini Price + Metric Chart ──────────────────────────────────

function MetricChart({
  metricKey,
  records,
  color,
  format,
}: {
  metricKey: MetricKey;
  records: DailyMetricRecord[];
  color: string;
  format: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current || records.length < 2) return;
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
    const pad = { top: 30, right: 65, bottom: 40, left: 55 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    // Background
    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, w, h);

    // Extract metric values (filter out nulls for nullable metrics)
    const metricData = records
      .map(r => ({ time: r.timestamp, value: r[metricKey] as number | null, price: r.spotPrice }))
      .filter(d => d.value !== null && d.value !== undefined) as { time: number; value: number; price: number }[];

    if (metricData.length < 2) {
      ctx.fillStyle = '#555570';
      ctx.font = '11px "JetBrains Mono"';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough data points yet', w / 2, h / 2);
      return;
    }

    const minTime = metricData[0].time;
    const maxTime = metricData[metricData.length - 1].time;
    const timeRange = maxTime - minTime || 1;

    // Metric value range
    const vals = metricData.map(d => d.value);
    let minV = Math.min(...vals);
    let maxV = Math.max(...vals);
    const vRange = maxV - minV || 1;
    minV -= vRange * 0.08;
    maxV += vRange * 0.08;

    // Price range (for mini price chart)
    const prices = metricData.map(d => d.price);
    const minP = Math.min(...prices) * 0.998;
    const maxP = Math.max(...prices) * 1.002;

    const toX = (t: number) => pad.left + ((t - minTime) / timeRange) * cw;
    const toY = (v: number) => pad.top + ch - ((v - minV) / (maxV - minV)) * ch;
    const toPriceY = (p: number) => pad.top + ch - ((p - minP) / (maxP - minP)) * ch;

    // Grid lines
    ctx.strokeStyle = '#1a1a2515';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // Mini price line (subtle background)
    ctx.beginPath();
    ctx.moveTo(toX(metricData[0].time), toPriceY(metricData[0].price));
    for (let i = 1; i < metricData.length; i++) {
      ctx.lineTo(toX(metricData[i].time), toPriceY(metricData[i].price));
    }
    ctx.strokeStyle = '#ffffff0c';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Price area fill
    ctx.beginPath();
    ctx.moveTo(toX(metricData[0].time), toPriceY(metricData[0].price));
    for (let i = 1; i < metricData.length; i++) {
      ctx.lineTo(toX(metricData[i].time), toPriceY(metricData[i].price));
    }
    ctx.lineTo(toX(metricData[metricData.length - 1].time), pad.top + ch);
    ctx.lineTo(toX(metricData[0].time), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = '#ffffff04';
    ctx.fill();

    // Metric area fill
    ctx.beginPath();
    ctx.moveTo(toX(metricData[0].time), toY(metricData[0].value));
    for (let i = 1; i < metricData.length; i++) {
      ctx.lineTo(toX(metricData[i].time), toY(metricData[i].value));
    }
    ctx.lineTo(toX(metricData[metricData.length - 1].time), pad.top + ch);
    ctx.lineTo(toX(metricData[0].time), pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = color + '10';
    ctx.fill();

    // Metric line
    ctx.beginPath();
    ctx.moveTo(toX(metricData[0].time), toY(metricData[0].value));
    for (let i = 1; i < metricData.length; i++) {
      ctx.lineTo(toX(metricData[i].time), toY(metricData[i].value));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Average line
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    const avgY = toY(avg);
    ctx.strokeStyle = color + '40';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.left, avgY); ctx.lineTo(w - pad.right, avgY); ctx.stroke();
    ctx.setLineDash([]);

    // Average label
    ctx.fillStyle = color + '80';
    ctx.font = '8px "JetBrains Mono"';
    ctx.textAlign = 'left';
    ctx.fillText(`avg ${formatMetricValue(avg, format)}`, w - pad.right + 4, avgY - 3);

    // Current value dot
    const last = metricData[metricData.length - 1];
    ctx.beginPath();
    ctx.arc(toX(last.time), toY(last.value), 4, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#12121a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Y axis labels (metric values)
    ctx.fillStyle = '#555570';
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = minV + ((maxV - minV) / 4) * (4 - i);
      ctx.fillText(formatMetricValue(val, format), pad.left - 5, pad.top + (ch / 4) * i + 3);
    }

    // X axis labels — dates
    ctx.textAlign = 'center';
    ctx.fillStyle = '#555570';
    const labelCount = Math.min(6, metricData.length);
    for (let i = 0; i < labelCount; i++) {
      const idx = Math.floor((i / (labelCount - 1)) * (metricData.length - 1));
      const d = new Date(metricData[idx].time);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      ctx.fillText(label, toX(metricData[idx].time), h - pad.bottom + 14);
    }

    // Legend
    ctx.font = '9px "JetBrains Mono"';
    ctx.textAlign = 'left';
    // Metric
    ctx.fillStyle = color;
    ctx.fillRect(pad.left, 12, 12, 2);
    const def = METRIC_DEFINITIONS.find(m => m.key === metricKey);
    ctx.fillText(def?.label ?? metricKey, pad.left + 16, 16);
    // Price
    ctx.fillStyle = '#ffffff30';
    ctx.fillRect(pad.left + 200, 12, 12, 2);
    ctx.fillStyle = '#ffffff40';
    ctx.fillText('Price', pad.left + 216, 16);

  }, [metricKey, records, color, format]);

  return (
    <div ref={containerRef} className="w-full min-h-[320px]">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
}

function formatMetricValue(val: number, format: string): string {
  switch (format) {
    case 'ratio': return val.toFixed(3);
    case 'percent': return `${(val * 100).toFixed(1)}%`;
    case 'currency': return `$${val.toFixed(0)}`;
    case 'currency_nullable': return val ? `$${val.toFixed(0)}` : '—';
    case 'number':
      if (Math.abs(val) >= 1e6) return `${(val / 1e6).toFixed(1)}M`;
      if (Math.abs(val) >= 1e3) return `${(val / 1e3).toFixed(1)}K`;
      return val.toFixed(0);
    default: return val.toFixed(2);
  }
}

// ─── Stats Bar ──────────────────────────────────────────────

function MetricStats({
  metricKey,
  records,
  format,
  color,
}: {
  metricKey: MetricKey;
  records: DailyMetricRecord[];
  format: string;
  color: string;
}) {
  const vals = records
    .map(r => r[metricKey] as number | null)
    .filter((v): v is number => v !== null && v !== undefined);

  if (vals.length === 0) return null;

  const current = vals[vals.length - 1];
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const min = Math.min(...vals);
  const max = Math.max(...vals);

  // Trend: compare last value to average
  const diff = avg !== 0 ? ((current - avg) / Math.abs(avg)) * 100 : 0;
  const TrendIcon = diff > 5 ? TrendingUp : diff < -5 ? TrendingDown : Minus;
  const trendColor = diff > 5 ? 'text-accent-green' : diff < -5 ? 'text-accent-red' : 'text-text-muted';

  return (
    <div className="grid grid-cols-5 gap-3 px-4 py-3 border-t border-border/20">
      <div>
        <div className="text-[10px] font-mono text-text-muted">Current</div>
        <div className="text-sm font-mono font-semibold" style={{ color }}>
          {formatMetricValue(current, format)}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-mono text-text-muted">Average</div>
        <div className="text-sm font-mono text-text-secondary">
          {formatMetricValue(avg, format)}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-mono text-text-muted">Min</div>
        <div className="text-sm font-mono text-text-secondary">
          {formatMetricValue(min, format)}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-mono text-text-muted">Max</div>
        <div className="text-sm font-mono text-text-secondary">
          {formatMetricValue(max, format)}
        </div>
      </div>
      <div>
        <div className="text-[10px] font-mono text-text-muted">vs Avg</div>
        <div className={`text-sm font-mono font-semibold flex items-center gap-1 ${trendColor}`}>
          <TrendIcon className="w-3 h-3" />
          {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
        </div>
      </div>
    </div>
  );
}

// ─── Main MetricExplorer ────────────────────────────────────

export default function MetricExplorer() {
  const { metricHistory, symbol, multiGEX, snapshot } = useDashboardStore();
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('volumePCR');

  const def = METRIC_DEFINITIONS.find(m => m.key === selectedMetric)!;
  const hasHistory = metricHistory.length >= 2;

  // Build "live" record from current data if we only have 1 day
  const records = metricHistory;

  // Get current value for display even without history
  const getCurrentValue = useCallback((): string => {
    if (!multiGEX && !snapshot) return '—';
    const key = selectedMetric;
    if (key === 'volumePCR') return (multiGEX?.volume?.volumePCR ?? 0).toFixed(3);
    if (key === 'oiPCR') return (multiGEX?.volume?.oiPCR ?? 0).toFixed(3);
    if (key === 'totalCallVol') return formatNumber(multiGEX?.volume?.totalCallVol ?? 0, 0);
    if (key === 'totalPutVol') return formatNumber(multiGEX?.volume?.totalPutVol ?? 0, 0);
    if (key === 'totalGEX') return formatNumber(multiGEX?.aggregated?.totalGEX ?? 0);
    if (key === 'totalDEX') return formatNumber(multiGEX?.aggregated?.totalDEX ?? 0);
    if (key === 'totalVanna') return formatNumber(multiGEX?.aggregated?.totalVanna ?? 0);
    if (key === 'totalCharm') return formatNumber(multiGEX?.aggregated?.totalCharm ?? 0);
    if (key === 'ivRank') return `${snapshot?.iv?.ivRank ?? 0}`;
    if (key === 'currentIV') return `${((snapshot?.iv?.currentIV ?? 0) * 100).toFixed(1)}%`;
    if (key === 'hvCurrent') return `${((snapshot?.iv?.hvCurrent ?? 0) * 100).toFixed(1)}%`;
    if (key === 'gammaFlip') return multiGEX?.aggregated?.gammaFlip ? formatCurrency(multiGEX.aggregated.gammaFlip) : '—';
    if (key === 'callWall') return multiGEX?.aggregated?.callWall ? formatCurrency(multiGEX.aggregated.callWall) : '—';
    if (key === 'putWall') return multiGEX?.aggregated?.putWall ? formatCurrency(multiGEX.aggregated.putWall) : '—';
    if (key === 'maxPain') return multiGEX?.maxPain ? formatCurrency(multiGEX.maxPain.strike) : '—';
    return '—';
  }, [selectedMetric, multiGEX, snapshot]);

  return (
    <div className="panel flex flex-col">
      <div className="panel-header flex-wrap gap-2">
        <span className="panel-title flex items-center gap-2">
          <History className="w-3.5 h-3.5 text-accent-purple" />
          Metric Explorer
        </span>
        <span className="badge badge-purple">{records.length}d history</span>
      </div>

      {/* Metric selector buttons */}
      <div className="px-3 py-2 flex flex-wrap gap-1.5 border-b border-border/20">
        {METRIC_DEFINITIONS.map((m) => (
          <button
            key={m.key}
            onClick={() => setSelectedMetric(m.key)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition-all ${
              selectedMetric === m.key
                ? 'text-white'
                : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
            }`}
            style={selectedMetric === m.key ? { backgroundColor: m.color + '25', color: m.color } : undefined}
          >
            {m.shortLabel}
          </button>
        ))}
      </div>

      {/* Current value display */}
      <div className="px-4 py-3 flex items-baseline gap-3 border-b border-border/10">
        <span className="text-2xl font-mono font-bold" style={{ color: def.color }}>
          {getCurrentValue()}
        </span>
        <span className="text-xs font-mono text-text-muted">{def.label}</span>
        <span className="text-[10px] font-mono text-text-muted/60 ml-auto">{symbol}</span>
      </div>

      {/* Chart area */}
      {hasHistory ? (
        <>
          <MetricChart
            metricKey={selectedMetric}
            records={records}
            color={def.color}
            format={def.format}
          />
          <MetricStats
            metricKey={selectedMetric}
            records={records}
            format={def.format}
            color={def.color}
          />
        </>
      ) : (
        <div className="px-4 py-8 text-center space-y-3">
          <div className="text-sm font-mono text-text-muted">
            Accumulating metric history
          </div>
          <p className="text-xs font-mono text-text-muted/60 max-w-lg mx-auto leading-relaxed">
            Historical options metrics (PCR, volume, GEX, dealer exposure) are not available
            through market data APIs — they can only be computed from live chain data.
            Each day you visit, today&apos;s metrics are saved to your browser&apos;s local storage.
            After 2+ days, charts will appear here showing {def.label} and all other metrics over time
            with averages and a price overlay.
          </p>
          <p className="text-[10px] font-mono text-text-muted/40">
            Today&apos;s snapshot has been saved. History builds automatically with daily use.
          </p>
        </div>
      )}
    </div>
  );
}
