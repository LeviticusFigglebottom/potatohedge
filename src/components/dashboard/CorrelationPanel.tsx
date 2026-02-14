'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  TrendingUp, TrendingDown, Minus, Activity, BarChart3,
  ArrowUpRight, ArrowDownRight, AlertTriangle, Target,
  Shuffle, Zap, Shield, Gauge, ChevronRight,
} from 'lucide-react';
import type { CorrelationResult, Anomaly, CorrelationInsight } from '@/lib/math/correlations';

// ─── Sub-Components ───────────────────────────────────────────

function InsightBadge({ insight }: { insight: CorrelationInsight }) {
  const color = insight.direction === 'bullish'
    ? 'border-green-500/30 bg-green-500/10 text-green-400'
    : insight.direction === 'bearish'
    ? 'border-red-500/30 bg-red-500/10 text-red-400'
    : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400';

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${color}`}>
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] font-mono uppercase tracking-wider opacity-70">{insight.label}</span>
        <span className="text-sm font-mono font-semibold">{insight.value}</span>
      </div>
      <div className="ml-auto">
        <div
          className="h-1 rounded-full"
          style={{
            width: `${Math.min(40, insight.strength * 0.4)}px`,
            backgroundColor: insight.direction === 'bullish' ? '#00e676' : insight.direction === 'bearish' ? '#ff3d57' : '#00d4ff',
            opacity: 0.6,
          }}
        />
      </div>
    </div>
  );
}

function StatRow({ icon: Icon, label, value, subtext, color }: {
  icon: React.ElementType; label: string; value: string; subtext?: string; color?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <Icon className={`w-3.5 h-3.5 shrink-0 ${color || 'text-text-muted'}`} />
      <div className="flex-1 min-w-0">
        <span className="text-xs font-mono text-text-muted">{label}</span>
      </div>
      <div className="text-right">
        <div className={`text-sm font-mono font-semibold ${color || 'text-text-primary'}`}>{value}</div>
        {subtext && <div className="text-[10px] font-mono text-text-muted">{subtext}</div>}
      </div>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, color }: { icon: React.ElementType; title: string; color?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border/30 bg-bg-tertiary/30">
      <Icon className={`w-3.5 h-3.5 ${color || 'text-accent-cyan'}`} />
      <span className="text-xs font-mono font-semibold uppercase tracking-wider text-text-secondary">{title}</span>
    </div>
  );
}

function AnomalyCard({ anomaly }: { anomaly: Anomaly }) {
  const borderColor = anomaly.type === 'bullish' ? 'border-green-500/30'
    : anomaly.type === 'bearish' ? 'border-red-500/30'
    : 'border-amber-500/30';
  const iconColor = anomaly.type === 'bullish' ? 'text-accent-green'
    : anomaly.type === 'bearish' ? 'text-accent-red'
    : 'text-accent-amber';
  const Icon = anomaly.type === 'bullish' ? ArrowUpRight
    : anomaly.type === 'bearish' ? ArrowDownRight
    : AlertTriangle;
  const strengthDot = anomaly.strength === 'strong' ? 'bg-accent-cyan' : anomaly.strength === 'moderate' ? 'bg-accent-amber' : 'bg-text-muted';

  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded border ${borderColor} bg-bg-secondary`}>
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${iconColor}`} />
      <span className="text-xs text-text-secondary leading-relaxed">{anomaly.description}</span>
      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${strengthDot}`} title={anomaly.strength} />
    </div>
  );
}

function IVRegimeChart({ data }: { data: CorrelationResult['ivRegime'] }) {
  const buckets = [
    { label: 'Low Vol', data: data.lowIV, color: '#00e676' },
    { label: 'Mid Vol', data: data.midIV, color: '#ffaa00' },
    { label: 'High Vol', data: data.highIV, color: '#ff3d57' },
  ];

  const maxRet = Math.max(
    ...buckets.map(b => Math.abs(b.data.avgReturn20d)),
    0.01
  );

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">20-Day Avg Return by Vol Regime</div>
      {buckets.map(b => {
        const pct = b.data.avgReturn20d;
        const barWidth = Math.abs(pct) / maxRet * 100;
        const isPositive = pct >= 0;
        return (
          <div key={b.label} className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-text-muted w-14 shrink-0">{b.label}</span>
            <div className="flex-1 h-4 relative bg-bg-tertiary rounded overflow-hidden">
              <div className="absolute inset-0 flex items-center">
                <div className="w-1/2" />
                <div className="w-px h-full bg-border/40" />
                <div className="w-1/2" />
              </div>
              <div
                className="absolute top-0 h-full rounded transition-all"
                style={{
                  width: `${barWidth / 2}%`,
                  left: isPositive ? '50%' : `${50 - barWidth / 2}%`,
                  backgroundColor: b.color,
                  opacity: 0.5,
                }}
              />
            </div>
            <span className={`text-[11px] font-mono font-semibold w-14 text-right ${pct > 0 ? 'text-accent-green' : pct < 0 ? 'text-accent-red' : 'text-text-muted'}`}>
              {pct > 0 ? '+' : ''}{(pct * 100).toFixed(1)}%
            </span>
            <span className="text-[10px] font-mono text-text-muted w-8 text-right">n={b.data.sampleSize}</span>
          </div>
        );
      })}
      {data.insight && (
        <p className="text-[11px] font-mono text-text-muted mt-1 leading-relaxed">{data.insight}</p>
      )}
    </div>
  );
}

function DrawdownRallyChart({ data }: { data: CorrelationResult['marketRelative'] }) {
  const dd = data.drawdownBehavior;
  const rally = data.rallyBehavior;

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Behavior During Market Moves</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <TrendingDown className="w-3 h-3 text-accent-red" />
            <span className="text-[10px] font-mono text-text-muted">SPY Drawdowns</span>
          </div>
          <div className="text-xs font-mono">
            <span className="text-text-muted">SPY avg: </span>
            <span className="text-accent-red">{(dd.avgMarketDd * 100).toFixed(1)}%</span>
          </div>
          <div className="text-xs font-mono">
            <span className="text-text-muted">Stock avg: </span>
            <span className={dd.avgStockDd < dd.avgMarketDd ? 'text-accent-red' : 'text-accent-green'}>
              {(dd.avgStockDd * 100).toFixed(1)}%
            </span>
          </div>
          <div className="text-[10px] font-mono text-text-muted">
            ({dd.ratio.toFixed(1)}x SPY · {dd.count} events)
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <TrendingUp className="w-3 h-3 text-accent-green" />
            <span className="text-[10px] font-mono text-text-muted">SPY Rallies</span>
          </div>
          <div className="text-xs font-mono">
            <span className="text-text-muted">SPY avg: </span>
            <span className="text-accent-green">+{(rally.avgMarketRally * 100).toFixed(1)}%</span>
          </div>
          <div className="text-xs font-mono">
            <span className="text-text-muted">Stock avg: </span>
            <span className={rally.avgStockRally > rally.avgMarketRally ? 'text-accent-green' : 'text-accent-amber'}>
              +{(rally.avgStockRally * 100).toFixed(1)}%
            </span>
          </div>
          <div className="text-[10px] font-mono text-text-muted">
            ({rally.ratio.toFixed(1)}x SPY · {rally.count} events)
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

export default function CorrelationPanel() {
  const { correlations, loading, symbol } = useDashboardStore();

  if (loading.correlations && !correlations) {
    return (
      <div className="panel p-6 flex items-center justify-center">
        <div className="flex items-center gap-3 text-text-muted font-mono text-sm">
          <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
          Analyzing {symbol} correlations &amp; cross-references...
        </div>
      </div>
    );
  }

  if (!correlations) return null;

  const c = correlations;

  return (
    <div className="space-y-3 animate-fade-in">
      {/* Top Insights */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title flex items-center gap-2">
            <Shuffle className="w-3.5 h-3.5 text-accent-cyan" />
            Correlations &amp; Cross-References — {symbol}
          </span>
          <span className="text-[10px] font-mono text-text-muted">
            {c.dataRange.bars} bars · {c.dataRange.from} → {c.dataRange.to}
          </span>
        </div>

        {/* Strongest Insights Grid */}
        {c.strongestInsights.length > 0 && (
          <div className="p-4">
            <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">Strongest Signals</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {c.strongestInsights.slice(0, 8).map((insight, i) => (
                <InsightBadge key={i} insight={insight} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Market Relative */}
        <div className="panel">
          <SectionHeader icon={BarChart3} title="Market Relative (vs SPY)" />
          <div className="divide-y divide-border/20">
            <StatRow icon={Activity} label="Beta" value={c.marketRelative.beta.toFixed(2)}
              subtext={`Correlation: ${c.marketRelative.correlation.toFixed(2)}`}
              color={c.marketRelative.beta > 1.3 ? 'text-accent-red' : c.marketRelative.beta < 0.7 ? 'text-accent-green' : 'text-text-primary'} />
            <StatRow icon={TrendingUp} label="30d Alpha" value={`${c.marketRelative.alpha30d > 0 ? '+' : ''}${(c.marketRelative.alpha30d * 100).toFixed(1)}%`}
              subtext={`90d: ${c.marketRelative.alpha90d > 0 ? '+' : ''}${(c.marketRelative.alpha90d * 100).toFixed(1)}%`}
              color={c.marketRelative.alpha30d > 0.01 ? 'text-accent-green' : c.marketRelative.alpha30d < -0.01 ? 'text-accent-red' : 'text-text-primary'} />
            <DrawdownRallyChart data={c.marketRelative} />
          </div>
          {c.marketRelative.insight && (
            <div className="px-4 py-2 border-t border-border/30">
              <p className="text-[11px] font-mono text-text-muted leading-relaxed">{c.marketRelative.insight}</p>
            </div>
          )}
        </div>

        {/* IV Regime Performance */}
        <div className="panel">
          <SectionHeader icon={Gauge} title="Performance by Vol Regime" color="text-accent-purple" />
          <IVRegimeChart data={c.ivRegime} />
          <div className="divide-y divide-border/20 border-t border-border/30">
            <StatRow icon={Target} label="Low-Vol Win Rate (5d)" value={`${(c.ivRegime.lowIV.winRate5d * 100).toFixed(0)}%`}
              subtext={`n=${c.ivRegime.lowIV.sampleSize}`}
              color={c.ivRegime.lowIV.winRate5d > 0.55 ? 'text-accent-green' : 'text-text-primary'} />
            <StatRow icon={AlertTriangle} label="High-Vol Win Rate (5d)" value={`${(c.ivRegime.highIV.winRate5d * 100).toFixed(0)}%`}
              subtext={`n=${c.ivRegime.highIV.sampleSize}`}
              color={c.ivRegime.highIV.winRate5d > 0.55 ? 'text-accent-green' : 'text-text-primary'} />
          </div>
        </div>

        {/* Vol Pricing */}
        <div className="panel">
          <SectionHeader icon={Zap} title="Volatility Pricing Accuracy" color="text-accent-amber" />
          <div className="divide-y divide-border/20">
            <StatRow icon={Shield} label="Overpricing Rate" value={`${(c.volPricing.overPricingRate * 100).toFixed(0)}%`}
              subtext="% of time IV > realized"
              color={c.volPricing.overPricingRate > 0.6 ? 'text-accent-green' : c.volPricing.overPricingRate < 0.45 ? 'text-accent-red' : 'text-text-primary'} />
            <StatRow icon={Activity} label="Avg Implied 5d Move" value={`${(c.volPricing.avgImpliedMove * 100).toFixed(2)}%`}
              subtext={`Realized: ${(c.volPricing.avgRealizedMove * 100).toFixed(2)}%`} />
          </div>
          {c.volPricing.insight && (
            <div className="px-4 py-2 border-t border-border/30">
              <p className="text-[11px] font-mono text-text-muted leading-relaxed">{c.volPricing.insight}</p>
            </div>
          )}
        </div>

        {/* Mean Reversion */}
        <div className="panel">
          <SectionHeader icon={Shuffle} title="Mean Reversion Tendency" />
          <div className="divide-y divide-border/20">
            <div className="px-4 py-3">
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">After 2σ+ Drops</div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[10px] font-mono text-text-muted">Bounce Rate</div>
                  <div className={`text-sm font-mono font-semibold ${c.meanReversion.afterBigDown.reversalRate > 0.55 ? 'text-accent-green' : 'text-text-primary'}`}>
                    {(c.meanReversion.afterBigDown.reversalRate * 100).toFixed(0)}%
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-text-muted">Avg Next Day</div>
                  <div className={`text-sm font-mono font-semibold ${c.meanReversion.afterBigDown.avgNextDayReturn > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {c.meanReversion.afterBigDown.avgNextDayReturn > 0 ? '+' : ''}{(c.meanReversion.afterBigDown.avgNextDayReturn * 100).toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-text-muted">Avg 5d Return</div>
                  <div className={`text-sm font-mono font-semibold ${c.meanReversion.afterBigDown.avgNext5dReturn > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {c.meanReversion.afterBigDown.avgNext5dReturn > 0 ? '+' : ''}{(c.meanReversion.afterBigDown.avgNext5dReturn * 100).toFixed(2)}%
                  </div>
                </div>
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-1">n={c.meanReversion.afterBigDown.sampleSize}</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">After 2σ+ Rallies</div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[10px] font-mono text-text-muted">Pullback Rate</div>
                  <div className={`text-sm font-mono font-semibold ${c.meanReversion.afterBigUp.reversalRate > 0.55 ? 'text-accent-amber' : 'text-text-primary'}`}>
                    {(c.meanReversion.afterBigUp.reversalRate * 100).toFixed(0)}%
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-text-muted">Avg Next Day</div>
                  <div className={`text-sm font-mono font-semibold ${c.meanReversion.afterBigUp.avgNextDayReturn > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {c.meanReversion.afterBigUp.avgNextDayReturn > 0 ? '+' : ''}{(c.meanReversion.afterBigUp.avgNextDayReturn * 100).toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-text-muted">Avg 5d Return</div>
                  <div className={`text-sm font-mono font-semibold ${c.meanReversion.afterBigUp.avgNext5dReturn > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {c.meanReversion.afterBigUp.avgNext5dReturn > 0 ? '+' : ''}{(c.meanReversion.afterBigUp.avgNext5dReturn * 100).toFixed(2)}%
                  </div>
                </div>
              </div>
              <div className="text-[10px] font-mono text-text-muted mt-1">n={c.meanReversion.afterBigUp.sampleSize}</div>
            </div>
          </div>
          {c.meanReversion.insight && (
            <div className="px-4 py-2 border-t border-border/30">
              <p className="text-[11px] font-mono text-text-muted leading-relaxed">{c.meanReversion.insight}</p>
            </div>
          )}
        </div>
      </div>

      {/* Sector Relative + Volume Dynamics row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Sector Relative */}
        {c.sectorRelative && (
          <div className="panel">
            <SectionHeader icon={Target} title={`Sector Relative (vs ${c.sectorRelative.sectorETF})`} color="text-accent-purple" />
            <div className="divide-y divide-border/20">
              <StatRow icon={Activity} label="Sector Correlation" value={c.sectorRelative.correlation.toFixed(2)}
                color={c.sectorRelative.correlation < 0.5 ? 'text-accent-amber' : 'text-text-primary'} />
              <StatRow icon={TrendingUp} label="Relative Strength 30d"
                value={`${c.sectorRelative.relativeStrength30d > 0 ? '+' : ''}${(c.sectorRelative.relativeStrength30d * 100).toFixed(1)}%`}
                subtext={`90d: ${c.sectorRelative.relativeStrength90d > 0 ? '+' : ''}${(c.sectorRelative.relativeStrength90d * 100).toFixed(1)}%`}
                color={c.sectorRelative.relativeStrength30d > 0.02 ? 'text-accent-green' : c.sectorRelative.relativeStrength30d < -0.02 ? 'text-accent-red' : 'text-text-primary'} />
              <StatRow icon={Shuffle} label="Divergence Days (60d)" value={`${c.sectorRelative.divergenceDays}`}
                subtext={c.sectorRelative.divergenceDays > 15 ? 'High divergence' : 'Normal tracking'}
                color={c.sectorRelative.divergenceDays > 15 ? 'text-accent-amber' : 'text-text-primary'} />
            </div>
            {c.sectorRelative.insight && (
              <div className="px-4 py-2 border-t border-border/30">
                <p className="text-[11px] font-mono text-text-muted leading-relaxed">{c.sectorRelative.insight}</p>
              </div>
            )}
          </div>
        )}

        {/* Volume Dynamics */}
        <div className="panel">
          <SectionHeader icon={BarChart3} title="Volume-Price Dynamics" color="text-accent-green" />
          <div className="divide-y divide-border/20">
            <StatRow icon={TrendingUp} label="High-Vol Up Day %" value={`${(c.volumeDynamics.highVolUpDayPct * 100).toFixed(0)}%`}
              color={c.volumeDynamics.highVolUpDayPct > 0.58 ? 'text-accent-green' : c.volumeDynamics.highVolUpDayPct < 0.42 ? 'text-accent-red' : 'text-text-primary'} />
            <StatRow icon={Activity} label="Avg Return (High Vol)" value={`${c.volumeDynamics.avgReturnHighVol > 0 ? '+' : ''}${(c.volumeDynamics.avgReturnHighVol * 100).toFixed(2)}%`}
              subtext={`Low vol: ${c.volumeDynamics.avgReturnLowVol > 0 ? '+' : ''}${(c.volumeDynamics.avgReturnLowVol * 100).toFixed(2)}%`} />
            <StatRow icon={ChevronRight} label="Vol Surge Follow-Through" value={`${(c.volumeDynamics.volSurgeFollowThrough * 100).toFixed(0)}%`}
              subtext="Continuation rate after surges"
              color={c.volumeDynamics.volSurgeFollowThrough > 0.58 ? 'text-accent-cyan' : 'text-text-primary'} />
          </div>
          {c.volumeDynamics.insight && (
            <div className="px-4 py-2 border-t border-border/30">
              <p className="text-[11px] font-mono text-text-muted leading-relaxed">{c.volumeDynamics.insight}</p>
            </div>
          )}
        </div>
      </div>

      {/* Regime Performance Heatmap */}
      <div className="panel">
        <SectionHeader icon={Activity} title="Regime Performance Heatmap" color="text-accent-cyan" />
        <div className="px-4 py-3">
          <div className="text-[10px] text-text-muted font-mono mb-3">Win rates and avg returns across different market conditions</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-2 py-1.5 text-left text-[10px] text-text-muted font-normal">Condition</th>
                  <th className="px-2 py-1.5 text-center text-[10px] text-text-muted font-normal">Win Rate (5d)</th>
                  <th className="px-2 py-1.5 text-center text-[10px] text-text-muted font-normal">Avg Return (20d)</th>
                  <th className="px-2 py-1.5 text-center text-[10px] text-text-muted font-normal">Sample</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    label: 'Low Volatility',
                    winRate: c.ivRegime.lowIV.winRate5d,
                    avgReturn: c.ivRegime.lowIV.avgReturn20d,
                    sample: c.ivRegime.lowIV.sampleSize,
                    icon: '🟢',
                  },
                  {
                    label: 'Mid Volatility',
                    winRate: c.ivRegime.midIV.winRate5d,
                    avgReturn: c.ivRegime.midIV.avgReturn20d,
                    sample: c.ivRegime.midIV.sampleSize,
                    icon: '🟡',
                  },
                  {
                    label: 'High Volatility',
                    winRate: c.ivRegime.highIV.winRate5d,
                    avgReturn: c.ivRegime.highIV.avgReturn20d,
                    sample: c.ivRegime.highIV.sampleSize,
                    icon: '🔴',
                  },
                  {
                    label: 'Post SPY Drawdown',
                    winRate: c.meanReversion.afterBigDown.reversalRate,
                    avgReturn: c.meanReversion.afterBigDown.avgNext5dReturn * 4,
                    sample: c.meanReversion.afterBigDown.sampleSize,
                    icon: '📉',
                  },
                  {
                    label: 'Post SPY Rally',
                    winRate: 1 - c.meanReversion.afterBigUp.reversalRate,
                    avgReturn: c.meanReversion.afterBigUp.avgNext5dReturn * 4,
                    sample: c.meanReversion.afterBigUp.sampleSize,
                    icon: '📈',
                  },
                ].map(row => {
                  const wrPct = row.winRate * 100;
                  const retPct = row.avgReturn * 100;
                  const wrColor = wrPct >= 60 ? 'bg-green-500/30 text-green-400' : wrPct >= 55 ? 'bg-green-500/15 text-green-400' : wrPct >= 45 ? 'bg-bg-tertiary text-text-secondary' : wrPct >= 40 ? 'bg-red-500/15 text-red-400' : 'bg-red-500/30 text-red-400';
                  const retColor = retPct >= 2 ? 'bg-green-500/30 text-green-400' : retPct >= 0.5 ? 'bg-green-500/15 text-green-400' : retPct >= -0.5 ? 'bg-bg-tertiary text-text-secondary' : retPct >= -2 ? 'bg-red-500/15 text-red-400' : 'bg-red-500/30 text-red-400';
                  return (
                    <tr key={row.label} className="border-b border-border/10">
                      <td className="px-2 py-2 text-text-secondary">{row.label}</td>
                      <td className="px-2 py-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded ${wrColor} font-semibold`}>
                          {row.sample > 0 ? `${wrPct.toFixed(0)}%` : '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded ${retColor} font-semibold`}>
                          {row.sample > 0 ? `${retPct > 0 ? '+' : ''}${retPct.toFixed(1)}%` : '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center text-text-muted">{row.sample > 0 ? `n=${row.sample}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Market Relative Summary Bar */}
          <div className="mt-4 pt-3 border-t border-border/20">
            <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-2">Market Sensitivity</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                { label: 'Beta', value: c.marketRelative.beta.toFixed(2), color: c.marketRelative.beta > 1.3 ? 'bg-red-500/20 border-red-500/30 text-red-400' : c.marketRelative.beta < 0.7 ? 'bg-green-500/20 border-green-500/30 text-green-400' : 'bg-bg-tertiary border-border/30 text-text-primary' },
                { label: 'SPY Corr', value: c.marketRelative.correlation.toFixed(2), color: c.marketRelative.correlation > 0.7 ? 'bg-amber-500/15 border-amber-500/20 text-amber-400' : 'bg-bg-tertiary border-border/30 text-text-primary' },
                { label: 'DD Ratio', value: `${c.marketRelative.drawdownBehavior.ratio.toFixed(1)}x`, color: c.marketRelative.drawdownBehavior.ratio > 1.5 ? 'bg-red-500/20 border-red-500/30 text-red-400' : 'bg-bg-tertiary border-border/30 text-text-primary' },
                { label: 'Rally Ratio', value: `${c.marketRelative.rallyBehavior.ratio.toFixed(1)}x`, color: c.marketRelative.rallyBehavior.ratio > 1.3 ? 'bg-green-500/20 border-green-500/30 text-green-400' : 'bg-bg-tertiary border-border/30 text-text-primary' },
              ].map(item => (
                <div key={item.label} className={`flex flex-col items-center px-3 py-2 rounded-lg border ${item.color}`}>
                  <span className="text-[9px] font-mono opacity-60">{item.label}</span>
                  <span className="text-sm font-mono font-bold">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Anomalies */}
      {c.anomalies.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-accent-amber" />
              Anomalies &amp; Notable Patterns
            </span>
          </div>
          <div className="p-4 space-y-2">
            {c.anomalies.map((a, i) => (
              <AnomalyCard key={i} anomaly={a} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
