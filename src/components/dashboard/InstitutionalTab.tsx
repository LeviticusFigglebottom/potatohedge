'use client';

import { useState, useCallback, useEffect } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Building2, RefreshCw, Loader2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock,
  Zap, ChevronDown, ChevronUp, Waves, TrendingUp, TrendingDown, Info,
} from 'lucide-react';
import { saveFlowSnapshot, saveTickerFlowSnapshot, loadFlowHistory, type DailyFlowRecord } from '@/lib/flowHistory';
import FlowHistoryPanel from './FlowHistoryChart';

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

// ─── Info Callout ───────────────────────────────────────────

function InfoBox({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-[10px] text-text-muted/50 hover:text-text-muted transition-colors font-mono">
        <Info className="w-3 h-3" />
        {open ? 'Hide explanation' : 'What does this mean?'}
      </button>
      {open && (
        <div className="mt-1.5 text-[10px] text-text-muted/60 leading-relaxed bg-bg-secondary/30 rounded-lg px-3 py-2 border border-border/10 space-y-1">
          {children}
        </div>
      )}
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
      const json = await res.json();
      setData(json);

      // Save daily flow snapshot for historical tracking
      if (json.marketFlow && json.marketFlow.tickersScanned > 0) {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const alerts: FlowAlert[] = json.flowAlerts || [];
        const record: DailyFlowRecord = {
          date: today,
          timestamp: Date.now(),
          netPremium: json.marketFlow.netPremium,
          netCallPremium: json.marketFlow.netCallPremium,
          netPutPremium: json.marketFlow.netPutPremium,
          totalCallVolume: json.marketFlow.totalCallVolume,
          totalPutVolume: json.marketFlow.totalPutVolume,
          putCallRatio: json.marketFlow.putCallRatio,
          sentiment: json.marketFlow.sentiment,
          contractsAnalyzed: json.marketFlow.contractsAnalyzed,
          tickersScanned: json.marketFlow.tickersScanned,
          perTicker: (json.perTickerFlow || []).slice(0, 10).map((t: TickerFlow) => ({
            ticker: t.ticker, netPremium: t.netPremium,
            callPremium: t.callPremium, putPremium: t.putPremium,
          })),
          sweepCount: alerts.filter((a: FlowAlert) => a.tradeType === 'sweep').length,
          blockCount: alerts.filter((a: FlowAlert) => a.tradeType === 'block').length,
          topAlertPremium: alerts.length > 0 ? alerts[0].premium : 0,
          vixPrice: json.vix?.current,
          skewValue: json.skew?.current,
        };
        saveFlowSnapshot(record);

        // Save per-ticker flow
        for (const tf of (json.perTickerFlow || []) as TickerFlow[]) {
          saveTickerFlowSnapshot(tf.ticker, {
            date: today,
            timestamp: Date.now(),
            netPremium: tf.netPremium,
            callPremium: tf.callPremium,
            putPremium: tf.putPremium,
            callVolume: tf.callVolume,
            putVolume: tf.putVolume,
          });
        }
      }
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
                {data.marketFlow && data.marketFlow.tickersScanned > 0
                  ? ` Scanned ${data.marketFlow.contractsAnalyzed.toLocaleString()} contracts across ${data.marketFlow.tickersScanned} tickers.`
                  : ''}
              </p>
            )}

            <InfoBox>
              <p><strong className="text-text-muted">VIX</strong> — The CBOE Volatility Index measures expected 30-day S&P 500 volatility. Historical mean is ~20. Below 15 is extreme complacency (options are cheap — good for buying). Above 25 indicates significant hedging demand. Above 35 historically marks major bottoming zones (mean reversion opportunity).</p>
              <p><strong className="text-text-muted">SKEW</strong> — Measures the cost of OTM puts vs calls. Normal range: 120-140. Above 145: market is pricing larger tail risk than VIX alone suggests. When SKEW diverges from VIX (high SKEW + low VIX), smart money is quietly hedging while the market appears calm.</p>
              <p><strong className="text-text-muted">Net Premium Flow</strong> — Total call premium minus total put premium across major tickers (SPY, QQQ, IWM, NVDA, TSLA, AAPL, AMZN, META, MSFT, AMD). Positive = institutions buying calls (bullish). Typical daily range: $100M-$500M. Above $500M = very aggressive positioning. Cross-reference with VIX: if net premium is bullish but VIX is rising, institutions may be buying calls to hedge short positions.</p>
              <p><strong className="text-text-muted">P/C Ratio</strong> — Put volume / call volume. Historical average: ~0.85. Below 0.7 = aggressive call buying (bullish). Above 1.2 = heavy put activity (bearish/hedging). Extreme readings (&gt;1.5) often mark sentiment washouts and subsequent reversals.</p>
            </InfoBox>
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
            Net premium = call premium - put premium. Green = net call buying (bullish), Red = net put buying (bearish). Click a ticker to view its full analysis.
          </p>
          <InfoBox>
            <p><strong className="text-text-muted">How to read this</strong> — Each card shows the NET premium direction for that ticker. Positive (green) means more money is flowing into calls than puts. Magnitude matters: $100M+ is significant for single names, $50M+ for ETFs.</p>
            <p><strong className="text-text-muted">Sector rotation</strong> — Compare flow across tickers: if SPY/QQQ are green but IWM is red, institutions are favoring large-caps over small-caps. If tech names (NVDA, AMZN, META) are all strongly positive while defensives are flat, it's a risk-on rotation.</p>
            <p><strong className="text-text-muted">Divergence signals</strong> — When a ticker's flow diverges from its index (e.g., TSLA deeply red while QQQ is green), it may signal stock-specific hedging or conviction that the name will underperform. Cross-reference with the dealer tab for that ticker.</p>
          </InfoBox>
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
          <InfoBox>
            <p><strong className="text-yellow-400/80">SWEEP</strong> — Fills on 3+ exchanges within 2 seconds. The trader is aggressively lifting every available offer simultaneously, accepting worse prices for speed. This is the strongest signal of directional conviction — they need the position NOW.</p>
            <p><strong className="text-purple-400/80">BLOCK</strong> — A single negotiated fill of 100+ contracts. Typically institutional-to-institutional dark pool trades. Blocks indicate large, deliberate positioning rather than speculative activity.</p>
            <p><strong className="text-amber-400/80">LARGE</strong> — $100K+ premium on a single contract line. Significant capital commitment that's unlikely to be retail. Multiple large alerts on the same ticker/direction = high institutional conviction.</p>
            <p><strong className="text-cyan-400/80">UNUSUAL</strong> — Volume exceeds 2x open interest, meaning most activity is new positions being opened (not closing). When combined with rising OI, this represents fresh money entering the trade.</p>
            <p><strong className="text-text-muted">Vol/OI ratio</strong> — How many times today's volume exceeds existing open interest. 1x = normal turnover. 2-5x = notable. 10x+ = very aggressive new positioning. 50x+ = likely a one-day event trade (earnings, binary catalyst).</p>
            <p><strong className="text-text-muted">Sentiment dot</strong> — Green = bullish (call price rising or put price falling). Red = bearish (put price rising or call price falling). Derived from whether the contract's price went up or down today relative to open.</p>
          </InfoBox>
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
            <InfoBox>
              <p><strong className="text-text-muted">Days-to-Cover (DTC)</strong> — Short interest divided by average daily volume. Tells you how many days it would take all short sellers to cover. DTC &gt; 5 = elevated squeeze risk. DTC &gt; 10 = significant. DTC &gt; 20 = extreme — any positive catalyst could trigger cascading short covering. Note: SI data is reported bi-monthly (15-day delay).</p>
              <p><strong className="text-text-muted">Short Volume Ratio</strong> — Percentage of today's total volume that was short selling. Above 50% means more than half of all trades were short sales. Sustained high short volume (&gt;60%) indicates active bearish conviction. However, market maker short selling for liquidity can inflate this number — cross-reference with DTC and Reg SHO for true bearish intent.</p>
              <p><strong className="text-text-muted">Squeeze setup checklist</strong> — Look for: (1) DTC &gt; 10 + (2) Short ratio &gt; 50% + (3) On Reg SHO list + (4) Bullish options flow (sweeps/blocks on calls). All four together = highest probability squeeze.</p>
            </InfoBox>

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
                <InfoBox>
                  <p><strong className="text-text-muted">Reg SHO Threshold</strong> — Securities with persistent failures-to-deliver (FTDs) for 5+ consecutive settlement days. Being on this list means market makers have repeatedly failed to locate shares to borrow, creating forced buying pressure. Cross-reference with high short interest (DTC &gt; 10 days) for squeeze candidates.</p>
                </InfoBox>
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
            <InfoBox>
              <p><strong className="text-text-muted">Equity Swaps</strong> — OTC derivatives where one party pays the return on an equity (or basket) in exchange for a fixed/floating rate. When swaps mature, the dealer holding the hedge must sell or buy the underlying stock to unwind their position.</p>
              <p><strong className="text-text-muted">Maturity Clusters</strong> — When many swaps on the same name mature together, the forced unwinding creates large directional flow that the market must absorb. This is NOT discretionary trading — dealers MUST execute regardless of price.</p>
              <p><strong className="text-text-muted">How to use</strong> — Look for names with: (1) High swap maturity notional + (2) Small average daily volume = maximum price impact. Cross-reference with options flow: if institutions are positioning ahead of large maturity dates, they may be front-running the forced flow.</p>
              <p><strong className="text-text-muted">Notional context</strong> — $1B+ notional maturing on a single name is significant for mid/large-caps. For mega-caps (AAPL, MSFT), even $5B+ may be absorbed normally. For small-caps, $100M+ is notable.</p>
            </InfoBox>
          </div>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════
          TODAY VS HISTORY — Quick comparison of today's flow
          ═══════════════════════════════════════════════════════ */}
      {data && data.marketFlow && (() => {
        const history: DailyFlowRecord[] = loadFlowHistory();
        if (history.length < 3) return null;

        const avg = {
          netPremium: history.reduce((s, r) => s + r.netPremium, 0) / history.length,
          putCallRatio: history.reduce((s, r) => s + r.putCallRatio, 0) / history.length,
          sweepCount: history.reduce((s, r) => s + r.sweepCount, 0) / history.length,
          blockCount: history.reduce((s, r) => s + r.blockCount, 0) / history.length,
        };

        const metrics = [
          {
            label: 'Net Premium',
            today: data.marketFlow!.netPremium,
            avg: avg.netPremium,
            format: (n: number) => fmt$(n),
            positive: data.marketFlow!.netPremium > avg.netPremium,
          },
          {
            label: 'P/C Ratio',
            today: data.marketFlow!.putCallRatio,
            avg: avg.putCallRatio,
            format: (n: number) => n.toFixed(2),
            positive: data.marketFlow!.putCallRatio < avg.putCallRatio,
          },
          {
            label: 'Sweeps',
            today: (data.flowAlerts || []).filter((a: FlowAlert) => a.tradeType === 'sweep').length,
            avg: avg.sweepCount,
            format: (n: number) => n.toFixed(0),
            positive: true,
          },
          {
            label: 'Blocks',
            today: (data.flowAlerts || []).filter((a: FlowAlert) => a.tradeType === 'block').length,
            avg: avg.blockCount,
            format: (n: number) => n.toFixed(0),
            positive: true,
          },
        ];

        return (
          <div className="panel">
            <div className="panel-header">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
                <span className="panel-title">Today vs {history.length}-Day Average</span>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border/20 border-t border-border/20">
              {metrics.map(m => {
                const diff = m.today - m.avg;
                const diffPct = m.avg !== 0 ? (diff / Math.abs(m.avg)) * 100 : 0;
                return (
                  <div key={m.label} className="bg-bg-secondary px-4 py-3">
                    <div className="text-[10px] text-text-muted font-mono mb-0.5">{m.label}</div>
                    <div className="text-lg font-bold font-mono text-text-primary">{m.format(m.today)}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="text-[10px] font-mono text-text-muted">avg: {m.format(m.avg)}</span>
                      {Math.abs(diffPct) > 10 && (
                        <span className={`text-[10px] font-mono font-semibold ${diffPct > 0 === m.positive ? 'text-green-400' : 'text-red-400'}`}>
                          {diffPct > 0 ? '+' : ''}{diffPct.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════
          FLOW HISTORY — Historical time series of premium flow
          ═══════════════════════════════════════════════════════ */}
      <Section
        title="Flow History"
        icon={<TrendingUp className="w-3.5 h-3.5 text-cyan-400" />}
        badge={<span className="text-[10px] text-text-muted/50 font-mono">auto-recorded daily</span>}
        defaultOpen={true}
      >
        <FlowHistoryPanel />
      </Section>

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
