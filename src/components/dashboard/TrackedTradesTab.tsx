'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart3, TrendingUp, TrendingDown, Minus, Target, Clock, CheckCircle2,
  XCircle, AlertTriangle, Trash2, X as XIcon, ChevronDown, ChevronUp,
  Activity, Award, Percent, DollarSign, Timer, Crosshair, Eye,
} from 'lucide-react';
import {
  loadTrackedTrades, loadTrackedTradesWithSync, removeTrackedTrade,
  computeAnalytics, type TrackedTrade, type TradeAnalytics, type TradeStatus,
} from '@/lib/tradeTracker';

// ─── Filter Types ───────────────────────────────────────────

type FilterStatus = 'all' | TradeStatus;
type FilterSource = 'all' | 'algorithm' | 'ai-briefing' | 'ai-analysis';
type SortField = 'date' | 'symbol' | 'pl' | 'status';

// ─── Stat Card ──────────────────────────────────────────────

function StatCard({ label, value, subValue, icon: Icon, color }: {
  label: string; value: string; subValue?: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <div className="panel px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-lg font-mono font-bold ${color}`}>{value}</div>
      {subValue && <div className="text-[10px] font-mono text-text-muted mt-0.5">{subValue}</div>}
    </div>
  );
}

// ─── Analytics Overview ─────────────────────────────────────

function AnalyticsOverview({ analytics }: { analytics: TradeAnalytics }) {
  if (analytics.totalTrades === 0) return null;

  const winRateColor = analytics.winRate >= 0.55 ? 'text-accent-green' : analytics.winRate >= 0.45 ? 'text-accent-amber' : 'text-accent-red';
  const plColor = analytics.totalPL >= 0 ? 'text-accent-green' : 'text-accent-red';
  const pfColor = analytics.profitFactor >= 1.5 ? 'text-accent-green' : analytics.profitFactor >= 1.0 ? 'text-accent-amber' : 'text-accent-red';

  return (
    <div className="space-y-4">
      {/* Top Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        <StatCard label="Total Trades" value={String(analytics.totalTrades)} subValue={`${analytics.openTrades} open · ${analytics.closedTrades} closed`} icon={BarChart3} color="text-accent-cyan" />
        <StatCard label="Win Rate" value={analytics.closedTrades > 0 ? `${(analytics.winRate * 100).toFixed(1)}%` : '—'} subValue={`${analytics.wins}W ${analytics.losses}L ${analytics.breakeven}BE`} icon={Award} color={winRateColor} />
        <StatCard label="Total P/L" value={analytics.closedTrades > 0 ? `$${analytics.totalPL.toFixed(0)}` : '—'} subValue={analytics.closedTrades > 0 ? `Avg: $${analytics.avgPL.toFixed(0)} per trade` : undefined} icon={DollarSign} color={plColor} />
        <StatCard label="Profit Factor" value={analytics.closedTrades > 0 ? (analytics.profitFactor === Infinity ? '∞' : analytics.profitFactor.toFixed(2)) : '—'} subValue="Gross wins / gross losses" icon={Percent} color={pfColor} />
        <StatCard label="Avg Win" value={analytics.wins > 0 ? `+${analytics.avgWinPct.toFixed(1)}%` : '—'} icon={TrendingUp} color="text-accent-green" />
        <StatCard label="Avg Loss" value={analytics.losses > 0 ? `${analytics.avgLossPct.toFixed(1)}%` : '—'} subValue={analytics.avgHoldingDays > 0 ? `Avg hold: ${analytics.avgHoldingDays.toFixed(1)}d` : undefined} icon={TrendingDown} color="text-accent-red" />
      </div>

      {/* Best/Worst */}
      {(analytics.bestTrade || analytics.worstTrade) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {analytics.bestTrade && (
            <div className="panel px-4 py-2 border border-green-500/20">
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-1">Best Trade</div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-text-primary">{analytics.bestTrade.symbol} — {analytics.bestTrade.strategy}</span>
                <span className="text-sm font-mono font-bold text-accent-green">+{analytics.bestTrade.plPct.toFixed(1)}%</span>
              </div>
            </div>
          )}
          {analytics.worstTrade && (
            <div className="panel px-4 py-2 border border-red-500/20">
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-1">Worst Trade</div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-text-primary">{analytics.worstTrade.symbol} — {analytics.worstTrade.strategy}</span>
                <span className="text-sm font-mono font-bold text-accent-red">{analytics.worstTrade.plPct.toFixed(1)}%</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Breakdown Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* By Source */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title text-xs">By Source</span>
          </div>
          <div className="divide-y divide-border/10">
            {Object.entries(analytics.bySource).filter(([, v]) => v.count > 0).map(([src, data]) => (
              <div key={src} className="px-3 py-2 flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-text-primary">{src === 'algorithm' ? 'Algorithm' : src === 'ai-briefing' ? 'AI Briefing' : 'AI Analysis'}</span>
                  <span className="text-[10px] font-mono text-text-muted ml-2">{data.count} trades</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-mono ${data.winRate >= 0.5 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {(data.winRate * 100).toFixed(0)}% WR
                  </span>
                  <span className={`text-xs font-mono ${data.avgPL >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    ${data.avgPL.toFixed(0)}/trade
                  </span>
                </div>
              </div>
            ))}
            {Object.values(analytics.bySource).every(v => v.count === 0) && (
              <div className="px-3 py-2 text-xs text-text-muted font-mono">No closed trades yet</div>
            )}
          </div>
        </div>

        {/* By Strategy */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title text-xs">By Strategy</span>
          </div>
          <div className="divide-y divide-border/10 max-h-48 overflow-y-auto">
            {Object.entries(analytics.byStrategy).sort((a, b) => b[1].count - a[1].count).map(([strat, data]) => (
              <div key={strat} className="px-3 py-2 flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-text-primary truncate max-w-[140px] inline-block">{strat}</span>
                  <span className="text-[10px] font-mono text-text-muted ml-2">{data.count}</span>
                </div>
                <span className={`text-xs font-mono ${data.winRate >= 0.5 ? 'text-accent-green' : 'text-accent-red'}`}>
                  {(data.winRate * 100).toFixed(0)}%
                </span>
              </div>
            ))}
            {Object.keys(analytics.byStrategy).length === 0 && (
              <div className="px-3 py-2 text-xs text-text-muted font-mono">No closed trades yet</div>
            )}
          </div>
        </div>

        {/* By Direction */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title text-xs">By Direction</span>
          </div>
          <div className="divide-y divide-border/10">
            {Object.entries(analytics.byDirection).map(([dir, data]) => (
              <div key={dir} className="px-3 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {dir === 'bullish' ? <TrendingUp className="w-3 h-3 text-accent-green" /> :
                    dir === 'bearish' ? <TrendingDown className="w-3 h-3 text-accent-red" /> :
                    <Minus className="w-3 h-3 text-accent-amber" />}
                  <span className="text-xs font-mono text-text-primary capitalize">{dir}</span>
                  <span className="text-[10px] font-mono text-text-muted">{data.count}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-mono ${data.winRate >= 0.5 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {(data.winRate * 100).toFixed(0)}% WR
                  </span>
                  <span className={`text-xs font-mono ${data.avgPL >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    ${data.avgPL.toFixed(0)}
                  </span>
                </div>
              </div>
            ))}
            {Object.keys(analytics.byDirection).length === 0 && (
              <div className="px-3 py-2 text-xs text-text-muted font-mono">No closed trades yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Status Badge ───────────────────────────────────────────

function StatusBadge({ status, outcome }: { status: TradeStatus; outcome: TrackedTrade['outcome'] }) {
  if (status === 'pending') return (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 flex items-center gap-1">
      <Clock className="w-2.5 h-2.5" /> Pending
    </span>
  );
  if (status === 'entered') return (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan flex items-center gap-1">
      <Activity className="w-2.5 h-2.5" /> Open
    </span>
  );
  if (status === 'expired') {
    const color = outcome === 'win' ? 'bg-green-500/15 text-green-400' : outcome === 'loss' ? 'bg-red-500/15 text-red-400' : 'bg-bg-tertiary text-text-muted';
    return (
      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color} flex items-center gap-1`}>
        <Timer className="w-2.5 h-2.5" /> Expired
      </span>
    );
  }
  // exited
  const color = outcome === 'win' ? 'bg-green-500/15 text-green-400' : outcome === 'loss' ? 'bg-red-500/15 text-red-400' : 'bg-bg-tertiary text-text-muted';
  const Icon = outcome === 'win' ? CheckCircle2 : outcome === 'loss' ? XCircle : Minus;
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color} flex items-center gap-1`}>
      <Icon className="w-2.5 h-2.5" /> {outcome === 'win' ? 'Win' : outcome === 'loss' ? 'Loss' : 'BE'}
    </span>
  );
}

// ─── Trade Row ──────────────────────────────────────────────

function TradeRow({ trade, onRemove }: { trade: TrackedTrade; onRemove: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const dirColor = trade.direction === 'bullish' ? 'text-accent-green' : trade.direction === 'bearish' ? 'text-accent-red' : 'text-accent-amber';
  const isOpen = trade.status === 'pending' || trade.status === 'entered';

  // Calculate unrealized P/L for open trades using last price history entry
  const lastSnapshot = trade.priceHistory[trade.priceHistory.length - 1];
  const hasPricingData = trade.entryDebit !== null && trade.entryDebit !== 0 && trade.priceHistory.length > 0;
  let unrealizedPL: number | null = null;
  let unrealizedPLPct: number | null = null;

  if (isOpen && hasPricingData && lastSnapshot) {
    const currentValue = lastSnapshot.positionValue;
    unrealizedPL = currentValue - (trade.entryDebit ?? 0);
    unrealizedPLPct = trade.maxRisk && trade.maxRisk !== 0 ? (unrealizedPL / Math.abs(trade.maxRisk)) * 100 : null;
  }

  const displayPL = isOpen ? unrealizedPL : trade.realizedPL;
  const displayPLPct = isOpen ? unrealizedPLPct : trade.realizedPLPct;
  const plColor = (displayPL ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red';
  const awaitingPrices = isOpen && !hasPricingData;

  const holdDays = trade.enteredAt
    ? ((trade.exitedAt ?? Date.now()) - trade.enteredAt) / (1000 * 60 * 60 * 24)
    : 0;
  const daysToExpiry = Math.max(0, Math.ceil((new Date(trade.expirationDate + 'T16:00:00-05:00').getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  const sourceLabel = trade.source === 'algorithm' ? 'Algo' : trade.source === 'ai-briefing' ? 'Brief' : 'AI';
  const sourceBg = trade.source === 'algorithm' ? 'bg-accent-cyan/15 text-accent-cyan' : trade.source === 'ai-briefing' ? 'bg-accent-purple/15 text-accent-purple' : 'bg-purple-500/15 text-purple-400';

  return (
    <div className={`border-b border-border/10 ${isOpen ? '' : 'opacity-80'}`}>
      {/* Compact Row */}
      <div className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-bg-tertiary/30 transition-colors" onClick={() => setExpanded(!expanded)}>
        {/* Source badge */}
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0 ${sourceBg}`}>{sourceLabel}</span>

        {/* Symbol */}
        <span className="font-mono font-semibold text-text-primary text-sm w-14 shrink-0">{trade.symbol}</span>

        {/* Direction */}
        <span className={`text-[10px] font-mono ${dirColor} w-12 shrink-0`}>{trade.direction}</span>

        {/* Strategy */}
        <span className="text-xs font-mono text-text-secondary truncate flex-1 min-w-0 hidden sm:block">
          {trade.strategy}
        </span>

        {/* Status */}
        <StatusBadge status={trade.status} outcome={trade.outcome} />

        {/* P/L */}
        <div className="text-right w-20 shrink-0">
          {awaitingPrices ? (
            <span className="text-[10px] font-mono text-text-muted/60 animate-pulse">Pricing...</span>
          ) : displayPL !== null ? (
            <>
              <div className={`text-xs font-mono font-semibold ${plColor}`}>
                {displayPL >= 0 ? '+' : ''}{displayPLPct?.toFixed(1)}%
              </div>
              <div className={`text-[10px] font-mono ${plColor}`}>
                {displayPL >= 0 ? '+' : ''}${displayPL.toFixed(0)}
              </div>
            </>
          ) : (
            <span className="text-xs font-mono text-text-muted">—</span>
          )}
        </div>

        {/* DTE / Hold */}
        <div className="text-right w-16 shrink-0 hidden md:block">
          <div className="text-[10px] font-mono text-text-muted">
            {isOpen ? `${daysToExpiry}d DTE` : `${holdDays.toFixed(0)}d held`}
          </div>
        </div>

        {/* Expand toggle */}
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-text-muted shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-text-muted shrink-0" />}
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-3 bg-bg-tertiary/20">
          {/* Trade Details Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div>
              <span className="text-text-muted block">Strategy</span>
              <span className="text-text-primary">{trade.strategy}</span>
            </div>
            <div>
              <span className="text-text-muted block">Confidence</span>
              <span className={`${trade.confidence === 'high' ? 'text-accent-green' : trade.confidence === 'medium' ? 'text-accent-amber' : 'text-text-muted'}`}>
                {trade.confidence} (Score: {trade.score})
              </span>
            </div>
            <div>
              <span className="text-text-muted block">Entry Spot</span>
              <span className="text-text-primary">${trade.spotAtEntry.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-text-muted block">{trade.spotAtExit ? 'Exit Spot' : 'Current Spot'}</span>
              <span className="text-text-primary">
                {trade.spotAtExit ? `$${trade.spotAtExit.toFixed(2)}` : lastSnapshot ? `$${lastSnapshot.spotPrice.toFixed(2)}` : '—'}
              </span>
            </div>
          </div>

          {/* Legs */}
          <div>
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-1">Legs</span>
            <div className="grid gap-1">
              {trade.legs.map((leg, i) => (
                <div key={i} className="flex items-center gap-3 text-xs font-mono bg-bg-tertiary/50 rounded px-3 py-1.5">
                  <span className={`w-10 ${leg.side === 'long' ? 'text-accent-green' : 'text-accent-red'}`}>{leg.side}</span>
                  <span className="text-text-primary">{leg.quantity}x</span>
                  <span className="text-text-secondary">{leg.optionType.toUpperCase()}</span>
                  <span className="text-accent-cyan">${leg.strike}</span>
                  <span className="text-text-muted">{leg.expiration}</span>
                  <span className="text-text-muted ml-auto">
                    {leg.entryMid > 0 ? `Entry: $${leg.entryMid.toFixed(2)}` : 'Awaiting entry price'}
                  </span>
                  {leg.exitMid !== null && leg.exitMid > 0 && (
                    <span className={`${(leg.exitMid - leg.entryMid) * (leg.side === 'long' ? 1 : -1) >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                      Exit: ${leg.exitMid.toFixed(2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Entry/Exit Conditions */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
            <div>
              <span className="text-text-muted block">Entry Condition</span>
              <span className="text-text-secondary">{trade.entryCondition}</span>
            </div>
            <div>
              <span className="text-text-muted block">Risk Management</span>
              <span className="text-text-secondary">{trade.riskDescription}</span>
            </div>
          </div>

          {/* Targets */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div>
              <span className="text-text-muted block">Profit Target</span>
              <span className="text-accent-green">+{trade.profitTargetPct}%</span>
            </div>
            <div>
              <span className="text-text-muted block">Stop Loss</span>
              <span className="text-accent-red">-{trade.stopLossPct}%</span>
            </div>
            <div>
              <span className="text-text-muted block">Max Risk</span>
              <span className="text-text-primary">{trade.maxRisk !== null ? `$${Math.abs(trade.maxRisk).toFixed(0)}` : '—'}</span>
            </div>
            <div>
              <span className="text-text-muted block">Exit Reason</span>
              <span className="text-text-primary">{trade.exitReason ?? (isOpen ? 'Pending' : '—')}</span>
            </div>
          </div>

          {/* Market Snapshot */}
          <div>
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-1">Market Snapshot at Entry</span>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs font-mono">
              <div>
                <span className="text-text-muted block">IV Rank</span>
                <span className="text-text-primary">{trade.marketSnapshot.ivRank}</span>
              </div>
              <div>
                <span className="text-text-muted block">Bias</span>
                <span className={`${trade.marketSnapshot.overallBias === 'bullish' ? 'text-accent-green' : trade.marketSnapshot.overallBias === 'bearish' ? 'text-accent-red' : 'text-accent-amber'}`}>
                  {trade.marketSnapshot.overallBias} ({trade.marketSnapshot.biasScore > 0 ? '+' : ''}{trade.marketSnapshot.biasScore})
                </span>
              </div>
              <div>
                <span className="text-text-muted block">γ Regime</span>
                <span className="text-text-primary">{trade.marketSnapshot.gammaRegime}</span>
              </div>
              <div>
                <span className="text-text-muted block">Vol Regime</span>
                <span className="text-text-primary">{trade.marketSnapshot.volRegime}</span>
              </div>
              <div>
                <span className="text-text-muted block">GEX</span>
                <span className="text-text-primary">{abbr(trade.marketSnapshot.totalGEX)}</span>
              </div>
              <div>
                <span className="text-text-muted block">γ Flip</span>
                <span className="text-text-primary">{trade.marketSnapshot.gammaFlip ? `$${trade.marketSnapshot.gammaFlip.toFixed(0)}` : 'N/A'}</span>
              </div>
            </div>
          </div>

          {/* Reasoning */}
          {trade.reasoning.length > 0 && (
            <div>
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-1">Reasoning</span>
              <div className="space-y-0.5">
                {trade.reasoning.map((r, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-text-muted">
                    <span className="text-accent-cyan shrink-0">{'>'}</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tags */}
          {trade.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {trade.tags.map(tag => (
                <span key={tag} className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bg-tertiary text-text-muted">{tag}</span>
              ))}
            </div>
          )}

          {/* Timestamps */}
          <div className="flex items-center justify-between text-[10px] font-mono text-text-muted/60 pt-2 border-t border-border/10">
            <div className="flex items-center gap-4">
              <span>Tracked: {new Date(trade.trackedAt).toLocaleString()}</span>
              {trade.enteredAt && <span>Entered: {new Date(trade.enteredAt).toLocaleString()}</span>}
              {trade.exitedAt && <span>Exited: {new Date(trade.exitedAt).toLocaleString()}</span>}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(trade.id); }}
              className="flex items-center gap-1 text-red-400/60 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3 h-3" /> Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export default function TrackedTradesTab() {
  const [trades, setTrades] = useState<TrackedTrade[]>([]);
  const [analytics, setAnalytics] = useState<TradeAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [filterSource, setFilterSource] = useState<FilterSource>('all');
  const [sortField, setSortField] = useState<SortField>('date');
  const [showAnalytics, setShowAnalytics] = useState(true);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  // Load trades on mount and refresh periodically (to pick up TrackerMonitor updates)
  const refreshTrades = useCallback(() => {
    const current = loadTrackedTrades();
    setTrades(current);
    setAnalytics(computeAnalytics(current));
  }, []);

  useEffect(() => {
    setLoading(true);
    loadTrackedTradesWithSync().then(loaded => {
      setTrades(loaded);
      setAnalytics(computeAnalytics(loaded));
      setLoading(false);
    }).catch(() => {
      refreshTrades();
      setLoading(false);
    });
    // Refresh every 30s to pick up TrackerMonitor background updates
    const interval = setInterval(refreshTrades, 30000);
    return () => clearInterval(interval);
  }, [refreshTrades]);

  const handleRemove = useCallback((id: string) => {
    const updated = removeTrackedTrade(id);
    setTrades(updated);
    setAnalytics(computeAnalytics(updated));
  }, []);

  const handleRemoveAll = useCallback(() => {
    if (typeof window === 'undefined') return;
    localStorage.removeItem('optix_tracked_trades');
    setTrades([]);
    setAnalytics(computeAnalytics([]));
    setConfirmRemoveAll(false);
  }, []);

  // Apply filters and sorting
  const filteredTrades = trades.filter(t => {
    if (filterStatus !== 'all' && t.status !== filterStatus) return false;
    if (filterSource !== 'all' && t.source !== filterSource) return false;
    return true;
  });

  const sortedTrades = [...filteredTrades].sort((a, b) => {
    switch (sortField) {
      case 'date': return b.trackedAt - a.trackedAt;
      case 'symbol': return a.symbol.localeCompare(b.symbol);
      case 'pl': return (b.realizedPLPct ?? 0) - (a.realizedPLPct ?? 0);
      case 'status': {
        const order = { entered: 0, pending: 1, exited: 2, expired: 3 };
        return order[a.status] - order[b.status];
      }
      default: return 0;
    }
  });

  if (loading) {
    return (
      <div className="panel p-6 flex items-center justify-center">
        <div className="flex items-center gap-3 text-text-muted font-mono text-sm">
          <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
          Loading tracked trades...
        </div>
      </div>
    );
  }

  // Empty state
  if (trades.length === 0) {
    return (
      <div className="panel">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Eye className="w-12 h-12 text-text-muted/30 mb-4" />
          <h3 className="text-lg font-semibold text-text-secondary mb-2">AI Recommendation Tracker</h3>
          <p className="text-sm text-text-muted max-w-lg mb-1">
            Track AI-generated trade recommendations to evaluate their performance over time.
          </p>
          <p className="text-xs text-text-muted/60 mb-6 max-w-lg">
            Use the &quot;Track&quot; button on any trade idea in the Overview, Analysis, or Briefing tabs
            to start monitoring it. The tracker will follow the option prices and evaluate P/L
            against the recommended profit target and stop loss.
          </p>
          <div className="flex items-center gap-4 text-xs font-mono text-text-muted/60">
            <div className="flex items-center gap-1.5">
              <Crosshair className="w-3.5 h-3.5 text-accent-cyan" />
              <span>Overview tab → Trade Ideas</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-accent-purple" />
              <span>Briefing tab → AI / Algo Ideas</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-accent-cyan" />
            <span className="panel-title">AI Recommendation Tracker</span>
            <span className="text-xs text-text-muted font-mono">{trades.length} tracked</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAnalytics(!showAnalytics)}
              className={`px-2 py-1 rounded text-xs font-mono transition-colors ${showAnalytics ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-text-muted hover:text-text-secondary'}`}
            >
              <BarChart3 className="w-3.5 h-3.5 inline mr-1" />Analytics
            </button>
            {confirmRemoveAll ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-red-400 font-mono">Clear all?</span>
                <button onClick={handleRemoveAll} className="px-2 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors">Yes</button>
                <button onClick={() => setConfirmRemoveAll(false)} className="px-2 py-0.5 rounded text-[10px] font-mono text-text-muted hover:text-text-secondary transition-colors">No</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmRemoveAll(true)}
                className="text-xs font-mono text-text-muted/60 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Analytics */}
      {showAnalytics && analytics && <AnalyticsOverview analytics={analytics} />}

      {/* Filters & Sort */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Status filter */}
        <div className="flex items-center gap-1 bg-bg-secondary rounded-lg p-0.5 border border-border/30">
          {(['all', 'entered', 'pending', 'exited', 'expired'] as FilterStatus[]).map(s => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${filterStatus === s ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-text-muted hover:text-text-secondary'}`}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {/* Source filter */}
        <div className="flex items-center gap-1 bg-bg-secondary rounded-lg p-0.5 border border-border/30">
          {(['all', 'algorithm', 'ai-briefing', 'ai-analysis'] as FilterSource[]).map(s => (
            <button
              key={s}
              onClick={() => setFilterSource(s)}
              className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${filterSource === s ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-text-muted hover:text-text-secondary'}`}
            >
              {s === 'all' ? 'All Sources' : s === 'algorithm' ? 'Algo' : s === 'ai-briefing' ? 'Briefing' : 'AI Analysis'}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[10px] font-mono text-text-muted">Sort:</span>
          {(['date', 'symbol', 'pl', 'status'] as SortField[]).map(s => (
            <button
              key={s}
              onClick={() => setSortField(s)}
              className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${sortField === s ? 'bg-bg-tertiary text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
            >
              {s === 'date' ? 'Date' : s === 'symbol' ? 'Symbol' : s === 'pl' ? 'P/L' : 'Status'}
            </button>
          ))}
        </div>
      </div>

      {/* Trade List */}
      <div className="panel">
        {/* Column Headers */}
        <div className="px-4 py-2 flex items-center gap-3 text-[10px] font-mono text-text-muted uppercase tracking-wider border-b border-border/30 bg-bg-tertiary/30">
          <span className="w-10">Src</span>
          <span className="w-14">Symbol</span>
          <span className="w-12">Dir</span>
          <span className="flex-1 hidden sm:block">Strategy</span>
          <span className="w-16">Status</span>
          <span className="w-20 text-right">P/L</span>
          <span className="w-16 text-right hidden md:block">Time</span>
          <span className="w-4" />
        </div>

        {/* Rows */}
        <div className="divide-y divide-border/10">
          {sortedTrades.length > 0 ? (
            sortedTrades.map(trade => (
              <TradeRow key={trade.id} trade={trade} onRemove={handleRemove} />
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-text-muted font-mono">
              No trades match the current filters.
            </div>
          )}
        </div>

        {/* Summary footer */}
        <div className="px-4 py-2 border-t border-border/30 flex items-center justify-between text-[10px] font-mono text-text-muted/60">
          <span>Showing {sortedTrades.length} of {trades.length} tracked trades</span>
          <span>Data stored locally + synced to server</span>
        </div>
      </div>
    </div>
  );
}

function abbr(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
