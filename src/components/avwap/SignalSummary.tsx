'use client';

import type { ADXResult } from '@/lib/avwap';

interface Signal {
  label: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  value: number | null;
}

interface Props {
  signals: Signal[];
  currentRVOL: number | null;
  currentADX: ADXResult | null;
  ticker: string;
}

export default function SignalSummary({ signals, currentRVOL, currentADX }: Props) {
  const bullCount = signals.filter(s => s.direction === 'bullish').length;
  const bearCount = signals.filter(s => s.direction === 'bearish').length;
  const total = signals.length;

  const rvol = currentRVOL?.toFixed(2);
  const adxVal = currentADX?.adx?.toFixed(1);
  const trending = (currentADX?.adx ?? 0) >= 20;

  const overallBias =
    bullCount === total
      ? 'FULL BULLISH ALIGNMENT'
      : bearCount === total
        ? 'FULL BEARISH ALIGNMENT'
        : bullCount > bearCount
          ? 'BULLISH LEAN'
          : bearCount > bullCount
            ? 'BEARISH LEAN'
            : 'MIXED / NO BIAS';

  const biasColor =
    bullCount === total
      ? 'bg-green-950/50 border-green-700 text-green-300'
      : bearCount === total
        ? 'bg-red-950/50 border-red-700 text-red-300'
        : bullCount > bearCount
          ? 'bg-green-950/30 border-green-800 text-green-400'
          : bearCount > bullCount
            ? 'bg-red-950/30 border-red-800 text-red-400'
            : 'bg-surface border-border text-text-muted';

  return (
    <div className={`rounded-xl border px-4 py-3 flex items-center justify-between flex-wrap gap-3 ${biasColor}`}>
      <div>
        <div className="text-sm font-bold tracking-wide">{overallBias}</div>
        <div className="text-xs opacity-70 mt-0.5">
          {bullCount}/{total} anchors bullish &middot; {bearCount}/{total} bearish
        </div>
      </div>
      <div className="flex gap-4 text-xs font-mono">
        <span>
          RVOL <strong>{rvol ?? '\u2014'}x</strong>
        </span>
        <span>
          ADX <strong>{adxVal ?? '\u2014'}</strong> {trending ? '(trending)' : '(ranging)'}
        </span>
      </div>
    </div>
  );
}
