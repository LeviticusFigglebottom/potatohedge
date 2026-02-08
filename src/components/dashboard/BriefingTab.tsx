'use client';

import { useState, useCallback } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Newspaper, RefreshCw, Loader2, TrendingUp, TrendingDown, Minus,
  AlertTriangle, ArrowRightLeft, ShieldAlert, BarChart3,
} from 'lucide-react';
import type { BriefingData } from '@/app/api/market/briefing/route';

function formatNotional(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function ChangeChip({ pct }: { pct: number }) {
  const color = pct > 0.3 ? 'text-green-400' : pct < -0.3 ? 'text-red-400' : 'text-text-muted';
  const Icon = pct > 0.3 ? TrendingUp : pct < -0.3 ? TrendingDown : Minus;
  return (
    <span className={`flex items-center gap-1 font-mono text-xs ${color}`}>
      <Icon className="w-3 h-3" />
      {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
    </span>
  );
}

export default function BriefingTab() {
  const { loadSymbol, setActiveTab } = useDashboardStore();
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/market/briefing');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setLoadedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load briefing');
    } finally {
      setLoading(false);
    }
  }, []);

  const navigateToStock = useCallback((symbol: string) => {
    loadSymbol(symbol);
    setActiveTab('overview');
  }, [loadSymbol, setActiveTab]);

  // Empty state
  if (!data && !loading && !error) {
    return (
      <div className="panel">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Newspaper className="w-12 h-12 text-text-muted/30 mb-4" />
          <h3 className="text-lg font-semibold text-text-secondary mb-2">Daily Market Briefing</h3>
          <p className="text-sm text-text-muted max-w-md mb-1">
            Aggregates DTCC swap maturity data, FINRA short interest, Reg SHO threshold flags,
            and key index/Mag7 snapshots into a single morning overview.
          </p>
          <p className="text-xs text-text-muted/60 mb-6 max-w-md">
            Data sourced from SEC-mandated DTCC swap disclosures and FINRA short interest reports.
          </p>
          <button
            onClick={fetchBriefing}
            className="px-6 py-2.5 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all font-medium flex items-center gap-2"
          >
            <Newspaper className="w-5 h-5" />
            Load Briefing
          </button>
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
            <Newspaper className="w-4 h-4 text-accent-cyan" />
            <span className="panel-title">Daily Market Briefing</span>
            {loadedAt && (
              <span className="text-xs text-text-muted font-mono">
                Updated {loadedAt}
              </span>
            )}
          </div>
          <button
            onClick={fetchBriefing}
            disabled={loading}
            className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-cyan/30 hover:text-accent-cyan transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="panel border border-red-500/30 p-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="panel p-6 flex items-center justify-center">
          <div className="flex items-center gap-3 text-text-muted font-mono text-sm">
            <Loader2 className="w-5 h-5 animate-spin text-accent-cyan" />
            Loading market briefing data...
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Market Snapshot */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title flex items-center gap-2">
                <BarChart3 className="w-3.5 h-3.5 text-accent-cyan" />
                Market Indices
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-px bg-border/20">
              {data.marketSnapshot.map(s => (
                <div
                  key={s.symbol}
                  className="bg-bg-secondary px-4 py-3 cursor-pointer hover:bg-bg-hover/50 transition-colors"
                  onClick={() => s.symbol !== 'VIX' && navigateToStock(s.symbol)}
                >
                  <div className="text-xs font-mono text-text-muted mb-1">{s.symbol}</div>
                  <div className="text-sm font-mono font-semibold text-text-primary">${s.price.toFixed(2)}</div>
                  <ChangeChip pct={s.changePct} />
                </div>
              ))}
            </div>
          </div>

          {/* Mag7 Breakdown */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title">Magnificent 7</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/30">
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Symbol</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Price</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Chg%</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Swaps Today</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Notional</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">DTC</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.mag7.map((s, idx) => (
                    <tr
                      key={s.symbol}
                      className={`border-b border-border/10 hover:bg-bg-hover/50 cursor-pointer transition-colors ${idx % 2 === 0 ? 'bg-bg-secondary/30' : ''}`}
                      onClick={() => navigateToStock(s.symbol)}
                    >
                      <td className="px-3 py-2 font-mono font-semibold text-text-primary">{s.symbol}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">
                        {s.price > 0 ? `$${s.price.toFixed(2)}` : '—'}
                      </td>
                      <td className="px-3 py-2"><ChangeChip pct={s.changePct} /></td>
                      <td className={`px-3 py-2 font-mono text-xs ${s.swapMaturitiesToday > 100 ? 'text-orange-400' : 'text-text-muted'}`}>
                        {s.swapMaturitiesToday > 0 ? s.swapMaturitiesToday : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted">
                        {s.swapNotionalToday > 0 ? formatNotional(s.swapNotionalToday) : '—'}
                      </td>
                      <td className={`px-3 py-2 font-mono text-xs ${s.daysToCover > 5 ? 'text-orange-400' : s.daysToCover > 2 ? 'text-yellow-400' : 'text-text-muted'}`}>
                        {s.daysToCover > 0 ? `${s.daysToCover.toFixed(1)}d` : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {s.regSHO && <span className="text-xs font-mono text-red-400 font-semibold">RegSHO</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Swap Maturity Summary + Reg SHO side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Swap Maturity */}
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title flex items-center gap-2">
                  <ArrowRightLeft className="w-3.5 h-3.5 text-accent-purple" />
                  DTCC Swap Maturities
                </span>
              </div>
              <div className="px-4 py-3 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs text-text-muted font-mono mb-1">Today</div>
                    <div className="text-xl font-bold text-text-primary font-mono">
                      {data.swapSummary.totalMaturitiesToday.toLocaleString()}
                    </div>
                    <div className="text-xs text-text-muted font-mono">
                      {formatNotional(data.swapSummary.totalNotionalToday)} notional
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-text-muted font-mono mb-1">This Week</div>
                    <div className="text-xl font-bold text-text-primary font-mono">
                      {data.swapSummary.totalMaturitiesWeek.toLocaleString()}
                    </div>
                    <div className="text-xs text-text-muted font-mono">
                      {formatNotional(data.swapSummary.totalNotionalWeek)} notional
                    </div>
                  </div>
                </div>

                {data.swapSummary.topMaturities.length > 0 && (
                  <div>
                    <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Top Maturities Today</div>
                    <div className="space-y-1">
                      {data.swapSummary.topMaturities.slice(0, 10).map(m => (
                        <div
                          key={m.symbol}
                          className="flex items-center justify-between text-xs font-mono py-1 px-2 rounded hover:bg-bg-hover/50 cursor-pointer"
                          onClick={() => navigateToStock(m.symbol)}
                        >
                          <span className="text-text-primary font-semibold">{m.symbol}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-text-muted">{m.count} swaps</span>
                            <span className="text-accent-purple">{formatNotional(m.notional)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {data.swapSummary.totalMaturitiesToday === 0 && (
                  <p className="text-xs text-text-muted/60 font-mono text-center py-4">
                    No swap maturity data available — DTCC data may not have updated yet today.
                  </p>
                )}
              </div>
            </div>

            {/* Reg SHO + Short Interest */}
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title flex items-center gap-2">
                  <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                  Reg SHO Threshold &amp; Short Interest
                </span>
              </div>
              <div className="px-4 py-3 space-y-3">
                {/* Reg SHO */}
                <div>
                  <div className="text-xs text-text-muted font-mono mb-1">
                    Reg SHO Threshold List ({data.regSHOList.length} securities)
                  </div>
                  {data.regSHOList.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {data.regSHOList.slice(0, 30).map(sym => (
                        <span
                          key={sym}
                          className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20 cursor-pointer hover:bg-red-500/20 transition-colors"
                          onClick={() => navigateToStock(sym)}
                        >
                          {sym}
                        </span>
                      ))}
                      {data.regSHOList.length > 30 && (
                        <span className="text-[10px] font-mono px-2 py-0.5 text-text-muted">
                          +{data.regSHOList.length - 30} more
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted/60 font-mono">
                      No securities on threshold list — or FINRA data not yet available.
                    </p>
                  )}
                </div>

                {/* High Short Interest */}
                <div className="pt-2 border-t border-border/20">
                  <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">
                    High Short Interest ({'>'}3 days to cover)
                  </div>
                  {data.shortInterestHighlights.length > 0 ? (
                    <div className="space-y-1">
                      {data.shortInterestHighlights.slice(0, 10).map(s => (
                        <div
                          key={s.symbol}
                          className="flex items-center justify-between text-xs font-mono py-1 px-2 rounded hover:bg-bg-hover/50 cursor-pointer"
                          onClick={() => navigateToStock(s.symbol)}
                        >
                          <span className="text-text-primary font-semibold">{s.symbol}</span>
                          <div className="flex items-center gap-3">
                            <span className={s.daysToCover > 5 ? 'text-orange-400' : 'text-yellow-400'}>
                              {s.daysToCover.toFixed(1)}d DTC
                            </span>
                            <span className="text-text-muted">
                              {(s.shortInterest / 1e6).toFixed(1)}M shares
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted/60 font-mono">
                      No high-SI securities found — or FINRA data not yet available.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Data sourcing note */}
          <div className="text-center text-[10px] text-text-muted/40 font-mono py-2">
            Sources: DTCC Public Price Dissemination (pddata.dtcc.com) &bull; FINRA Short Interest &amp; Reg SHO Threshold (api.finra.org) &bull; Tradier (quotes)
          </div>
        </>
      )}
    </div>
  );
}
