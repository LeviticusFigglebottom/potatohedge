'use client';

import { useState } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Crosshair, TrendingUp, TrendingDown, Minus, AlertTriangle,
  ChevronRight, Shield, Zap, Target, ArrowUpRight, ArrowDownRight, Circle,
  BarChart3, Activity, Eye, CheckCircle2,
} from 'lucide-react';
import { buildTrackedTradeFromAlgo, addTrackedTrade, loadTrackedTrades } from '@/lib/tradeTracker';

function BiasGauge({ score, bias }: { score: number; bias: string }) {
  // score: -100 to +100
  const pct = ((score + 100) / 200) * 100; // 0-100
  const color = bias === 'bullish' ? 'text-accent-green' : bias === 'bearish' ? 'text-accent-red' : 'text-accent-amber';
  const bgColor = bias === 'bullish' ? 'bg-accent-green' : bias === 'bearish' ? 'bg-accent-red' : 'bg-accent-amber';
  const label = bias.charAt(0).toUpperCase() + bias.slice(1);

  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Overall Bias</span>
      <div className="w-full max-w-[200px] h-3 rounded-full bg-bg-tertiary relative overflow-hidden">
        <div className="absolute inset-0 flex">
          <div className="flex-1 bg-accent-red/20" />
          <div className="flex-1 bg-accent-amber/20" />
          <div className="flex-1 bg-accent-green/20" />
        </div>
        <div
          className={`absolute top-0 h-full w-3 rounded-full ${bgColor} shadow-lg transition-all`}
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
      <div className="flex items-center gap-2">
        {bias === 'bullish' ? <TrendingUp className={`w-4 h-4 ${color}`} /> :
          bias === 'bearish' ? <TrendingDown className={`w-4 h-4 ${color}`} /> :
          <Minus className={`w-4 h-4 ${color}`} />}
        <span className={`text-xl font-mono font-bold ${color}`}>{label}</span>
        <span className="text-xs font-mono text-text-muted">({score > 0 ? '+' : ''}{score})</span>
      </div>
    </div>
  );
}

function RegimeBadges({ volRegime, gammaRegime }: { volRegime: string; gammaRegime: string }) {
  return (
    <div className="flex flex-wrap gap-2 justify-center">
      <div className={`badge ${volRegime === 'high' ? 'badge-red' : volRegime === 'low' ? 'badge-green' : 'badge-amber'}`}>
        IV: {volRegime === 'high' ? 'Elevated' : volRegime === 'low' ? 'Cheap' : 'Mid-Range'}
      </div>
      <div className={`badge ${gammaRegime === 'long' ? 'badge-green' : gammaRegime === 'short' ? 'badge-red' : 'badge-cyan'}`}>
        γ: {gammaRegime === 'long' ? 'Long Gamma' : gammaRegime === 'short' ? 'Short Gamma' : 'Neutral'}
      </div>
    </div>
  );
}

function SignalConvergence({ signals }: { signals: { name: string; direction: string; weight: number; description: string }[] }) {
  // Group signals into categories for cross-reference analysis
  const categories: { label: string; names: string[]; icon: React.ElementType }[] = [
    { label: 'GEX', names: ['GEX Regime', 'Gamma Flip', 'Dealer Delta'], icon: Shield },
    { label: 'Flow', names: ['Volume P/C Ratio', 'Skew'], icon: BarChart3 },
    { label: 'Levels', names: ['Call Wall Proximity', 'Call Wall Breach', 'Put Wall Proximity', 'Put Wall Breach', 'Max Pain Magnet'], icon: Target },
    { label: 'Vol', names: ['IV Rank', 'IV/HV Spread'], icon: Activity },
    { label: 'Mom', names: ['Momentum'], icon: TrendingUp },
    { label: 'Inst', names: ['Swap Maturity', 'Swap Maturity (Week)', 'Reg SHO Threshold', 'High Short Interest', 'Elevated Short Interest'], icon: BarChart3 },
  ];

  const catSummary = categories.map(cat => {
    const matching = signals.filter(s => cat.names.includes(s.name));
    if (matching.length === 0) return { ...cat, dir: 'neutral' as string, wt: 0 };
    const totalWt = matching.reduce((s, sig) => s + sig.weight, 0);
    const dir = totalWt > 0.05 ? 'bullish' : totalWt < -0.05 ? 'bearish' : 'neutral';
    return { ...cat, dir, wt: totalWt };
  });

  const bullishCount = catSummary.filter(c => c.dir === 'bullish').length;
  const bearishCount = catSummary.filter(c => c.dir === 'bearish').length;
  const total = catSummary.filter(c => c.dir !== 'neutral').length;
  const alignment = total > 0 ? Math.max(bullishCount, bearishCount) / total : 0;
  const dominant = bullishCount > bearishCount ? 'bullish' : bearishCount > bullishCount ? 'bearish' : 'mixed';

  let alignLabel = 'Mixed signals';
  let alignColor = 'text-accent-amber';
  if (alignment >= 0.75) {
    alignLabel = dominant === 'bullish' ? 'Strong bullish alignment' : 'Strong bearish alignment';
    alignColor = dominant === 'bullish' ? 'text-accent-green' : 'text-accent-red';
  } else if (alignment >= 0.5) {
    alignLabel = dominant === 'bullish' ? 'Moderate bullish lean' : dominant === 'bearish' ? 'Moderate bearish lean' : 'Conflicting signals';
    alignColor = dominant === 'mixed' ? 'text-accent-amber' : dominant === 'bullish' ? 'text-accent-green/70' : 'text-accent-red/70';
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Signal Convergence</span>
        <span className={`text-xs font-mono font-semibold ${alignColor}`}>{alignLabel}</span>
      </div>
      <div className="flex gap-1.5">
        {catSummary.map(cat => {
          const CatIcon = cat.icon;
          const bg = cat.dir === 'bullish' ? 'bg-green-500/15 border-green-500/30 text-green-400'
            : cat.dir === 'bearish' ? 'bg-red-500/15 border-red-500/30 text-red-400'
            : 'bg-bg-tertiary border-border/30 text-text-muted';
          return (
            <div key={cat.label} className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-mono ${bg}`}>
              <CatIcon className="w-3 h-3" />
              <span>{cat.label}</span>
              <span className="font-semibold">
                {cat.dir === 'bullish' ? '↑' : cat.dir === 'bearish' ? '↓' : '–'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SignalsList({ signals }: { signals: { name: string; direction: string; weight: number; description: string }[] }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-accent-cyan" />
          Signal Breakdown
        </span>
      </div>
      <div className="divide-y divide-border/20">
        {signals.map((sig, i) => (
          <div key={i} className="px-4 py-2 flex items-start gap-3">
            <div className="mt-1 shrink-0">
              {sig.direction === 'bullish' ? <ArrowUpRight className="w-3.5 h-3.5 text-accent-green" /> :
                sig.direction === 'bearish' ? <ArrowDownRight className="w-3.5 h-3.5 text-accent-red" /> :
                <Circle className="w-3 h-3 text-accent-amber" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-mono font-semibold text-text-primary">{sig.name}</span>
                <span className={`text-[10px] font-mono ${sig.weight > 0 ? 'text-accent-green' : sig.weight < 0 ? 'text-accent-red' : 'text-text-muted'}`}>
                  {sig.weight > 0 ? '+' : ''}{(sig.weight * 100).toFixed(0)}
                </span>
              </div>
              <span className="text-xs text-text-muted leading-relaxed">{sig.description}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TradeCard({ trade, onTrack, tracked }: { trade: {
  strategy: string; direction: string; confidence: string; score: number;
  expiration: string; strikes: string; entry: string; risk: string;
  reasoning: string[]; tags: string[];
  profitTargetPct?: number; stopLossPct?: number;
}; onTrack?: () => void; tracked?: boolean }) {
  const dirColor = trade.direction === 'bullish' ? 'text-accent-green' :
    trade.direction === 'bearish' ? 'text-accent-red' : 'text-accent-cyan';
  const dirBg = trade.direction === 'bullish' ? 'border-accent-green/30' :
    trade.direction === 'bearish' ? 'border-accent-red/30' : 'border-accent-cyan/30';
  const confColor = trade.confidence === 'high' ? 'text-accent-green' :
    trade.confidence === 'medium' ? 'text-accent-amber' : 'text-text-muted';

  return (
    <div className={`panel border ${dirBg}`}>
      <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Target className={`w-4 h-4 ${dirColor}`} />
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{trade.strategy}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={`text-[10px] font-mono uppercase ${dirColor}`}>{trade.direction}</span>
              <span className="text-text-muted text-[10px]">•</span>
              <span className={`text-[10px] font-mono ${confColor}`}>{trade.confidence} confidence</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className={`text-xl font-mono font-bold ${dirColor}`}>{trade.score}</div>
            <div className="text-[10px] text-text-muted">/100</div>
          </div>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3 text-sm">
        <div>
          <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Expiration</span>
          <p className="text-text-secondary mt-0.5">{trade.expiration}</p>
        </div>
        <div>
          <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Strikes</span>
          <p className="text-text-secondary mt-0.5">{trade.strikes}</p>
        </div>
        <div>
          <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Entry</span>
          <p className="text-text-secondary mt-0.5">{trade.entry}</p>
        </div>
        <div>
          <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Risk Management</span>
          <p className="text-text-secondary mt-0.5">{trade.risk}</p>
        </div>

        <div>
          <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Why This Trade</span>
          <ul className="mt-1 space-y-1">
            {trade.reasoning.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-text-secondary text-xs">
                <ChevronRight className="w-3 h-3 mt-0.5 text-text-muted shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="flex flex-wrap gap-1.5">
            {trade.tags.map((tag) => (
              <span key={tag} className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted">
                {tag}
              </span>
            ))}
          </div>
          {onTrack && (
            tracked ? (
              <span className="text-xs font-mono text-accent-green flex items-center gap-1 shrink-0">
                <CheckCircle2 className="w-3.5 h-3.5" /> Tracked
              </span>
            ) : (
              <button
                onClick={onTrack}
                className="px-3 py-1.5 rounded-md text-xs font-mono bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/25 hover:bg-accent-cyan/25 transition-all flex items-center gap-1.5 shrink-0"
              >
                <Eye className="w-3.5 h-3.5" /> Track
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default function RecommendationsPanel() {
  const { recommendations, loading, symbol, quote, multiGEX, snapshot, expirations } = useDashboardStore();
  const [trackedIds, setTrackedIds] = useState<Set<string>>(new Set());

  const handleTrackTrade = (trade: typeof recommendations extends null ? never : NonNullable<typeof recommendations>['trades'][number], idx: number) => {
    if (!recommendations || !quote) return;
    const nearestExp = expirations[0]?.date || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const tracked = buildTrackedTradeFromAlgo({
      symbol,
      spotPrice: quote.last,
      trade: {
        ...trade,
        profitTargetPct: (trade as { profitTargetPct?: number }).profitTargetPct,
        stopLossPct: (trade as { stopLossPct?: number }).stopLossPct,
      },
      marketSnapshot: {
        ivRank: snapshot?.iv?.ivRank ?? 0,
        currentIV: snapshot?.iv?.currentIV ?? 0,
        hvCurrent: snapshot?.iv?.hvCurrent ?? 0,
        totalGEX: multiGEX?.aggregated?.totalGEX ?? 0,
        gammaFlip: multiGEX?.aggregated?.gammaFlip ?? null,
        callWall: multiGEX?.aggregated?.callWall ?? null,
        putWall: multiGEX?.aggregated?.putWall ?? null,
        biasScore: recommendations.biasScore,
        overallBias: recommendations.overallBias,
        volRegime: recommendations.volRegime,
        gammaRegime: recommendations.gammaRegime,
      },
      source: 'algorithm',
      nearestExp,
    });

    addTrackedTrade(tracked);
    setTrackedIds(prev => new Set(prev).add(`algo-${idx}`));
  };

  if (loading.recommendations && !recommendations) {
    return (
      <div className="panel p-6 flex items-center justify-center">
        <div className="flex items-center gap-3 text-text-muted font-mono text-sm">
          <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
          Analyzing {symbol} — computing trade recommendations...
        </div>
      </div>
    );
  }

  if (!recommendations) return null;

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header: Bias + Regimes + Stock Context */}
      <div className="panel p-4">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <BiasGauge score={recommendations.biasScore} bias={recommendations.overallBias} />
          <div className="flex flex-col gap-3 items-center md:items-end">
            <RegimeBadges volRegime={recommendations.volRegime} gammaRegime={recommendations.gammaRegime} />
            <SignalConvergence signals={recommendations.signals} />
          </div>
        </div>
        {(recommendations.stockContext || recommendations.moveContext) && (
          <div className="mt-3 pt-3 border-t border-border/30 space-y-1">
            {recommendations.stockContext && (
              <p className="text-xs font-mono text-text-muted text-center">{recommendations.stockContext}</p>
            )}
            {recommendations.moveContext && (
              <p className="text-xs font-mono text-text-secondary text-center">{recommendations.moveContext}</p>
            )}
          </div>
        )}
      </div>

      {/* Warnings */}
      {recommendations.warnings.length > 0 && (
        <div className="panel border border-accent-amber/30">
          <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-accent-amber" />
            <span className="text-xs font-mono font-semibold text-accent-amber uppercase tracking-wider">Warnings</span>
          </div>
          <div className="px-4 py-2 space-y-1">
            {recommendations.warnings.map((w, i) => (
              <p key={i} className="text-sm text-text-secondary flex items-start gap-2">
                <span className="text-accent-amber shrink-0">•</span>
                {w}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Trade Ideas */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Crosshair className="w-4 h-4 text-accent-cyan" />
          <h2 className="text-sm font-mono font-semibold uppercase tracking-wider text-text-secondary">
            Trade Ideas — {symbol}
          </h2>
        </div>
        {recommendations.trades.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {recommendations.trades.map((trade, i) => (
              <TradeCard
                key={i}
                trade={trade}
                onTrack={() => handleTrackTrade(trade, i)}
                tracked={trackedIds.has(`algo-${i}`)}
              />
            ))}
          </div>
        ) : (
          <div className="panel p-4 text-center text-text-muted text-sm font-mono">
            No high-confidence trades identified. Wait for clearer signals.
          </div>
        )}
      </div>

      {/* Signal Breakdown */}
      <SignalsList signals={recommendations.signals} />
    </div>
  );
}
