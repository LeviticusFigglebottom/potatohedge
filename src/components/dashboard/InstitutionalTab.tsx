'use client';

import { useState, useCallback, useEffect } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Building2, RefreshCw, Loader2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock,
  Zap, ChevronDown, ChevronUp, Waves, TrendingUp, TrendingDown,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────

interface MarketIndicator {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  date: string;
}

interface MarketFlow {
  netCallPremium: number;
  netPutPremium: number;
  netPremium: number;
  totalCallVolume: number;
  totalPutVolume: number;
  putCallRatio: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  tickersScanned: number;
  contractsAnalyzed: number;
}

interface FlowAlert {
  ticker: string;
  contractType: 'call' | 'put';
  strike: number;
  expiry: string;
  premium: number;
  volume: number;
  openInterest: number;
  volumeOIRatio: number;
  impliedVol: number;
  delta: number;
  tradeType: string;
  sentiment: string;
  underlyingPrice: number;
}

interface TickerFlow {
  ticker: string;
  netPremium: number;
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
  contractsActive: number;
}

interface InstitutionalAPIData {
  timestamp: number;
  sources: string[];
  vix: MarketIndicator | null;
  skew: MarketIndicator | null;
  marketFlow: MarketFlow | null;
  flowAlerts: FlowAlert[];
  perTickerFlow: TickerFlow[];
  flowDeveloper: boolean;
  siScreener: { symbol: string; daysToCover: number; shortInterest: number; avgDailyVolume: number }[];
  siAsOf: string;
  svScreener: { symbol: string; shortVolume: number; totalVolume: number; shortRatio: number }[];
  svAsOf: string;
  regSHOList: string[];
  regSHOAsOf: string;
  swapSummary: {
    totalMaturitiesToday: number;
    totalNotionalToday: number;
    totalMaturitiesWeek: number;
    totalNotionalWeek: number;
    topMaturities: { symbol: string; count: number; notional: number }[];
    available: boolean;
    asOf: string;
  };
}

// ─── Helpers ────────────────────────────────────────────────

function fmt$(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
}

function fmtVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}

function fmtDate(d: string): string {
  if (!d) return '';
  try { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch { return d; }
}

// ─── Collapsible Section ────────────────────────────────────

function Section({ title, icon, badge, defaultOpen = true, children }: {
  title: string; icon: React.ReactNode; badge?: React.ReactNode;
  defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="panel">
      <div className="panel-header cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-2">
          {icon}
          <span className="panel-title">{title}</span>
          {badge}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
      </div>
      {open && <div className="px-4 py-3">{children}</div>}
    </div>
  );
}

function MetricCard({ label, value, color = 'muted', sub }: {
  label: string; value: string; color?: 'green' | 'red' | 'yellow' | 'purple' | 'cyan' | 'muted'; sub?: string;
}) {
  const c = { green: 'text-green-400', red: 'text-red-400', yellow: 'text-yellow-400', purple: 'text-accent-purple', cyan: 'text-cyan-400', muted: 'text-text-primary' }[color];
  return (
    <div className="bg-bg-secondary/50 rounded-lg px-3 py-2 border border-border/20">
      <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-0.5">{label}</div>
      <div className={`text-lg font-bold font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-muted/60 font-mono">{sub}</div>}
    </div>
  );
}

// ─── Trade Type Badge ───────────────────────────────────────

function TradeTypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    sweep: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    block: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    large_premium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    unusual_volume: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  };
  const labels: Record<string, string> = {
    sweep: 'SWEEP',
    block: 'BLOCK',
    large_premium: 'LARGE',
    unusual_volume: 'UNUSUAL',
  };
  const s = styles[type] || 'bg-bg-tertiary text-text-muted border-border/30';
  return (
    <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${s}`}>
      {labels[type] || type.toUpperCase()}
    </span>
  );
}

// ─── Main Component ─────────────────────────────────────────

export default function InstitutionalTab() {
  const { loadSymbol, setActiveTab } = useDashboardStore();
  const [data, setData] = useState<InstitutionalAPIData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoLoaded, setAutoLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/market/institutional');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!autoLoaded) { setAutoLoaded(true); fetchData(); }
  }, [autoLoaded, fetchData]);

  const nav = useCallback((sym: string) => { loadSymbol(sym); setActiveTab('overview'); }, [loadSymbol, setActiveTab]);

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent-purple" />
            <span className="panel-title">Market-Wide Institutional View</span>
            {data && (
              <span className="text-[10px] text-text-muted/50 font-mono">
                {data.sources.join(' + ')}
              </span>
            )}
          </div>
          <button onClick={fetchData} disabled={loading}
            className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-purple/30 hover:text-accent-purple transition-all flex items-center gap-1.5 disabled:opacity-50">
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
          <span className="text-text-muted font-mono text-sm">Scanning options flow across 10 tickers...</span>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          MARKET REGIME — VIX, SKEW, Net Premium Flow
          ═══════════════════════════════════════════════════════ */}
      {data && (data.vix || data.skew || data.marketFlow) && (
        <Section
          title="Market Regime"
          icon={<Waves className="w-3.5 h-3.5 text-cyan-400" />}
          badge={data.marketFlow ? (
            <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
              data.marketFlow.sentiment === 'bullish' ? 'bg-green-500/10 text-green-400' :
              data.marketFlow.sentiment === 'bearish' ? 'bg-red-500/10 text-red-400' :
              'bg-bg-tertiary text-text-muted'
            }`}>
              {data.marketFlow.sentiment === 'bullish' ? 'Risk-On' :
               data.marketFlow.sentiment === 'bearish' ? 'Risk-Off' : 'Neutral'}
            </span>
          ) : null}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {data.vix && (
                <MetricCard
                  label="VIX"
                  value={data.vix.current.toFixed(2)}
                  color={data.vix.current > 25 ? 'red' : data.vix.current > 18 ? 'yellow' : 'green'}
                  sub={`${data.vix.change >= 0 ? '+' : ''}${data.vix.change.toFixed(2)} (${data.vix.changePercent >= 0 ? '+' : ''}${data.vix.changePercent.toFixed(1)}%)`}
                />
              )}
              {data.skew && (
                <MetricCard
                  label="SKEW"
                  value={data.skew.current.toFixed(1)}
                  color={data.skew.current > 150 ? 'red' : data.skew.current > 130 ? 'yellow' : 'muted'}
                  sub={data.skew.current > 145 ? 'Elevated tail risk' : data.skew.current > 130 ? 'Normal range' : 'Low tail risk'}
                />
              )}
              {data.marketFlow && (
                <>
                  <MetricCard
                    label="Net Premium Flow"
                    value={fmt$(data.marketFlow.netPremium)}
                    color={data.marketFlow.netPremium > 0 ? 'green' : data.marketFlow.netPremium < 0 ? 'red' : 'muted'}
                    sub={`Calls: ${fmt$(data.marketFlow.netCallPremium)} | Puts: ${fmt$(data.marketFlow.netPutPremium)}`}
                  />
                  <MetricCard
                    label="Put/Call Ratio"
                    value={data.marketFlow.putCallRatio.toFixed(2)}
                    color={data.marketFlow.putCallRatio > 1.2 ? 'red' : data.marketFlow.putCallRatio < 0.7 ? 'green' : 'muted'}
                    sub={`${fmtVol(data.marketFlow.totalCallVolume)}C / ${fmtVol(data.marketFlow.totalPutVolume)}P`}
                  />
                </>
              )}
            </div>

            {data.vix && (
              <p className="text-[10px] text-text-muted/50 px-1">
                {data.vix.current < 15 ? 'VIX below 15 — extreme complacency, options cheap, potential for vol expansion.' :
                 data.vix.current < 20 ? 'VIX in normal range — balanced risk sentiment.' :
                 data.vix.current < 25 ? 'VIX elevated — hedging demand increasing, caution warranted.' :
                 data.vix.current < 35 ? 'VIX high — significant fear, potential mean reversion opportunity.' :
                 'VIX extreme — panic/crisis conditions, historically marks bottoming zones.'}
                {data.skew && data.skew.current > 145 ? ' SKEW elevated — market pricing larger tail risk than VIX alone suggests.' : ''}
              </p>
            )}

            {data.marketFlow && data.marketFlow.tickersScanned > 0 && (
              <p className="text-[10px] text-text-muted/50 px-1">
                Scanned {data.marketFlow.contractsAnalyzed.toLocaleString()} contracts across {data.marketFlow.tickersScanned} tickers.
                {data.marketFlow.netPremium > 0 ? ' Net call premium = institutional buying pressure.' : ''}
                {data.marketFlow.netPremium < 0 ? ' Net put premium = institutional hedging/bearish bets.' : ''}
                {data.marketFlow.putCallRatio > 1.0 ? ` P/C ${data.marketFlow.putCallRatio.toFixed(2)} > 1.0 = elevated put demand.` : ''}
              </p>
            )}
          </div>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════
          FLOW HEATMAP — Per-Ticker Net Premium
          ═══════════════════════════════════════════════════════ */}
      {data && data.perTickerFlow && data.perTickerFlow.length > 0 && (
        <Section
          title="Options Flow by Ticker"
          icon={<Zap className="w-3.5 h-3.5 text-yellow-400" />}
          badge={
            <span className="text-[10px] text-text-muted font-mono">
              {data.perTickerFlow.length} tickers
            </span>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {data.perTickerFlow.map(tf => {
              const bullish = tf.netPremium > 0;
              const magnitude = Math.abs(tf.netPremium);
              const intensity = magnitude > 10e6 ? 'strong' : magnitude > 1e6 ? 'moderate' : 'mild';
              return (
                <div
                  key={tf.ticker}
                  className={`rounded-lg px-3 py-2 border cursor-pointer transition-colors hover:brightness-110 ${
                    bullish
                      ? intensity === 'strong' ? 'bg-green-500/15 border-green-500/30' :
                        intensity === 'moderate' ? 'bg-green-500/10 border-green-500/20' :
                        'bg-green-500/5 border-green-500/10'
                      : intensity === 'strong' ? 'bg-red-500/15 border-red-500/30' :
                        intensity === 'moderate' ? 'bg-red-500/10 border-red-500/20' :
                        'bg-red-500/5 border-red-500/10'
                  }`}
                  onClick={() => nav(tf.ticker)}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono font-bold text-sm text-text-primary">{tf.ticker}</span>
                    {bullish
                      ? <TrendingUp className="w-3 h-3 text-green-400" />
                      : <TrendingDown className="w-3 h-3 text-red-400" />}
                  </div>
                  <div className={`font-mono font-bold text-sm ${bullish ? 'text-green-400' : 'text-red-400'}`}>
                    {bullish ? '+' : ''}{fmt$(tf.netPremium)}
                  </div>
                  <div className="text-[9px] text-text-muted/60 font-mono mt-0.5">
                    C: {fmt$(tf.callPremium)} P: {fmt$(tf.putPremium)}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-text-muted/50 px-1 mt-2">
            Net premium = call premium - put premium. Green = net call buying (bullish), Red = net put buying (bearish).
          </p>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════
          TOP FLOW ALERTS — Biggest Premium Contracts
          ═══════════════════════════════════════════════════════ */}
      {data && data.flowAlerts.length > 0 && (
        <Section
          title="Top Flow Alerts"
          icon={<Zap className="w-3.5 h-3.5 text-amber-400" />}
          badge={
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted font-mono">{data.flowAlerts.length} alerts</span>
              {data.flowDeveloper && (
                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-accent-purple/10 text-accent-purple border border-accent-purple/20">
                  DEVELOPER
                </span>
              )}
            </div>
          }
        >
          <div className="space-y-1">
            <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-3 text-[10px] font-mono text-text-muted uppercase tracking-wider border-b border-border/30 pb-1 mb-1 px-2">
              <span>Ticker</span>
              <span className="text-right">Premium</span>
              <span className="text-right">Type</span>
              <span className="text-right">Contract</span>
              <span className="text-right">Vol/OI</span>
              <span className="text-right">IV</span>
            </div>
            {data.flowAlerts.slice(0, 20).map((f, i) => {
              const isBullish = f.sentiment === 'bullish';
              const isBearish = f.sentiment === 'bearish';
              return (
                <div key={i} className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-3 text-xs font-mono py-1.5 px-2 rounded hover:bg-bg-hover/50 cursor-pointer items-center"
                  onClick={() => nav(f.ticker)}>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${isBullish ? 'bg-green-400' : isBearish ? 'bg-red-400' : 'bg-text-muted'}`} />
                    <span className="font-semibold text-text-primary">{f.ticker}</span>
                  </div>
                  <span className={`text-right font-semibold ${f.premium >= 1e6 ? 'text-yellow-400' : f.premium >= 500000 ? 'text-text-primary' : 'text-text-secondary'}`}>
                    {fmt$(f.premium)}
                  </span>
                  <span className="text-right"><TradeTypeBadge type={f.tradeType} /></span>
                  <span className={`text-right ${f.contractType === 'call' ? 'text-green-400/80' : 'text-red-400/80'}`}>
                    {f.contractType.toUpperCase()} ${f.strike} {fmtDate(f.expiry)}
                  </span>
                  <span className={`text-right ${f.volumeOIRatio > 5 ? 'text-cyan-400 font-semibold' : f.volumeOIRatio > 2 ? 'text-text-secondary' : 'text-text-muted'}`}>
                    {f.volumeOIRatio.toFixed(1)}x
                  </span>
                  <span className="text-right text-text-muted/80">
                    {(f.impliedVol * 100).toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-text-muted/50 px-1 mt-2">
            {data.flowDeveloper
              ? 'Sweeps = aggressive fills across exchanges. Blocks = single fill 100+ contracts. Enhanced with trade-level data.'
              : 'Unusual = volume/OI > 2x. Large = $100K+ premium. Upgrade to Polygon Developer for sweep/block detection.'}
          </p>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════
          SHORT PRESSURE — SI + SV screeners
          ═══════════════════════════════════════════════════════ */}
      {data && (data.siScreener.length > 0 || data.svScreener.length > 0) && (
        <Section
          title="Short Pressure"
          icon={<ShieldAlert className="w-3.5 h-3.5 text-orange-400" />}
          badge={
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-muted font-mono"><Clock className="w-3 h-3 inline" /> SI: {fmtDate(data.siAsOf)}</span>
              <span className="text-[10px] text-text-muted font-mono">SV: {fmtDate(data.svAsOf)}</span>
            </div>
          }
        >
          <div className="space-y-4">
            {data.siScreener.length > 0 && (
              <div>
                <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Highest Days-to-Cover</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/30">
                        <th className="px-2 py-1.5 text-left text-[10px] font-mono text-text-muted">Symbol</th>
                        <th className="px-2 py-1.5 text-right text-[10px] font-mono text-text-muted">DTC</th>
                        <th className="px-2 py-1.5 text-right text-[10px] font-mono text-text-muted">SI</th>
                        <th className="px-2 py-1.5 text-right text-[10px] font-mono text-text-muted">ADV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.siScreener.slice(0, 10).map((s, i) => (
                        <tr key={s.symbol} className={`border-b border-border/10 hover:bg-bg-hover/50 cursor-pointer ${i % 2 === 0 ? 'bg-bg-secondary/20' : ''}`}
                          onClick={() => nav(s.symbol)}>
                          <td className="px-2 py-1.5 font-mono font-semibold text-text-primary text-xs">{s.symbol}</td>
                          <td className={`px-2 py-1.5 font-mono text-right text-xs ${s.daysToCover > 20 ? 'text-orange-400 font-semibold' : s.daysToCover > 10 ? 'text-yellow-400' : 'text-text-secondary'}`}>
                            {s.daysToCover.toFixed(1)}d
                          </td>
                          <td className="px-2 py-1.5 font-mono text-right text-xs text-text-secondary">{fmtVol(s.shortInterest)}</td>
                          <td className="px-2 py-1.5 font-mono text-right text-xs text-text-muted">{fmtVol(s.avgDailyVolume)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.svScreener.length > 0 && (
              <div>
                <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Highest Short Volume Ratio</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/30">
                        <th className="px-2 py-1.5 text-left text-[10px] font-mono text-text-muted">Symbol</th>
                        <th className="px-2 py-1.5 text-right text-[10px] font-mono text-text-muted">Ratio</th>
                        <th className="px-2 py-1.5 text-right text-[10px] font-mono text-text-muted">Short Vol</th>
                        <th className="px-2 py-1.5 text-right text-[10px] font-mono text-text-muted">Total Vol</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.svScreener.slice(0, 10).map((s, i) => (
                        <tr key={s.symbol} className={`border-b border-border/10 hover:bg-bg-hover/50 cursor-pointer ${i % 2 === 0 ? 'bg-bg-secondary/20' : ''}`}
                          onClick={() => nav(s.symbol)}>
                          <td className="px-2 py-1.5 font-mono font-semibold text-text-primary text-xs">{s.symbol}</td>
                          <td className={`px-2 py-1.5 font-mono text-right text-xs font-semibold ${s.shortRatio > 0.6 ? 'text-red-400' : s.shortRatio > 0.5 ? 'text-orange-400' : 'text-yellow-400'}`}>
                            {(s.shortRatio * 100).toFixed(0)}%
                          </td>
                          <td className="px-2 py-1.5 font-mono text-right text-xs text-text-muted">{fmtVol(s.shortVolume)}</td>
                          <td className="px-2 py-1.5 font-mono text-right text-xs text-text-muted">{fmtVol(s.totalVolume)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.regSHOList.length > 0 && (
              <div>
                <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">
                  Reg SHO Threshold ({data.regSHOList.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data.regSHOList.slice(0, 30).map(sym => (
                    <span key={sym} className="text-[11px] font-mono px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 cursor-pointer hover:bg-red-500/20 transition-colors"
                      onClick={() => nav(sym)}>
                      {sym}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-text-muted/50 px-1 mt-1">
                  Persistent FTDs — forced covering potential. Cross-reference with high SI for squeeze setups.
                </p>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════
          DTCC SWAP MATURITIES
          ═══════════════════════════════════════════════════════ */}
      {data && data.swapSummary.available && (
        <Section
          title="DTCC Equity Swap Maturities"
          icon={<ArrowRightLeft className="w-3.5 h-3.5 text-accent-purple" />}
          badge={
            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-text-muted/60">
              <Clock className="w-3 h-3" />{fmtDate(data.swapSummary.asOf)}
            </span>
          }
          defaultOpen={false}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="Maturities Today" value={data.swapSummary.totalMaturitiesToday.toLocaleString()} color="muted" />
              <MetricCard label="Notional Today" value={fmt$(data.swapSummary.totalNotionalToday)} color="purple" />
              <MetricCard label="Maturities Week" value={data.swapSummary.totalMaturitiesWeek.toLocaleString()} color="muted" />
              <MetricCard label="Notional Week" value={fmt$(data.swapSummary.totalNotionalWeek)} color="purple" />
            </div>
            {data.swapSummary.topMaturities.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {data.swapSummary.topMaturities.slice(0, 10).map(m => (
                  <div key={m.symbol} className="flex items-center justify-between text-xs font-mono py-1 px-2 rounded hover:bg-bg-hover/50 cursor-pointer"
                    onClick={() => nav(m.symbol)}>
                    <span className="text-text-primary font-semibold">{m.symbol}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-text-muted">{m.count} swaps</span>
                      <span className="text-accent-purple font-semibold">{fmt$(m.notional)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-text-muted/50 px-1">
              When swaps mature, dealers must unwind hedges — creating directional flow. Large maturity clusters = forced rebalancing.
            </p>
          </div>
        </Section>
      )}

      {/* Footer */}
      <div className="text-center text-[10px] text-text-muted/40 font-mono py-2 space-y-0.5">
        <div>{data?.sources.join(' + ') || 'Loading sources...'}</div>
        {!data?.vix && (
          <div>
            Add <code className="text-text-muted/60">FRED_API_KEY</code> (free) for VIX/SKEW indicators
          </div>
        )}
      </div>
    </div>
  );
}
