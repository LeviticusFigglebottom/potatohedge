'use client';

import type { AVWAPSeriesData } from './AVWAPTab';

interface Props {
  avwapSeries: AVWAPSeriesData[];
}

export default function MADPanel({ avwapSeries }: Props) {
  if (!avwapSeries?.length) return null;

  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
        MAD State
      </div>
      {avwapSeries.map(s => (
        <div key={s.anchor.date} className="flex items-center justify-between py-1 text-xs">
          <span className="text-text-muted truncate max-w-[120px]">{s.anchor.label}</span>
          <span
            className={
              s.madState.state === 'compressing'
                ? 'text-blue-400 font-semibold'
                : s.madState.state === 'expanding'
                  ? 'text-orange-400 font-semibold'
                  : 'text-text-muted'
            }
          >
            {s.madState.state.toUpperCase()}
          </span>
          <span className="text-text-muted font-mono">
            {s.madState.roc >= 0 ? '+' : ''}
            {(s.madState.roc * 100).toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}
