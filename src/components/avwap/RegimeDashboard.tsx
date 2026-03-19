'use client';

import type { ComputedAVWAPData } from './AVWAPTab';

interface Props {
  computedData: ComputedAVWAPData;
  ticker: string;
  currentPrice: number;
}

type LayerStatus = 'bullish' | 'bearish' | 'mixed' | 'setup' | 'active' | 'neutral';

interface Layer {
  label: string;
  status: LayerStatus;
  detail: string;
}

const STATUS_CLASSES: Record<LayerStatus, string> = {
  bullish: 'text-green-400 border-green-800 bg-green-950/50',
  bearish: 'text-red-400 border-red-800 bg-red-950/50',
  mixed: 'text-yellow-400 border-yellow-800 bg-yellow-950/50',
  setup: 'text-blue-400 border-blue-800 bg-blue-950/50',
  active: 'text-orange-400 border-orange-800 bg-orange-950/50',
  neutral: 'text-text-muted border-border bg-surface',
};

const STATUS_INDICATORS: Record<LayerStatus, string> = {
  bullish: 'BUL', bearish: 'BER', mixed: 'MIX',
  setup: 'SET', active: 'ACT', neutral: 'NEU',
};

export default function RegimeDashboard({ computedData, ticker, currentPrice }: Props) {
  const { avwapSeries, currentRVOL, currentADX } = computedData;
  const firstSeries = avwapSeries[0];
  const lastIdx = firstSeries ? firstSeries.avwap.length - 1 : 0;

  const avwapAlignment = avwapSeries.map(s => {
    const val = s.avwap[lastIdx];
    if (val === null) return 'neutral';
    return currentPrice > val ? 'bullish' : 'bearish';
  });

  const allBullish = avwapAlignment.every(a => a === 'bullish');
  const allBearish = avwapAlignment.every(a => a === 'bearish');
  const structureBias: LayerStatus = allBullish ? 'bullish' : allBearish ? 'bearish' : 'mixed';

  const primaryMAD = avwapSeries[0]?.madState;
  const primarySlopeAccel = avwapSeries[0]?.slopeAccel[lastIdx];
  const slopeBias: LayerStatus =
    primarySlopeAccel !== null && primarySlopeAccel !== undefined
      ? primarySlopeAccel > 0
        ? 'bullish'
        : primarySlopeAccel < 0
          ? 'bearish'
          : 'neutral'
      : 'neutral';

  const rvolHigh = (currentRVOL ?? 0) >= 2.0;
  const adxTrending = (currentADX?.adx ?? 0) >= 20;
  const adxBias: LayerStatus = currentADX
    ? currentADX.plusDI !== null && currentADX.minusDI !== null
      ? (currentADX.plusDI ?? 0) > (currentADX.minusDI ?? 0)
        ? 'bullish'
        : 'bearish'
      : 'neutral'
    : 'neutral';

  const layers: Layer[] = [
    {
      label: 'AVWAP Structure',
      status: structureBias,
      detail: allBullish
        ? 'Price above all anchors'
        : allBearish
          ? 'Price below all anchors'
          : 'Mixed -- trend unclear',
    },
    {
      label: 'MAD State',
      status: primaryMAD?.state === 'compressing' ? 'setup' : primaryMAD?.state === 'expanding' ? 'active' : 'neutral',
      detail:
        primaryMAD?.state === 'compressing'
          ? 'Volatility coiling -- setup forming'
          : primaryMAD?.state === 'expanding'
            ? 'Volatility expanding -- move underway'
            : 'No compression signal',
    },
    {
      label: 'AVWAP Slope Accel',
      status: slopeBias,
      detail:
        primarySlopeAccel !== null && primarySlopeAccel !== undefined
          ? `${primarySlopeAccel > 0 ? 'Accelerating upward' : 'Decelerating'} (${primarySlopeAccel.toFixed(4)})`
          : 'Insufficient data',
    },
    {
      label: 'RVOL',
      status: rvolHigh ? 'active' : 'neutral',
      detail:
        currentRVOL !== null && currentRVOL !== undefined
          ? `${currentRVOL.toFixed(2)}x avg${rvolHigh ? ' -- Institutional participation' : ''}`
          : 'No RVOL data',
    },
    {
      label: 'ADX Regime',
      status: adxTrending ? adxBias : 'neutral',
      detail: currentADX?.adx !== null && currentADX?.adx !== undefined
        ? `ADX ${currentADX.adx.toFixed(1)} | +DI ${currentADX.plusDI?.toFixed(1) ?? '-'} | -DI ${currentADX.minusDI?.toFixed(1) ?? '-'}`
        : 'No ADX data',
    },
    {
      label: 'CVD Direction',
      status: computedData.cvdTrend.direction === 'buying'
        ? 'bullish'
        : computedData.cvdTrend.direction === 'selling'
          ? 'bearish'
          : 'neutral',
      detail: computedData.cvdTrend.direction === 'buying'
        ? 'Net buying pressure (CVD rising)'
        : computedData.cvdTrend.direction === 'selling'
          ? 'Net selling pressure (CVD falling)'
          : 'No clear order flow bias',
    },
  ];

  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
        Signal Regime &mdash; {ticker}
      </div>
      <div className="flex flex-col gap-2">
        {layers.map(layer => (
          <div key={layer.label} className={`rounded-lg border px-3 py-2 ${STATUS_CLASSES[layer.status]}`}>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-xs font-semibold">{layer.label}</span>
              <span className="text-xs font-mono">{STATUS_INDICATORS[layer.status]}</span>
            </div>
            <div className="text-xs opacity-70">{layer.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
