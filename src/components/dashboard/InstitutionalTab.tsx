'use client';

import { useState, useCallback } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Building2, RefreshCw, Loader2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock,
  TrendingUp, TrendingDown, Activity, Eye,
} from 'lucide-react';

interface InstitutionalData {
  timestamp: number;
  swapSummary: {
    totalMaturitiesToday: number;
    totalNotionalToday: number;
    totalMaturitiesWeek: number;
    totalNotionalWeek: number;
    topMaturities: { symbol: string; count: number; notional: number }[];
    available: boolean;
    asOf: string;
  };
  regSHOList: string[];
  regSHOAsOf: string;
  shortInterestHighlights: {
    symbol: string;
    daysToCover: number;
    shortInterest: number;
    previousShortInterest: number;
    changePercent: number;
    avgDailyVolume: number;
  }[];
  shortInterestAsOf: string;
  shortVolumeHighlights?: {
    symbol: string;
    shortVolume: number;
    totalVolume: number;
    shortRatio: number;
  }[];
  shortVolumeAsOf?: string;
  finraAvailable: boolean;
  // Enhanced: options-derived metrics
  vannaCharmAnalysis?: {
    symbol: string;
    totalVanna: number;
    totalCharm: number;
    vannaRegime: 'bullish' | 'bearish' | 'neutral';
    charmRegime: 'bullish' | 'bearish' | 'neutral';
    totalGEX: number;
  }[];
  optionsDerivedPositioning?: {
    deepITMCallOI: { symbol: string; contracts: number }[];
    deepITMPutOI: { symbol: string; contracts: number }[];
    unusualVolume: { symbol: string; strikes: string[] }[];
  };
}

function formatNotional(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatVolume(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}

function formatGEX(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatDate(d: string): string {
  if (!d) return '';
  try {
    return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return d;
  }
}

function isStale(dateStr: string): boolean {
  if (!dateStr) return false;
  const today = new Date().toISOString().slice(0, 10);
  return dateStr < today;
}

function DataAge({ asOf, label }: { asOf: string; label?: string }) {
  if (!asOf) return null;
  const stale = isStale(asOf);
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono ${stale ? 'text-amber-400/80' : 'text-text-muted/60'}`}>
      <Clock className="w-3 h-3" />
      {label ? `${label}: ` : ''}{formatDate(asOf)}
      {stale && <span className="text-amber-400">(stale)</span>}
    </span>
  );
}

export default function InstitutionalTab() {
  const { loadSymbol, setActiveTab } = useDashboardStore();
  const [data, setData] = useState<InstitutionalData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/market/briefing');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  const navigateToStock = useCallback((symbol: string) => {
    loadSymbol(symbol);
    setActiveTab('overview');
  }, [loadSymbol, setActiveTab]);

  if (!data && !loading && !error) {
    return (
      <div className="panel">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Building2 className="w-12 h-12 text-text-muted/30 mb-4" />
          <h3 className="text-lg font-semibold text-text-secondary mb-2">Institutional Activity</h3>
          <p className="text-sm text-text-muted max-w-md mb-1">
            DTCC swap maturity data, FINRA Reg SHO threshold list, and short interest reports.
          </p>
          <p className="text-xs text-text-muted/60 mb-6 max-w-md">
            Data sourced from SEC-mandated DTCC swap disclosures and FINRA short interest filings.
            Retrieves the most recent available data — may be from a prior business day.
          </p>
          <button onClick={fetchData} className="px-6 py-2.5 rounded-lg bg-accent-purple/20 text-accent-purple border border-accent-purple/30 hover:bg-accent-purple/30 transition-all font-medium flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            Load Institutional Data
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent-purple" />
            <span className="panel-title">Institutional Activity</span>
          </div>
          <button onClick={fetchData} disabled={loading} className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-purple/30 hover:text-accent-purple transition-all flex items-center gap-1.5 disabled:opacity-50">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="panel border border-red-500/30 p-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {loading && !data && (
        <div className="panel p-8 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-accent-purple mr-3" />
          <span className="text-text-muted font-mono text-sm">Fetching DTCC + FINRA data...</span>
        </div>
      )}

      {data && (
        <>
          {/* Swap Maturities */}
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title flex items-center gap-2">
                <ArrowRightLeft className="w-3.5 h-3.5 text-accent-purple" />
                DTCC Equity Swap Maturities
              </span>
              <DataAge asOf={data.swapSummary.asOf} />
            </div>
            <div className="px-4 py-3">
              {data.swapSummary.available ? (
                <div className="space-y-4">
                  {data.swapSummary.asOf && isStale(data.swapSummary.asOf) && (
                    <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/10 rounded px-3 py-2 font-mono">
                      Showing data from {formatDate(data.swapSummary.asOf)} — most recent available report. Today&apos;s data may not yet be published.
                    </div>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <div className="text-xs text-text-muted font-mono mb-1">Maturities Today</div>
                      <div className="text-2xl font-bold text-text-primary font-mono">{data.swapSummary.totalMaturitiesToday.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-xs text-text-muted font-mono mb-1">Notional Today</div>
                      <div className="text-2xl font-bold text-accent-purple font-mono">{formatNotional(data.swapSummary.totalNotionalToday)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-text-muted font-mono mb-1">Maturities This Week</div>
                      <div className="text-2xl font-bold text-text-primary font-mono">{data.swapSummary.totalMaturitiesWeek.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="text-xs text-text-muted font-mono mb-1">Notional This Week</div>
                      <div className="text-2xl font-bold text-accent-purple font-mono">{formatNotional(data.swapSummary.totalNotionalWeek)}</div>
                    </div>
                  </div>
                  {/* Show total open swaps if no today/week maturities */}
                  {data.swapSummary.totalMaturitiesToday === 0 && data.swapSummary.totalMaturitiesWeek === 0 && data.swapSummary.topMaturities.length === 0 && (
                    <div className="text-xs text-text-muted/80 font-mono">
                      No swaps maturing today or this week. Data contains open swap positions from the most recent DTCC report.
                    </div>
                  )}
                  {data.swapSummary.topMaturities.length > 0 && (
                    <div>
                      <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Top Maturities by Notional</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                        {data.swapSummary.topMaturities.map(m => (
                          <div key={m.symbol} className="flex items-center justify-between text-xs font-mono py-1.5 px-3 rounded hover:bg-bg-hover/50 cursor-pointer" onClick={() => navigateToStock(m.symbol)}>
                            <span className="text-text-primary font-semibold">{m.symbol}</span>
                            <div className="flex items-center gap-4">
                              <span className="text-text-muted">{m.count} swaps</span>
                              <span className="text-accent-purple font-semibold">{formatNotional(m.notional)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-sm text-text-muted">DTCC swap data unavailable.</p>
                  <p className="text-xs text-text-muted/60 mt-1">Could not reach DTCC endpoints — data may not yet be published for today, or the endpoint may be temporarily unreachable.</p>
                </div>
              )}
            </div>
          </div>

          {/* Reg SHO */}
          <div className="panel">
            <div className="panel-header">
              <div className="flex items-center gap-2">
                <span className="panel-title flex items-center gap-2">
                  <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                  Reg SHO Threshold List
                </span>
                <DataAge asOf={data.regSHOAsOf} />
              </div>
              <span className="text-xs text-text-muted font-mono">{data.regSHOList.length} securities</span>
            </div>
            <div className="px-4 py-3">
              {data.regSHOList.length > 0 ? (
                <div>
                  {data.regSHOAsOf && isStale(data.regSHOAsOf) && (
                    <div className="text-xs text-amber-400/80 bg-amber-400/5 border border-amber-400/10 rounded px-3 py-2 font-mono mb-3">
                      Data from {formatDate(data.regSHOAsOf)} — most recent available list.
                    </div>
                  )}
                  <p className="text-xs text-text-muted mb-3">Securities with persistent failures-to-deliver (FTDs). Presence on this list indicates market-maker delivery obligations are not being met — potential short squeeze catalysts.</p>
                  <div className="flex flex-wrap gap-2">
                    {data.regSHOList.map(sym => (
                      <span key={sym} className="text-xs font-mono px-3 py-1 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 cursor-pointer hover:bg-red-500/20 transition-colors" onClick={() => navigateToStock(sym)}>
                        {sym}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-6">
                  <p className="text-sm text-text-muted">No Reg SHO data available.</p>
                  <p className="text-xs text-text-muted/60 mt-1">FINRA data may not be accessible, or the threshold list may be empty for the most recent business day.</p>
                </div>
              )}
            </div>
          </div>

          {/* Short Interest */}
          <div className="panel">
            <div className="panel-header">
              <div className="flex items-center gap-2">
                <span className="panel-title flex items-center gap-2">
                  <ShieldAlert className="w-3.5 h-3.5 text-orange-400" />
                  High Short Interest (OTC)
                </span>
                <DataAge asOf={data.shortInterestAsOf} />
              </div>
              <span className="text-xs text-text-muted font-mono">3–100 DTC</span>
            </div>
            <div className="px-4 py-3">
              {data.shortInterestHighlights.length > 0 ? (
                <div>
                  {data.shortInterestAsOf && (
                    <div className="text-xs text-text-muted/60 font-mono mb-2">
                      Settlement date: {formatDate(data.shortInterestAsOf)} — FINRA OTC biweekly short interest. Exchange-listed SI requires paid API access.
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/30">
                          <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Symbol</th>
                          <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">DTC</th>
                          <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Short Interest</th>
                          <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Chg %</th>
                          <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Avg Daily Vol</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.shortInterestHighlights.map((s, idx) => (
                          <tr key={s.symbol} className={`border-b border-border/10 hover:bg-bg-hover/50 cursor-pointer transition-colors ${idx % 2 === 0 ? 'bg-bg-secondary/30' : ''}`} onClick={() => navigateToStock(s.symbol)}>
                            <td className="px-3 py-2 font-mono font-semibold text-text-primary">{s.symbol}</td>
                            <td className={`px-3 py-2 font-mono text-right ${s.daysToCover > 20 ? 'text-orange-400 font-semibold' : s.daysToCover > 10 ? 'text-yellow-400' : 'text-text-secondary'}`}>{s.daysToCover.toFixed(1)}d</td>
                            <td className="px-3 py-2 font-mono text-right text-text-secondary">{formatVolume(s.shortInterest)}</td>
                            <td className={`px-3 py-2 font-mono text-right font-semibold ${s.changePercent > 0 ? 'text-red-400' : s.changePercent < 0 ? 'text-green-400' : 'text-text-muted'}`}>
                              {s.changePercent !== 0 ? `${s.changePercent > 0 ? '+' : ''}${s.changePercent.toFixed(1)}%` : '—'}
                            </td>
                            <td className="px-3 py-2 font-mono text-right text-text-muted">{formatVolume(s.avgDailyVolume)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[10px] text-text-muted/50 mt-2 px-3">
                    DTC = Days to Cover (SI / avg daily vol). Chg % = change vs prior biweekly period. Red = SI increasing (more bearish), Green = SI decreasing.
                  </p>
                </div>
              ) : (
                <div className="text-center py-6">
                  <p className="text-sm text-text-muted">No high short-interest data available.</p>
                  <p className="text-xs text-text-muted/60 mt-1">Free FINRA CDN only covers OTC securities. Exchange-listed (NYSE/NASDAQ) short interest requires OAuth API access. OTC data updates bi-monthly.</p>
                </div>
              )}
            </div>
          </div>

          {/* Daily Short Sale Volume */}
          {data.shortVolumeHighlights && data.shortVolumeHighlights.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <div className="flex items-center gap-2">
                  <span className="panel-title flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5 text-yellow-400" />
                    Daily Short Sale Volume
                  </span>
                  <DataAge asOf={data.shortVolumeAsOf || ''} />
                </div>
                <span className="text-xs text-text-muted font-mono">{'>'}40% short ratio</span>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-text-muted mb-3">
                  Securities with high short sale volume ratio today. A ratio above 50% means more than half of trading volume was short selling. Source: FINRA regShoDaily (no auth).
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/30">
                        <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Symbol</th>
                        <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Short Ratio</th>
                        <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Short Vol</th>
                        <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Total Vol</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.shortVolumeHighlights.slice(0, 20).map((s, idx) => (
                        <tr key={s.symbol} className={`border-b border-border/10 hover:bg-bg-hover/50 cursor-pointer transition-colors ${idx % 2 === 0 ? 'bg-bg-secondary/30' : ''}`} onClick={() => navigateToStock(s.symbol)}>
                          <td className="px-3 py-2 font-mono font-semibold text-text-primary">{s.symbol}</td>
                          <td className={`px-3 py-2 font-mono text-right font-semibold ${s.shortRatio > 0.6 ? 'text-red-400' : s.shortRatio > 0.5 ? 'text-orange-400' : 'text-yellow-400'}`}>
                            {(s.shortRatio * 100).toFixed(0)}%
                          </td>
                          <td className="px-3 py-2 font-mono text-right text-text-muted">{formatVolume(s.shortVolume)}</td>
                          <td className="px-3 py-2 font-mono text-right text-text-muted">{formatVolume(s.totalVolume)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Vanna / Charm Regime Analysis */}
          {data.vannaCharmAnalysis && data.vannaCharmAnalysis.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5 text-cyan-400" />
                  Vanna &amp; Charm Regime
                </span>
                <span className="text-xs text-text-muted/60 font-mono">options-derived</span>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-text-muted mb-3">
                  Second-order Greeks showing dealer hedging pressure from vol changes (vanna) and time decay (charm).
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/30">
                        <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Index</th>
                        <th className="px-3 py-2 text-center text-xs font-mono text-text-muted">Vanna</th>
                        <th className="px-3 py-2 text-center text-xs font-mono text-text-muted">Charm</th>
                        <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Net GEX</th>
                        <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Interpretation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.vannaCharmAnalysis.map((vc, idx) => {
                        const aligned = vc.vannaRegime === vc.charmRegime && vc.vannaRegime !== 'neutral';
                        const divergent = vc.vannaRegime !== vc.charmRegime && vc.vannaRegime !== 'neutral' && vc.charmRegime !== 'neutral';
                        let interpretation = '';
                        if (aligned && vc.vannaRegime === 'bullish') interpretation = 'Vol drop + time decay both push dealers to buy — supportive';
                        else if (aligned && vc.vannaRegime === 'bearish') interpretation = 'Vol drop + time decay both push dealers to sell — pressured';
                        else if (divergent) interpretation = `Conflict: vanna ${vc.vannaRegime}, charm ${vc.charmRegime} — cross-currents`;
                        else if (vc.vannaRegime !== 'neutral') interpretation = `Vanna-driven ${vc.vannaRegime} bias`;
                        else if (vc.charmRegime !== 'neutral') interpretation = `Charm-driven ${vc.charmRegime} bias on quiet days`;
                        else interpretation = 'Neutral — minimal second-order pressure';

                        return (
                          <tr key={vc.symbol} className={`border-b border-border/10 ${idx % 2 === 0 ? 'bg-bg-secondary/30' : ''}`}>
                            <td className="px-3 py-2 font-mono font-semibold text-text-primary cursor-pointer hover:text-accent-purple" onClick={() => navigateToStock(vc.symbol)}>{vc.symbol}</td>
                            <td className="px-3 py-2 text-center">
                              <span className={`inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded ${
                                vc.vannaRegime === 'bullish' ? 'bg-green-500/10 text-green-400' :
                                vc.vannaRegime === 'bearish' ? 'bg-red-500/10 text-red-400' :
                                'bg-bg-tertiary text-text-muted'
                              }`}>
                                {vc.vannaRegime === 'bullish' ? <TrendingUp className="w-3 h-3" /> : vc.vannaRegime === 'bearish' ? <TrendingDown className="w-3 h-3" /> : null}
                                {vc.vannaRegime}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-center">
                              <span className={`inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded ${
                                vc.charmRegime === 'bullish' ? 'bg-green-500/10 text-green-400' :
                                vc.charmRegime === 'bearish' ? 'bg-red-500/10 text-red-400' :
                                'bg-bg-tertiary text-text-muted'
                              }`}>
                                {vc.charmRegime === 'bullish' ? <TrendingUp className="w-3 h-3" /> : vc.charmRegime === 'bearish' ? <TrendingDown className="w-3 h-3" /> : null}
                                {vc.charmRegime}
                              </span>
                            </td>
                            <td className={`px-3 py-2 font-mono text-right text-xs ${vc.totalGEX >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {vc.totalGEX >= 0 ? '+' : ''}{formatGEX(vc.totalGEX)}
                            </td>
                            <td className={`px-3 py-2 text-xs ${divergent ? 'text-amber-400' : aligned ? (vc.vannaRegime === 'bullish' ? 'text-green-400' : 'text-red-400') : 'text-text-muted'}`}>
                              {interpretation}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Options-Derived Institutional Positioning */}
          {data.optionsDerivedPositioning && (
            (data.optionsDerivedPositioning.deepITMCallOI.length > 0 ||
             data.optionsDerivedPositioning.deepITMPutOI.length > 0 ||
             data.optionsDerivedPositioning.unusualVolume.length > 0) && (
            <div className="panel">
              <div className="panel-header">
                <span className="panel-title flex items-center gap-2">
                  <Eye className="w-3.5 h-3.5 text-blue-400" />
                  Options-Derived Positioning
                </span>
                <span className="text-xs text-text-muted/60 font-mono">institutional proxy</span>
              </div>
              <div className="px-4 py-3 space-y-4">
                <p className="text-xs text-text-muted">
                  Deep in-the-money options with high open interest suggest institutional synthetic stock positions. Unusual volume indicates potential new positioning.
                </p>

                {data.optionsDerivedPositioning.deepITMCallOI.length > 0 && (
                  <div>
                    <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider flex items-center gap-1.5">
                      <TrendingUp className="w-3 h-3 text-green-400" />
                      Synthetic Longs (Deep ITM Calls)
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                      {data.optionsDerivedPositioning.deepITMCallOI.map(item => (
                        <div key={item.symbol} className="flex items-center justify-between text-xs font-mono py-1.5 px-3 rounded hover:bg-bg-hover/50 cursor-pointer" onClick={() => navigateToStock(item.symbol)}>
                          <span className="text-text-primary font-semibold">{item.symbol}</span>
                          <span className="text-green-400">{item.contracts.toLocaleString()} contracts</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {data.optionsDerivedPositioning.deepITMPutOI.length > 0 && (
                  <div>
                    <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider flex items-center gap-1.5">
                      <TrendingDown className="w-3 h-3 text-red-400" />
                      Hedges / Synthetic Shorts (Deep ITM Puts)
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                      {data.optionsDerivedPositioning.deepITMPutOI.map(item => (
                        <div key={item.symbol} className="flex items-center justify-between text-xs font-mono py-1.5 px-3 rounded hover:bg-bg-hover/50 cursor-pointer" onClick={() => navigateToStock(item.symbol)}>
                          <span className="text-text-primary font-semibold">{item.symbol}</span>
                          <span className="text-red-400">{item.contracts.toLocaleString()} contracts</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {data.optionsDerivedPositioning.unusualVolume.length > 0 && (
                  <div>
                    <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider flex items-center gap-1.5">
                      <Activity className="w-3 h-3 text-amber-400" />
                      Unusual Options Activity
                    </div>
                    <div className="space-y-1">
                      {data.optionsDerivedPositioning.unusualVolume.map(item => (
                        <div key={item.symbol} className="flex items-center gap-3 text-xs font-mono py-1.5 px-3 rounded hover:bg-bg-hover/50 cursor-pointer" onClick={() => navigateToStock(item.symbol)}>
                          <span className="text-text-primary font-semibold w-12">{item.symbol}</span>
                          <div className="flex flex-wrap gap-1.5">
                            {item.strikes.map(strike => (
                              <span key={strike} className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px]">
                                {strike}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            )
          )}

          <div className="text-center text-[10px] text-text-muted/40 font-mono py-2">
            DTCC Swap Data (S3 archive) &bull; FINRA Reg SHO &amp; Short Volume (api.finra.org) &bull; OTC Short Interest (cdn.finra.org) &bull; Options-derived positioning via Tradier
          </div>
        </>
      )}
    </div>
  );
}
