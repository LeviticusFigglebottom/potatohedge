'use client';

import { useState, useCallback } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Newspaper, RefreshCw, Loader2, TrendingUp, TrendingDown, Minus,
  AlertTriangle, ArrowRightLeft, ShieldAlert, Shield, Activity, Target,
} from 'lucide-react';
import type { BriefingData, IndexAnalysis } from '@/app/api/market/briefing/route';

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

function BiasChip({ bias, score }: { bias: string; score: number }) {
  const color = bias === 'bullish' ? 'bg-green-500/15 text-green-400 border-green-500/30'
    : bias === 'bearish' ? 'bg-red-500/15 text-red-400 border-red-500/30'
    : 'bg-bg-tertiary text-text-muted border-border/30';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold border ${color}`}>
      {score > 0 ? '+' : ''}{score} {bias}
    </span>
  );
}

function RegimeChip({ label, value, type }: { label: string; value: string; type: 'gamma' | 'vol' }) {
  let color = 'bg-bg-tertiary text-text-muted';
  if (type === 'gamma') {
    if (value === 'long') color = 'bg-green-500/15 text-green-400';
    else if (value === 'short') color = 'bg-red-500/15 text-red-400';
  } else {
    if (value === 'high') color = 'bg-orange-500/15 text-orange-400';
    else if (value === 'low') color = 'bg-blue-500/15 text-blue-400';
  }
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}>
      {label}: {value}
    </span>
  );
}

function IndexCard({ idx, onClick }: { idx: IndexAnalysis; onClick: () => void }) {
  return (
    <div className="panel cursor-pointer hover:border-accent-cyan/30 transition-colors" onClick={onClick}>
      <div className="px-4 py-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-text-primary text-sm">{idx.symbol}</span>
            <span className="font-mono text-text-secondary text-sm">${idx.price.toFixed(2)}</span>
            <ChangeChip pct={idx.changePct} />
          </div>
          <BiasChip bias={idx.bias} score={idx.biasScore} />
        </div>

        {/* Regime badges */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          <RegimeChip label="Gamma" value={idx.gammaRegime} type="gamma" />
          <RegimeChip label="IV" value={idx.volRegime} type="vol" />
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">
            IV Rank: {idx.ivRank}
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">
            PCR: {idx.volumePCR.toFixed(2)}
          </span>
        </div>

        {/* Key levels */}
        <div className="grid grid-cols-4 gap-2 mb-3">
          <div>
            <div className="text-[10px] text-text-muted font-mono">Gamma Flip</div>
            <div className="text-xs font-mono text-text-secondary">
              {idx.gammaFlip ? `$${idx.gammaFlip.toFixed(0)}` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-text-muted font-mono">Call Wall</div>
            <div className="text-xs font-mono text-green-500/70">
              {idx.callWall ? `$${idx.callWall.toFixed(0)}` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-text-muted font-mono">Put Wall</div>
            <div className="text-xs font-mono text-red-500/70">
              {idx.putWall ? `$${idx.putWall.toFixed(0)}` : '—'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-text-muted font-mono">Max Pain</div>
            <div className="text-xs font-mono text-text-secondary">${idx.maxPain.toFixed(0)}</div>
          </div>
        </div>

        {/* Top signals */}
        {idx.topSignals.length > 0 && (
          <div className="space-y-1 pt-2 border-t border-border/20">
            {idx.topSignals.slice(0, 3).map((sig, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px]">
                <span className={`shrink-0 mt-0.5 ${sig.direction === 'bullish' ? 'text-green-400' : sig.direction === 'bearish' ? 'text-red-400' : 'text-text-muted'}`}>
                  {sig.direction === 'bullish' ? '▲' : sig.direction === 'bearish' ? '▼' : '●'}
                </span>
                <span className="text-text-muted font-mono leading-relaxed">{sig.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(text); msg = j.error || msg; } catch { if (text.length < 200) msg = text || msg; }
        throw new Error(msg);
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
            Full GEX/IV/flow analysis of SPY, QQQ, IWM plus Mag7 snapshot,
            DTCC swap maturities, and FINRA short interest data — synthesized
            into an actionable morning overview.
          </p>
          <p className="text-xs text-text-muted/60 mb-6 max-w-md">
            Runs the same analysis pipeline as the individual stock view across all key indices.
          </p>
          <button
            onClick={fetchBriefing}
            className="px-6 py-2.5 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all font-medium flex items-center gap-2"
          >
            <Newspaper className="w-5 h-5" />
            Generate Briefing
          </button>
          <p className="text-xs text-text-muted/40 mt-3 font-mono">
            Takes ~15-30 seconds (analyzes 3 indices + 7 stocks)
          </p>
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
              <span className="text-xs text-text-muted font-mono">Updated {loadedAt}</span>
            )}
          </div>
          <button
            onClick={fetchBriefing}
            disabled={loading}
            className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-cyan/30 hover:text-accent-cyan transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {loading ? 'Analyzing...' : 'Refresh'}
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
            Analyzing SPY, QQQ, IWM + fetching Mag7, DTCC, FINRA data...
          </div>
        </div>
      )}

      {data && (
        <>
          {/* Alerts */}
          {data.alerts.length > 0 && (
            <div className="panel border border-accent-amber/30">
              <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-accent-amber" />
                <span className="text-xs font-mono font-semibold text-accent-amber uppercase tracking-wider">Alerts</span>
              </div>
              <div className="px-4 py-2 space-y-1">
                {data.alerts.map((a, i) => (
                  <p key={i} className="text-sm text-text-secondary flex items-start gap-2">
                    <span className="text-accent-amber shrink-0">!</span>
                    {a}
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Narrative Summary */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title flex items-center gap-2">
                <Target className="w-3.5 h-3.5 text-accent-cyan" />
                Market Analysis
              </span>
            </div>
            <div className="px-4 py-3 space-y-2">
              {data.narrative.map((line, i) => (
                <p key={i} className="text-sm text-text-secondary leading-relaxed font-mono">
                  {line}
                </p>
              ))}
            </div>
          </div>

          {/* Market Snapshot Bar — compact indices + VIX + DIA */}
          <div className="panel overflow-hidden">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-px bg-border/20">
              {data.indices.map(idx => (
                <div
                  key={idx.symbol}
                  className="bg-bg-secondary px-4 py-3 cursor-pointer hover:bg-bg-hover/50 transition-colors"
                  onClick={() => navigateToStock(idx.symbol)}
                >
                  <div className="text-xs font-mono text-text-muted mb-1">{idx.symbol}</div>
                  <div className="text-sm font-mono font-semibold text-text-primary">${idx.price.toFixed(2)}</div>
                  <ChangeChip pct={idx.changePct} />
                </div>
              ))}
              {data.dia && (
                <div
                  className="bg-bg-secondary px-4 py-3 cursor-pointer hover:bg-bg-hover/50 transition-colors"
                  onClick={() => navigateToStock('DIA')}
                >
                  <div className="text-xs font-mono text-text-muted mb-1">DIA</div>
                  <div className="text-sm font-mono font-semibold text-text-primary">${data.dia.price.toFixed(2)}</div>
                  <ChangeChip pct={data.dia.changePct} />
                </div>
              )}
              {data.vix && (
                <div className="bg-bg-secondary px-4 py-3">
                  <div className="text-xs font-mono text-text-muted mb-1">VIX</div>
                  <div className={`text-sm font-mono font-semibold ${data.vix.price > 25 ? 'text-red-400' : data.vix.price < 15 ? 'text-green-400' : 'text-text-primary'}`}>
                    {data.vix.price.toFixed(2)}
                  </div>
                  <ChangeChip pct={data.vix.changePct} />
                </div>
              )}
            </div>
          </div>

          {/* Index Analysis Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {data.indices.map(idx => (
              <IndexCard key={idx.symbol} idx={idx} onClick={() => navigateToStock(idx.symbol)} />
            ))}
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* DTCC + FINRA data (only show if available) */}
          {(data.swapSummary.available || data.finraAvailable) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Swap Maturity */}
              {data.swapSummary.available && (
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
                        <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Top Maturities</div>
                        <div className="space-y-1">
                          {data.swapSummary.topMaturities.slice(0, 8).map(m => (
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
                  </div>
                </div>
              )}

              {/* Reg SHO + Short Interest */}
              {data.finraAvailable && (
                <div className="panel">
                  <div className="panel-header">
                    <span className="panel-title flex items-center gap-2">
                      <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                      Reg SHO &amp; Short Interest
                    </span>
                  </div>
                  <div className="px-4 py-3 space-y-3">
                    {data.regSHOList.length > 0 && (
                      <div>
                        <div className="text-xs text-text-muted font-mono mb-1">
                          Reg SHO Threshold ({data.regSHOList.length})
                        </div>
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
                      </div>
                    )}
                    {data.shortInterestHighlights.length > 0 && (
                      <div className={data.regSHOList.length > 0 ? 'pt-2 border-t border-border/20' : ''}>
                        <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">
                          High Short Interest ({'>'}3d DTC)
                        </div>
                        <div className="space-y-1">
                          {data.shortInterestHighlights.slice(0, 8).map(s => (
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
                                  {(s.shortInterest / 1e6).toFixed(1)}M sh
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Source note */}
          <div className="text-center text-[10px] text-text-muted/40 font-mono py-2">
            Analysis: Tradier (options) &bull; Polygon (equity bars) &bull; GEX/IV/Flow computed locally
            {data.swapSummary.available && ' \u2022 DTCC (swap maturities)'}
            {data.finraAvailable && ' \u2022 FINRA (short interest, Reg SHO)'}
          </div>
        </>
      )}
    </div>
  );
}
