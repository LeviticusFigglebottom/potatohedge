'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';
import { Activity, Target, BarChart3, TrendingUp, TrendingDown, Gauge, AlertTriangle, Thermometer, Zap } from 'lucide-react';

function StatCard({ icon: Icon, label, value, subtext, color, subtle }: {
  icon: React.ElementType; label: string; value: string; subtext?: string; color?: string; subtle?: boolean;
}) {
  return (
    <div className={`panel p-3 flex flex-col gap-1 ${subtle ? 'opacity-70' : ''}`}>
      <div className="flex items-center gap-2">
        <Icon className={`w-3.5 h-3.5 ${color || 'text-text-muted'}`} />
        <span className="stat-label">{label}</span>
      </div>
      <div className={`text-lg font-mono font-semibold ${color || 'text-text-primary'}`}>{value}</div>
      {subtext && <div className="text-[10px] font-mono text-text-muted leading-tight">{subtext}</div>}
    </div>
  );
}

export default function AnalyticsCards() {
  const { multiGEX, snapshot, loading } = useDashboardStore();

  if ((loading.multiGEX || loading.snapshot) && !multiGEX && !snapshot) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="panel p-3"><div className="skeleton w-16 h-3 mb-2" /><div className="skeleton w-20 h-6" /></div>
        ))}
      </div>
    );
  }

  const gex = multiGEX?.aggregated;
  const vol = multiGEX?.volume;
  const iv = snapshot?.iv;
  const pcr = vol ? vol.volumePCR : 0;

  const ctx = multiGEX?.context;

  // PCR context — compare today's volume PCR to accumulated OI PCR
  const oiPCR = vol?.oiPCR ?? 0;
  let pcrColor = 'text-text-primary';
  let pcrSub = 'Neutral range';
  if (pcr > 1.2) { pcrColor = 'text-accent-red'; pcrSub = 'Elevated puts — bearish/hedging'; }
  else if (pcr > 0.9) { pcrColor = 'text-accent-amber'; pcrSub = 'Slightly put-heavy'; }
  else if (pcr < 0.6) { pcrColor = 'text-accent-green'; pcrSub = 'Strong call dominance'; }
  else if (pcr < 0.8) { pcrColor = 'text-accent-green'; pcrSub = 'Call-heavy flow'; }
  // Add OI PCR comparison
  if (oiPCR > 0 && Math.abs(pcr - oiPCR) / oiPCR > 0.15) {
    const shift = pcr > oiPCR ? 'more bearish' : 'more bullish';
    pcrSub += ` (${shift} vs OI: ${oiPCR.toFixed(2)})`;
  }

  const gexPositive = (gex?.totalGEX ?? 0) >= 0;
  const spot = multiGEX?.spotPrice ?? 0;
  const maxPainDist = spot > 0 && multiGEX?.maxPain ? ((multiGEX.maxPain.strike - spot) / spot * 100) : 0;

  // Volume context from multi-gex
  const volCtx = ctx?.volume;
  let callVolSub = vol ? `${((vol.totalCallVol / Math.max(1, vol.totalCallVol + vol.totalPutVol)) * 100).toFixed(0)}% of total` : '';
  let putVolSub = vol ? `${((vol.totalPutVol / Math.max(1, vol.totalCallVol + vol.totalPutVol)) * 100).toFixed(0)}% of total` : '';
  // Note: volume ratios vs average are not shown since we lack
  // historical daily options volume data. PCR divergence is more meaningful.

  // IV context
  let ivSub = '';
  if (iv) {
    ivSub = `${(iv.currentIV * 100).toFixed(0)}% IV (${(iv.iv52wLow * 100).toFixed(0)}-${(iv.iv52wHigh * 100).toFixed(0)}% range)`;
    if (iv.ivHvRatio < 0.8) ivSub += ' · IV < HV';
    else if (iv.ivHvRatio > 1.3) ivSub += ' · IV > HV';
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2 animate-fade-in">
      <StatCard icon={BarChart3} label="Vol P/C" value={pcr.toFixed(3)} subtext={pcrSub} color={pcrColor} />
      <StatCard icon={Activity} label="OI P/C" value={oiPCR.toFixed(3)}
        subtext={vol ? `C:${formatNumber(vol.totalCallOI, 0)} P:${formatNumber(vol.totalPutOI, 0)}` : ''} />
      <StatCard icon={Target} label="Max Pain" value={multiGEX?.maxPain ? formatCurrency(multiGEX.maxPain.strike) : '—'}
        subtext={`${maxPainDist > 0 ? '+' : ''}${maxPainDist.toFixed(1)}% from spot`} color="text-accent-cyan" />
      <StatCard icon={gexPositive ? TrendingUp : TrendingDown} label="Net GEX"
        value={gex ? `${gex.totalGEX >= 0 ? '+' : ''}${formatNumber(gex.totalGEX)}` : '—'}
        subtext={gexPositive ? 'Long γ — mean-reversion' : 'Short γ — amplified moves'}
        color={gexPositive ? 'text-accent-green' : 'text-accent-red'} />
      <StatCard icon={Zap} label="Net DEX"
        value={gex ? `${gex.totalDEX >= 0 ? '+' : ''}${formatNumber(gex.totalDEX)}` : '—'}
        subtext={gex && gex.totalDEX < 0 ? 'Short δ — dealers must buy' : 'Long δ — dealers may sell'}
        color={(gex?.totalDEX ?? 0) < 0 ? 'text-accent-amber' : 'text-text-primary'} />
      <StatCard icon={Thermometer} label="IV Rank"
        value={iv ? `${iv.ivRank}` : '—'}
        subtext={ivSub}
        color={iv && iv.ivRank > 70 ? 'text-accent-red' : iv && iv.ivRank < 30 ? 'text-accent-green' : 'text-accent-purple'} />
      <StatCard icon={Gauge} label="Call Vol"
        value={vol ? formatNumber(vol.totalCallVol, 0) : '—'}
        subtext={callVolSub}
        color="text-accent-green" />
      <StatCard icon={AlertTriangle} label="Put Vol"
        value={vol ? formatNumber(vol.totalPutVol, 0) : '—'}
        subtext={putVolSub}
        color="text-accent-red" />
    </div>
  );
}
