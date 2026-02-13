'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Crosshair, RefreshCw, Trash2, TrendingUp, TrendingDown, Minus,
  CheckCircle2, XCircle, BarChart3, Clock, ArrowUpDown,
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

      {/* Signals table */}
      {sorted.length > 0 && (
        <div className="panel overflow-hidden">
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

      {sorted.length === 0 && (
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
    </div>
  );
}
