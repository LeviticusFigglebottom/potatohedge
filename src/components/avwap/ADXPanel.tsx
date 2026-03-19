'use client';

import type { ADXResult } from '@/lib/avwap';

interface Props {
  adx: ADXResult[];
}

export default function ADXPanel({ adx }: Props) {
  const current = adx?.filter(v => v.adx !== null).slice(-1)[0];
  if (!current || current.adx === null) return null;

  const { adx: adxVal, plusDI, minusDI } = current;
  const regime =
    adxVal >= 25
      ? 'Strong Trend'
      : adxVal >= 20
        ? 'Trending'
        : adxVal >= 15
          ? 'Weak Trend'
          : 'Ranging/Choppy';

  const directionalBias =
    (plusDI ?? 0) > (minusDI ?? 0) ? 'Bullish (+DI dominant)' : 'Bearish (-DI dominant)';
  const adxColor = adxVal >= 20 ? 'text-green-400' : 'text-text-muted';

  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
        ADX / DMI Regime
      </div>
      <div className={`text-3xl font-mono font-bold mb-1 ${adxColor}`}>{adxVal.toFixed(1)}</div>
      <div className="text-sm font-semibold text-text-secondary mb-1">{regime}</div>
      <div className="text-xs text-text-muted mb-2">{directionalBias}</div>
      <div className="flex gap-3 text-xs font-mono">
        <span className="text-green-400">+DI {plusDI?.toFixed(1) ?? '-'}</span>
        <span className="text-red-400">-DI {minusDI?.toFixed(1) ?? '-'}</span>
      </div>
    </div>
  );
}
