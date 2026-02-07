'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';
import { Activity, Target, BarChart3, TrendingUp, TrendingDown, Gauge, AlertTriangle } from 'lucide-react';

function StatCard({ icon: Icon, label, value, subtext, color }: {
  icon: React.ElementType;
  label: string;
  value: string;
  subtext?: string;
  color?: string;
}) {
  return (
    <div className="panel p-3 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Icon className={`w-3.5 h-3.5 ${color || 'text-text-muted'}`} />
        <span className="stat-label">{label}</span>
      </div>
      <div className={`text-lg font-mono font-semibold ${color || 'text-text-primary'}`}>
        {value}
      </div>
      {subtext && (
        <div className="text-[10px] font-mono text-text-muted leading-tight">
          {subtext}
        </div>
      )}
    </div>
  );
}

export default function AnalyticsCards() {
  const { analytics, loading, chain, quote } = useDashboardStore();

  if (loading.analytics && !analytics) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="panel p-3">
            <div className="skeleton w-16 h-3 mb-2" />
            <div className="skeleton w-20 h-6" />
          </div>
        ))}
      </div>
    );
  }

  if (!analytics) return null;

  const { pcr, maxPain, gex } = analytics;

  // PCR interpretation
  let pcrColor = 'text-text-primary';
  let pcrSub = 'Neutral range';
  if (pcr.volumePCR > 1.2) {
    pcrColor = 'text-accent-red';
    pcrSub = 'Elevated put activity — bearish/hedging';
  } else if (pcr.volumePCR > 0.9) {
    pcrColor = 'text-accent-amber';
    pcrSub = 'Slightly put-heavy';
  } else if (pcr.volumePCR < 0.6) {
    pcrColor = 'text-accent-green';
    pcrSub = 'Strong call dominance — bullish';
  } else if (pcr.volumePCR < 0.8) {
    pcrColor = 'text-accent-green';
    pcrSub = 'Call-heavy flow';
  }

  // Max pain distance
  const spot = quote?.last || gex.spotPrice;
  const maxPainDist = spot > 0 ? ((maxPain.strike - spot) / spot * 100) : 0;
  const maxPainSub = maxPainDist > 0
    ? `${maxPainDist.toFixed(1)}% above spot`
    : `${Math.abs(maxPainDist).toFixed(1)}% below spot`;

  // GEX regime
  const gexPositive = gex.totalGEX >= 0;
  const gexColor = gexPositive ? 'text-accent-green' : 'text-accent-red';
  const gexSub = gexPositive
    ? 'Long gamma — expect mean-reversion'
    : 'Short gamma — expect amplified moves';

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 animate-fade-in">
      <StatCard
        icon={BarChart3}
        label="Volume P/C"
        value={pcr.volumePCR.toFixed(3)}
        subtext={pcrSub}
        color={pcrColor}
      />
      <StatCard
        icon={Activity}
        label="OI P/C"
        value={pcr.oiPCR.toFixed(3)}
        subtext={`Calls: ${formatNumber(pcr.totalCallOI, 0)} | Puts: ${formatNumber(pcr.totalPutOI, 0)}`}
      />
      <StatCard
        icon={Target}
        label="Max Pain"
        value={formatCurrency(maxPain.strike)}
        subtext={maxPainSub}
        color="text-accent-cyan"
      />
      <StatCard
        icon={gexPositive ? TrendingUp : TrendingDown}
        label="Net GEX"
        value={`${gex.totalGEX >= 0 ? '+' : ''}${formatNumber(gex.totalGEX)}`}
        subtext={gexSub}
        color={gexColor}
      />
      <StatCard
        icon={Gauge}
        label="Call Volume"
        value={formatNumber(pcr.totalCallVol, 0)}
        subtext={`${((pcr.totalCallVol / (pcr.totalCallVol + pcr.totalPutVol)) * 100).toFixed(0)}% of total`}
        color="text-accent-green"
      />
      <StatCard
        icon={AlertTriangle}
        label="Put Volume"
        value={formatNumber(pcr.totalPutVol, 0)}
        subtext={`${((pcr.totalPutVol / (pcr.totalCallVol + pcr.totalPutVol)) * 100).toFixed(0)}% of total`}
        color="text-accent-red"
      />
    </div>
  );
}
