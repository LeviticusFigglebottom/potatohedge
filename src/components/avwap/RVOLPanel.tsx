'use client';

interface Props {
  rvol: (number | null)[];
}

export default function RVOLPanel({ rvol }: Props) {
  const currentRVOL = rvol?.filter((v): v is number => v !== null).slice(-1)[0];
  if (currentRVOL === undefined) return null;

  const interpretation =
    currentRVOL >= 3.0
      ? 'Extreme volume -- major institutional event'
      : currentRVOL >= 2.0
        ? 'High RVOL -- significant participation'
        : currentRVOL >= 1.3
          ? 'Elevated -- above average interest'
          : currentRVOL >= 0.7
            ? 'Normal volume'
            : 'Low RVOL -- low conviction / thin tape';

  const color =
    currentRVOL >= 2.0 ? 'text-orange-400' : currentRVOL >= 1.3 ? 'text-yellow-400' : 'text-text-muted';

  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
        Relative Volume
      </div>
      <div className={`text-3xl font-mono font-bold mb-1 ${color}`}>{currentRVOL.toFixed(2)}x</div>
      <div className="text-xs text-text-muted">{interpretation}</div>
    </div>
  );
}
