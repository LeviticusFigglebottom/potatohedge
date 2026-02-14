'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Crosshair, RefreshCw, Trash2, TrendingUp, TrendingDown, Minus,
  CheckCircle2, XCircle, BarChart3, Clock, ArrowUpDown, PieChart, Target,
} from 'lucide-react';
import {
  loadSignals, updateSignalPrices, removeSignal,
  getSignalStats, type TrackedSignal,
} from '@/lib/signalTracker';

type SortKey = 'trackedAt' | 'changePct' | 'biasScore' | 'symbol';
type SortDir = 'asc' | 'desc';

function formatAge(ms: number): string {
  const hours = ms / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

export default function SignalTrackerTab() {
  const { setActiveTab } = useDashboardStore();
  const [signals, setSignals] = useState<TrackedSignal[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('trackedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const refreshingRef = useRef(false);

  // Load signals on mount
  useEffect(() => {
    setSignals(loadSignals());
  }, []);

  const refreshPrices = useCallback(async () => {
    // Use ref to prevent overlapping refreshes
    if (refreshingRef.current) return;
    const allSignals = loadSignals();
    if (allSignals.length === 0) return;

    refreshingRef.current = true;
    setRefreshing(true);
    try {
      // Get ALL unique symbols — every signal gets updated until removed
      const symbols = [...new Set(allSignals.map(s => s.symbol))];
      const updates: Record<string, number> = {};
      const BATCH_SIZE = 40;

      // Batch fetch quotes — 40 symbols per request to stay within API limits
      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        try {
          const res = await fetch(`/api/market/quotes?symbols=${batch.join(',')}`, {
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
              for (const q of data) {
                if (q.symbol && q.last > 0) updates[q.symbol] = q.last;
              }
            }
          }
        } catch { /* continue with next batch */ }
      }

      if (Object.keys(updates).length > 0) {
        const updated = updateSignalPrices(updates);
        setSignals(updated);
      }
    } catch { /* ignore refresh errors */ }
    setRefreshing(false);
    refreshingRef.current = false;
  }, []);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    if (signals.length === 0) return;

    // Refresh immediately on mount/tab switch
    refreshPrices();

    const interval = setInterval(() => {
      refreshPrices();
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals.length > 0]);

  const handleRemove = useCallback((id: string) => {
    setSignals(removeSignal(id));
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sorted = [...signals].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'trackedAt': cmp = a.trackedAt - b.trackedAt; break;
      case 'changePct': cmp = Math.abs(a.changePct) - Math.abs(b.changePct); break;
      case 'biasScore': cmp = Math.abs(a.biasScore) - Math.abs(b.biasScore); break;
      case 'symbol': cmp = a.symbol.localeCompare(b.symbol); break;
    }
    return sortDir === 'desc' ? -cmp : cmp;
  });

  const stats = getSignalStats(signals);
  const now = Date.now();

  // Empty state
  if (signals.length === 0) {
    return (
      <div className="panel">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Crosshair className="w-12 h-12 text-text-muted/30 mb-4" />
          <h3 className="text-lg font-semibold text-text-secondary mb-2">Signal Tracker</h3>
          <p className="text-sm text-text-muted max-w-lg mb-1">
            Track the accuracy of directional bias signals. Add signals from the Screener
            or AI Briefing to see if the projected direction was correct and with what intensity.
          </p>
          <p className="text-xs text-text-muted/60 mb-6 max-w-lg">
            Each tracked signal records the stock price, bias score, and market regime at the time
            of tracking. Prices update continuously until you remove the signal.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => setActiveTab('screener')}
              className="px-5 py-2 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all text-sm font-medium"
            >
              Go to Screener
            </button>
            <button
              onClick={() => setActiveTab('briefing')}
              className="px-5 py-2 rounded-lg bg-accent-purple/20 text-accent-purple border border-accent-purple/30 hover:bg-accent-purple/30 transition-all text-sm font-medium"
            >
              Go to Briefing
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header + Stats */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-accent-cyan" />
            <span className="panel-title">Signal Tracker</span>
            <span className="text-xs text-text-muted font-mono">
              {signals.length} tracked
            </span>
          </div>
          <button
            onClick={refreshPrices}
            disabled={refreshing}
            className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-cyan/30 hover:text-accent-cyan transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh Prices
          </button>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-border/20 border-t border-border/20">
          <div className="bg-bg-secondary px-4 py-3">
            <div className="text-[10px] text-text-muted font-mono mb-0.5">Win Rate</div>
            <div className={`text-lg font-bold font-mono ${stats.winRate >= 60 ? 'text-green-400' : stats.winRate >= 50 ? 'text-yellow-400' : stats.winRate > 0 ? 'text-red-400' : 'text-text-muted'}`}>
              {stats.winRate > 0 ? `${stats.winRate.toFixed(0)}%` : '—'}
            </div>
          </div>
          <div className="bg-bg-secondary px-4 py-3">
            <div className="text-[10px] text-text-muted font-mono mb-0.5">Bullish Accuracy</div>
            <div className="text-lg font-bold font-mono text-green-400">
              {stats.bullishTotal > 0 ? `${stats.bullishCorrect}/${stats.bullishTotal}` : '—'}
            </div>
          </div>
          <div className="bg-bg-secondary px-4 py-3">
            <div className="text-[10px] text-text-muted font-mono mb-0.5">Bearish Accuracy</div>
            <div className="text-lg font-bold font-mono text-red-400">
              {stats.bearishTotal > 0 ? `${stats.bearishCorrect}/${stats.bearishTotal}` : '—'}
            </div>
          </div>
          <div className="bg-bg-secondary px-4 py-3">
            <div className="text-[10px] text-text-muted font-mono mb-0.5">Avg Gain</div>
            <div className="text-lg font-bold font-mono text-green-400">
              {stats.avgGain > 0 ? `+${stats.avgGain.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div className="bg-bg-secondary px-4 py-3">
            <div className="text-[10px] text-text-muted font-mono mb-0.5">Avg Loss</div>
            <div className="text-lg font-bold font-mono text-red-400">
              {stats.avgLoss > 0 ? `-${stats.avgLoss.toFixed(2)}%` : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Sort controls */}
      <div className="flex items-center gap-3 px-1">
        <div className="flex-1" />
        <span className="text-xs text-text-muted font-mono">{sorted.length} signals</span>
      </div>

      {/* Signals — mobile card layout */}
      {sorted.length > 0 && (
        <div className="md:hidden space-y-2">
          {sorted.map(sig => {
            const age = now - sig.trackedAt;
            const biasColor = sig.bias === 'bullish' ? 'text-green-400' : sig.bias === 'bearish' ? 'text-red-400' : 'text-text-muted';
            const changeColor = sig.changePct > 0 ? 'text-green-400' : sig.changePct < 0 ? 'text-red-400' : 'text-text-muted';
            const BiasIcon = sig.bias === 'bullish' ? TrendingUp : sig.bias === 'bearish' ? TrendingDown : Minus;
            const scoreBg = Math.abs(sig.biasScore) >= 50
              ? (sig.biasScore > 0 ? 'bg-green-500/20 border-green-500/30' : 'bg-red-500/20 border-red-500/30')
              : Math.abs(sig.biasScore) >= 30
              ? (sig.biasScore > 0 ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20')
              : 'bg-bg-tertiary border-border/30';
            return (
              <div key={sig.id} className="panel p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-text-primary">{sig.symbol}</span>
                    <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                      sig.source === 'screener' ? 'bg-accent-cyan/10 text-accent-cyan' :
                      sig.source === 'briefing' ? 'bg-accent-purple/10 text-accent-purple' :
                      'bg-bg-tertiary text-text-muted'
                    }`}>{sig.source}</span>
                    <span className={`flex items-center gap-0.5 ${biasColor}`}>
                      <BiasIcon className="w-3 h-3" />
                      <span className="text-[10px] font-mono capitalize">{sig.bias}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold border ${scoreBg}`}>
                      {sig.biasScore > 0 ? '+' : ''}{sig.biasScore}
                    </span>
                    <button onClick={() => handleRemove(sig.id)} className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-red-400 transition-colors">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2 text-xs font-mono">
                  <div>
                    <div className="text-[9px] text-text-muted">Entry</div>
                    <div className="text-text-secondary">${sig.entryPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-text-muted">Current</div>
                    <div className="text-text-secondary">${sig.currentPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-text-muted">Change</div>
                    <div className={`font-semibold ${changeColor}`}>{sig.changePct >= 0 ? '+' : ''}{sig.changePct.toFixed(2)}%</div>
                  </div>
                  <div>
                    <div className="text-[9px] text-text-muted">Result</div>
                    <div>{sig.directionCorrect === true ? <span className="text-green-400">Correct</span> : sig.directionCorrect === false ? <span className="text-red-400">Wrong</span> : <span className="text-text-muted">—</span>}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-1.5 text-[10px] font-mono text-text-muted">
                  <span>{sig.topSignal || '—'}</span>
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatAge(age)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Signals table — desktop */}
      {sorted.length > 0 && (
        <div className="panel overflow-hidden hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted cursor-pointer hover:text-text-secondary" onClick={() => handleSort('symbol')}>
                    <span className="flex items-center gap-1">Symbol {sortKey === 'symbol' && <ArrowUpDown className="w-3 h-3 text-accent-cyan" />}</span>
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Entry</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Current</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted cursor-pointer hover:text-text-secondary" onClick={() => handleSort('changePct')}>
                    <span className="flex items-center gap-1">Change {sortKey === 'changePct' && <ArrowUpDown className="w-3 h-3 text-accent-cyan" />}</span>
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Bias</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted cursor-pointer hover:text-text-secondary" onClick={() => handleSort('biasScore')}>
                    <span className="flex items-center gap-1">Score {sortKey === 'biasScore' && <ArrowUpDown className="w-3 h-3 text-accent-cyan" />}</span>
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Result</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Peak Move</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Signal / Regime</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted cursor-pointer hover:text-text-secondary" onClick={() => handleSort('trackedAt')}>
                    <span className="flex items-center gap-1">Age {sortKey === 'trackedAt' && <ArrowUpDown className="w-3 h-3 text-accent-cyan" />}</span>
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted w-12"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((sig, idx) => {
                  const age = now - sig.trackedAt;
                  const biasColor = sig.bias === 'bullish' ? 'text-green-400' : sig.bias === 'bearish' ? 'text-red-400' : 'text-text-muted';
                  const changeColor = sig.changePct > 0 ? 'text-green-400' : sig.changePct < 0 ? 'text-red-400' : 'text-text-muted';
                  const BiasIcon = sig.bias === 'bullish' ? TrendingUp : sig.bias === 'bearish' ? TrendingDown : Minus;
                  const scoreBg = Math.abs(sig.biasScore) >= 50
                    ? (sig.biasScore > 0 ? 'bg-green-500/20 border-green-500/30' : 'bg-red-500/20 border-red-500/30')
                    : Math.abs(sig.biasScore) >= 30
                    ? (sig.biasScore > 0 ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20')
                    : 'bg-bg-tertiary border-border/30';

                  const bestMove = sig.peakChangePct;
                  const worstMove = sig.troughChangePct;

                  return (
                    <tr
                      key={sig.id}
                      className={`border-b border-border/10 transition-colors ${idx % 2 === 0 ? 'bg-bg-secondary/30' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-text-primary">{sig.symbol}</span>
                          <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                            sig.source === 'screener' ? 'bg-accent-cyan/10 text-accent-cyan' :
                            sig.source === 'briefing' ? 'bg-accent-purple/10 text-accent-purple' :
                            'bg-bg-tertiary text-text-muted'
                          }`}>
                            {sig.source}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-text-secondary text-xs">
                        ${sig.entryPrice.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 font-mono text-text-secondary text-xs">
                        ${sig.currentPrice.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2 font-mono font-semibold text-xs ${changeColor}`}>
                        {sig.changePct >= 0 ? '+' : ''}{sig.changePct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2">
                        <span className={`flex items-center gap-1 ${biasColor}`}>
                          <BiasIcon className="w-3.5 h-3.5" />
                          <span className="text-xs font-mono capitalize">{sig.bias}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold border ${scoreBg}`}>
                          {sig.biasScore > 0 ? '+' : ''}{sig.biasScore}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {sig.directionCorrect === true && (
                          <span className="flex items-center gap-1 text-green-400">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span className="text-xs font-mono">Correct</span>
                          </span>
                        )}
                        {sig.directionCorrect === false && (
                          <span className="flex items-center gap-1 text-red-400">
                            <XCircle className="w-3.5 h-3.5" />
                            <span className="text-xs font-mono">Wrong</span>
                          </span>
                        )}
                        {sig.directionCorrect === null && (
                          <span className="text-xs font-mono text-text-muted">Neutral</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        <div className="flex flex-col gap-0.5">
                          {bestMove !== 0 && (
                            <span className="text-green-400">
                              Best: {bestMove >= 0 ? '+' : ''}{bestMove.toFixed(2)}%
                            </span>
                          )}
                          {worstMove !== 0 && (
                            <span className="text-red-400/70">
                              Worst: {worstMove >= 0 ? '+' : ''}{worstMove.toFixed(2)}%
                            </span>
                          )}
                          {bestMove === 0 && worstMove === 0 && (
                            <span className="text-text-muted/40">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-text-muted">
                        <div className="flex flex-col gap-0.5">
                          <span>{sig.topSignal || '—'}</span>
                          <span className="text-text-muted/60">
                            {sig.gammaRegime}γ / {sig.volRegime} IV{sig.ivRank}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1 text-xs font-mono text-text-muted">
                          <Clock className="w-3 h-3" />
                          {formatAge(age)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => handleRemove(sig.id)}
                          title="Remove signal"
                          className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-red-400 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sorted.length === 0 && signals.length > 0 && (
        <div className="panel p-8 text-center text-text-muted text-sm font-mono">
          No signals to display.
        </div>
      )}

      {/* High-conviction signals performance breakdown */}
      {signals.filter(s => Math.abs(s.biasScore) >= 40 && s.bias !== 'neutral').length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-accent-purple" />
              High-Conviction Signals (|Score| {'>='} 40)
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border/20 border-t border-border/20">
            {(() => {
              const hc = signals.filter(s => Math.abs(s.biasScore) >= 40 && s.bias !== 'neutral');
              const correct = hc.filter(s => s.directionCorrect === true);
              const wrong = hc.filter(s => s.directionCorrect === false);
              const avgMove = hc.length > 0 ? hc.reduce((s, sig) => s + Math.abs(sig.changePct), 0) / hc.length : 0;
              const wr = (correct.length + wrong.length) > 0
                ? (correct.length / (correct.length + wrong.length)) * 100 : 0;
              return (
                <>
                  <div className="bg-bg-secondary px-4 py-3">
                    <div className="text-[10px] text-text-muted font-mono mb-0.5">Tracked</div>
                    <div className="text-lg font-bold font-mono text-text-primary">{hc.length}</div>
                  </div>
                  <div className="bg-bg-secondary px-4 py-3">
                    <div className="text-[10px] text-text-muted font-mono mb-0.5">Win Rate</div>
                    <div className={`text-lg font-bold font-mono ${wr >= 60 ? 'text-green-400' : wr >= 50 ? 'text-yellow-400' : wr > 0 ? 'text-red-400' : 'text-text-muted'}`}>
                      {wr > 0 ? `${wr.toFixed(0)}%` : '—'}
                    </div>
                  </div>
                  <div className="bg-bg-secondary px-4 py-3">
                    <div className="text-[10px] text-text-muted font-mono mb-0.5">Correct / Wrong</div>
                    <div className="text-lg font-bold font-mono">
                      <span className="text-green-400">{correct.length}</span>
                      <span className="text-text-muted mx-1">/</span>
                      <span className="text-red-400">{wrong.length}</span>
                    </div>
                  </div>
                  <div className="bg-bg-secondary px-4 py-3">
                    <div className="text-[10px] text-text-muted font-mono mb-0.5">Avg |Move|</div>
                    <div className="text-lg font-bold font-mono text-text-primary">
                      {avgMove > 0 ? `${avgMove.toFixed(2)}%` : '—'}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Performance Dashboard */}
      {signals.filter(s => s.bias !== 'neutral').length >= 3 && (() => {
        const directional = signals.filter(s => s.bias !== 'neutral');

        // Score Distribution — buckets by absolute bias score
        const scoreBuckets = [
          { label: '0-19', min: 0, max: 19 },
          { label: '20-39', min: 20, max: 39 },
          { label: '40-59', min: 40, max: 59 },
          { label: '60-79', min: 60, max: 79 },
          { label: '80+', min: 80, max: 100 },
        ].map(b => ({
          ...b,
          count: directional.filter(s => Math.abs(s.biasScore) >= b.min && Math.abs(s.biasScore) <= b.max).length,
          correct: directional.filter(s => Math.abs(s.biasScore) >= b.min && Math.abs(s.biasScore) <= b.max && s.directionCorrect === true).length,
          total: directional.filter(s => Math.abs(s.biasScore) >= b.min && Math.abs(s.biasScore) <= b.max && s.directionCorrect !== null).length,
        }));
        const maxBucket = Math.max(...scoreBuckets.map(b => b.count), 1);

        // Performance by Source
        const bySource = (['screener', 'briefing'] as const).map(src => {
          const s = directional.filter(sig => sig.source === src);
          const correct = s.filter(sig => sig.directionCorrect === true);
          const decided = s.filter(sig => sig.directionCorrect !== null);
          const gains = s.filter(sig => sig.directionCorrect === true);
          const losses = s.filter(sig => sig.directionCorrect === false);
          return {
            source: src,
            total: s.length,
            winRate: decided.length > 0 ? (correct.length / decided.length) * 100 : 0,
            avgGain: gains.length > 0 ? gains.reduce((sum, sig) => sum + Math.abs(sig.changePct), 0) / gains.length : 0,
            avgLoss: losses.length > 0 ? losses.reduce((sum, sig) => sum + Math.abs(sig.changePct), 0) / losses.length : 0,
            avgMove: s.length > 0 ? s.reduce((sum, sig) => sum + sig.changePct, 0) / s.length : 0,
          };
        }).filter(s => s.total > 0);

        // Performance by Bias
        const byBias = (['bullish', 'bearish'] as const).map(bias => {
          const s = directional.filter(sig => sig.bias === bias);
          const correct = s.filter(sig => sig.directionCorrect === true);
          const decided = s.filter(sig => sig.directionCorrect !== null);
          const gains = s.filter(sig => sig.directionCorrect === true);
          const losses = s.filter(sig => sig.directionCorrect === false);
          return {
            bias,
            total: s.length,
            winRate: decided.length > 0 ? (correct.length / decided.length) * 100 : 0,
            avgGain: gains.length > 0 ? gains.reduce((sum, sig) => sum + Math.abs(sig.changePct), 0) / gains.length : 0,
            avgLoss: losses.length > 0 ? losses.reduce((sum, sig) => sum + Math.abs(sig.changePct), 0) / losses.length : 0,
          };
        });

        // Top Winners/Losers (by aligned move in bias direction)
        const withAligned = directional.map(s => ({
          ...s,
          alignedPct: s.bias === 'bullish' ? s.changePct : -s.changePct,
        }));
        const topWinners = [...withAligned].sort((a, b) => b.alignedPct - a.alignedPct).slice(0, 5);
        const topLosers = [...withAligned].sort((a, b) => a.alignedPct - b.alignedPct).slice(0, 5);

        return (
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title flex items-center gap-2">
                <PieChart className="w-4 h-4 text-accent-cyan" />
                Performance Dashboard
              </span>
              <span className="text-[10px] text-text-muted font-mono">{directional.length} directional signals</span>
            </div>

            {/* Score Distribution */}
            <div className="px-4 py-3 border-t border-border/20">
              <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-3">Score Distribution &amp; Win Rate by Conviction</div>
              <div className="space-y-1.5">
                {scoreBuckets.map(b => {
                  const wr = b.total > 0 ? (b.correct / b.total) * 100 : 0;
                  return (
                    <div key={b.label} className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-text-muted w-10 shrink-0 text-right">{b.label}</span>
                      <div className="flex-1 h-5 bg-bg-tertiary/50 rounded overflow-hidden relative">
                        <div
                          className="h-full rounded bg-accent-cyan/30 transition-all"
                          style={{ width: `${(b.count / maxBucket) * 100}%` }}
                        />
                        <span className="absolute inset-0 flex items-center px-2 text-[10px] font-mono text-text-secondary">
                          {b.count > 0 && `${b.count} signals`}
                        </span>
                      </div>
                      <span className={`text-[10px] font-mono w-12 text-right ${wr >= 60 ? 'text-green-400' : wr >= 50 ? 'text-yellow-400' : wr > 0 ? 'text-red-400' : 'text-text-muted/40'}`}>
                        {b.total > 0 ? `${wr.toFixed(0)}% W` : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Performance by Source */}
            {bySource.length > 0 && (
              <div className="px-4 py-3 border-t border-border/20">
                <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-3">Performance by Source</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {bySource.map(s => (
                    <div key={s.source} className="bg-bg-secondary/50 rounded-lg px-3 py-2 border border-border/20">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                          s.source === 'screener' ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-accent-purple/10 text-accent-purple'
                        }`}>
                          {s.source}
                        </span>
                        <span className="text-[10px] font-mono text-text-muted">{s.total} signals</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <div className="text-[9px] font-mono text-text-muted">Win Rate</div>
                          <div className={`text-sm font-mono font-bold ${s.winRate >= 60 ? 'text-green-400' : s.winRate >= 50 ? 'text-yellow-400' : s.winRate > 0 ? 'text-red-400' : 'text-text-muted'}`}>
                            {s.winRate > 0 ? `${s.winRate.toFixed(0)}%` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] font-mono text-text-muted">Avg Gain</div>
                          <div className="text-sm font-mono font-semibold text-green-400">
                            {s.avgGain > 0 ? `+${s.avgGain.toFixed(2)}%` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-[9px] font-mono text-text-muted">Avg Loss</div>
                          <div className="text-sm font-mono font-semibold text-red-400">
                            {s.avgLoss > 0 ? `-${s.avgLoss.toFixed(2)}%` : '—'}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Performance by Direction */}
            <div className="px-4 py-3 border-t border-border/20">
              <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-3">Performance by Direction</div>
              <div className="grid grid-cols-2 gap-3">
                {byBias.map(b => (
                  <div key={b.bias} className={`rounded-lg px-3 py-2 border ${
                    b.bias === 'bullish' ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'
                  }`}>
                    <div className="flex items-center gap-1.5 mb-2">
                      {b.bias === 'bullish' ? <TrendingUp className="w-3.5 h-3.5 text-green-400" /> : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
                      <span className={`text-xs font-mono font-semibold capitalize ${b.bias === 'bullish' ? 'text-green-400' : 'text-red-400'}`}>{b.bias}</span>
                      <span className="text-[10px] font-mono text-text-muted ml-auto">{b.total}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <div className="text-[9px] font-mono text-text-muted">Win Rate</div>
                        <div className={`text-sm font-mono font-bold ${b.winRate >= 60 ? 'text-green-400' : b.winRate >= 50 ? 'text-yellow-400' : b.winRate > 0 ? 'text-red-400' : 'text-text-muted'}`}>
                          {b.winRate > 0 ? `${b.winRate.toFixed(0)}%` : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] font-mono text-text-muted">Avg Gain</div>
                        <div className="text-sm font-mono font-semibold text-green-400">{b.avgGain > 0 ? `+${b.avgGain.toFixed(2)}%` : '—'}</div>
                      </div>
                      <div>
                        <div className="text-[9px] font-mono text-text-muted">Avg Loss</div>
                        <div className="text-sm font-mono font-semibold text-red-400">{b.avgLoss > 0 ? `-${b.avgLoss.toFixed(2)}%` : '—'}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Top Winners / Top Losers */}
            <div className="px-4 py-3 border-t border-border/20">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Target className="w-3 h-3 text-green-400" />
                    Top Winners (bias-aligned)
                  </div>
                  <div className="space-y-1">
                    {topWinners.filter(s => s.alignedPct > 0).map((s, i) => (
                      <div key={s.id} className="flex items-center gap-2 text-xs font-mono py-1 px-2 rounded bg-green-500/5">
                        <span className="text-text-muted w-3">{i + 1}.</span>
                        <span className="font-semibold text-text-primary">{s.symbol}</span>
                        <span className={`text-[10px] px-1 py-0.5 rounded ${s.source === 'screener' ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-accent-purple/10 text-accent-purple'}`}>{s.source}</span>
                        <span className="ml-auto text-green-400 font-semibold">+{s.alignedPct.toFixed(2)}%</span>
                      </div>
                    ))}
                    {topWinners.filter(s => s.alignedPct > 0).length === 0 && (
                      <span className="text-[10px] text-text-muted/40 font-mono">No winners yet</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Target className="w-3 h-3 text-red-400" />
                    Top Losers (bias-misaligned)
                  </div>
                  <div className="space-y-1">
                    {topLosers.filter(s => s.alignedPct < 0).map((s, i) => (
                      <div key={s.id} className="flex items-center gap-2 text-xs font-mono py-1 px-2 rounded bg-red-500/5">
                        <span className="text-text-muted w-3">{i + 1}.</span>
                        <span className="font-semibold text-text-primary">{s.symbol}</span>
                        <span className={`text-[10px] px-1 py-0.5 rounded ${s.source === 'screener' ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-accent-purple/10 text-accent-purple'}`}>{s.source}</span>
                        <span className="ml-auto text-red-400 font-semibold">{s.alignedPct.toFixed(2)}%</span>
                      </div>
                    ))}
                    {topLosers.filter(s => s.alignedPct < 0).length === 0 && (
                      <span className="text-[10px] text-text-muted/40 font-mono">No losers yet</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
