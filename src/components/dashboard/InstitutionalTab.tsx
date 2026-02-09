'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import type { MultiGEXData, SnapshotData, RecommendationData } from '@/hooks/useDashboardStore';
import {
  Building2, RefreshCw, Loader2, ArrowRightLeft, ShieldAlert, AlertTriangle, Clock,
  TrendingUp, TrendingDown, Activity, Target, BarChart3, Zap, ChevronDown, ChevronUp,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────

interface TickerSI {
  shortInterest: number;
  daysToCover: number;
  avgDailyVolume: number;
  settlementDate: string;
  previousSI: number;
  changePercent: number;
}

interface TickerSVDay {
  date: string;
  shortVolume: number;
  totalVolume: number;
  shortRatio: number;
}

interface TickerSwaps {
  maturitiesToday: number;
  notionalToday: number;
  maturitiesWeek: number;
  notionalWeek: number;
  totalOpen: number;
  totalNotional: number;
}

interface InstitutionalAPIData {
  timestamp: number;
  ticker?: string;
  tickerSI?: TickerSI | null;
  tickerSVHistory?: TickerSVDay[];
  tickerSwaps?: TickerSwaps | null;
  tickerOnRegSHO?: boolean;
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
  siScreener: { symbol: string; daysToCover: number; shortInterest: number; avgDailyVolume: number }[];
  siAsOf: string;
  svScreener: { symbol: string; shortVolume: number; totalVolume: number; shortRatio: number }[];
  svAsOf: string;
}

// ─── Conviction Score ───────────────────────────────────────

interface ConvictionFactor {
  name: string;
  score: number;
  maxScore: number;
  description: string;
  signal: 'bullish' | 'bearish' | 'neutral';
}

function computeConvictionScore(
  multiGEX: MultiGEXData | null,
  snapshot: SnapshotData | null,
  recommendations: RecommendationData | null,
  tickerSI: TickerSI | null,
  tickerSVHistory: TickerSVDay[],
  onRegSHO: boolean,
): { score: number; factors: ConvictionFactor[] } {
  const factors: ConvictionFactor[] = [];

  // 1. GEX Regime (weight 2)
  if (recommendations) {
    const gex = recommendations.gammaRegime;
    const s = gex === 'long' ? 2 : gex === 'short' ? -2 : 0;
    factors.push({
      name: 'Gamma Regime',
      score: s, maxScore: 2,
      description: gex === 'long' ? 'Long gamma — dealers buy dips, mean-reverting' :
        gex === 'short' ? 'Short gamma — dealers amplify moves, trend-following' :
        'Neutral gamma exposure',
      signal: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
    });
  }

  // 2. Gamma Flip Proximity (weight 2)
  if (multiGEX?.aggregated?.gammaFlip && multiGEX.spotPrice > 0) {
    const flip = multiGEX.aggregated.gammaFlip;
    const spot = multiGEX.spotPrice;
    const pctAbove = ((spot - flip) / spot) * 100;
    let s: number;
    if (pctAbove > 3) s = 2;
    else if (pctAbove > 0) s = Math.round(pctAbove / 1.5 * 10) / 10;
    else if (pctAbove > -3) s = Math.round(pctAbove / 1.5 * 10) / 10;
    else s = -2;
    s = Math.max(-2, Math.min(2, s));
    factors.push({
      name: 'Gamma Flip Proximity',
      score: s, maxScore: 2,
      description: pctAbove > 0
        ? `Spot ${pctAbove.toFixed(1)}% above gamma flip ($${flip.toFixed(0)}) — dealer support`
        : `Spot ${Math.abs(pctAbove).toFixed(1)}% below gamma flip ($${flip.toFixed(0)}) — dealers sell into weakness`,
      signal: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
    });
  }

  // 3. Vanna Regime (weight 1.5)
  if (multiGEX?.aggregated) {
    const vanna = multiGEX.aggregated.totalVanna;
    const gex = Math.abs(multiGEX.aggregated.totalGEX);
    const threshold = gex * 0.01 || 1;
    const regime = vanna > threshold ? 'bullish' : vanna < -threshold ? 'bearish' : 'neutral';
    const s = regime === 'bullish' ? 1.5 : regime === 'bearish' ? -1.5 : 0;
    factors.push({
      name: 'Vanna Exposure',
      score: s, maxScore: 1.5,
      description: regime === 'bullish' ? 'Vol drop forces dealers to buy — supportive' :
        regime === 'bearish' ? 'Vol spike forces dealers to sell — pressured' :
        'Minimal vanna-driven pressure',
      signal: regime as 'bullish' | 'bearish' | 'neutral',
    });
  }

  // 4. Put/Call Ratio (weight 1.5)
  if (multiGEX?.volume) {
    const pcr = multiGEX.volume.volumePCR;
    let s: number;
    if (pcr < 0.6) s = 1.5;
    else if (pcr < 0.8) s = 0.5;
    else if (pcr > 1.4) s = -1.5;
    else if (pcr > 1.1) s = -0.5;
    else s = 0;
    factors.push({
      name: 'Put/Call Ratio',
      score: s, maxScore: 1.5,
      description: pcr < 0.8 ? `PCR ${pcr.toFixed(2)} — call-dominant flow (bullish)` :
        pcr > 1.2 ? `PCR ${pcr.toFixed(2)} — heavy put buying (bearish)` :
        `PCR ${pcr.toFixed(2)} — balanced flow`,
      signal: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
    });
  }

  // 5. IV Rank (weight 1)
  if (snapshot?.iv) {
    const rank = snapshot.iv.ivRank;
    let s: number;
    if (rank < 20) s = 0.5;       // Low vol = complacent = bullish lean
    else if (rank > 80) s = -1;    // High vol = fear = bearish
    else if (rank > 60) s = -0.5;
    else s = 0;
    factors.push({
      name: 'IV Rank',
      score: s, maxScore: 1,
      description: rank > 70 ? `IV Rank ${rank} — elevated fear/hedging` :
        rank < 25 ? `IV Rank ${rank} — complacent, options cheap` :
        `IV Rank ${rank} — mid-range`,
      signal: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
    });
  }

  // 6. Short Interest DTC (weight 1.5)
  if (tickerSI) {
    const dtc = tickerSI.daysToCover;
    let s: number;
    if (dtc > 10) s = -1.5;      // Heavily shorted
    else if (dtc > 5) s = -1;
    else if (dtc > 2) s = -0.5;
    else s = 0.5;                 // Low SI = no short pressure
    factors.push({
      name: 'Short Interest',
      score: s, maxScore: 1.5,
      description: dtc > 10 ? `${dtc.toFixed(1)} DTC — heavy short exposure, squeeze potential` :
        dtc > 5 ? `${dtc.toFixed(1)} DTC — moderate short pressure` :
        dtc > 2 ? `${dtc.toFixed(1)} DTC — mild short interest` :
        `${dtc.toFixed(1)} DTC — minimal short pressure`,
      signal: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
    });
  }

  // 7. SI Change Trend (weight 1)
  if (tickerSI && tickerSI.changePercent !== 0) {
    const chg = tickerSI.changePercent;
    let s: number;
    if (chg < -15) s = 1;        // Shorts covering aggressively = bullish
    else if (chg < -5) s = 0.5;
    else if (chg > 15) s = -1;   // Shorts piling in = bearish
    else if (chg > 5) s = -0.5;
    else s = 0;
    factors.push({
      name: 'SI Trend',
      score: s, maxScore: 1,
      description: chg < -5 ? `SI down ${Math.abs(chg).toFixed(1)}% — short covering (bullish)` :
        chg > 5 ? `SI up ${chg.toFixed(1)}% — shorts adding (bearish)` :
        `SI change ${chg > 0 ? '+' : ''}${chg.toFixed(1)}% — stable`,
      signal: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
    });
  }

  // 8. Short Volume Ratio (weight 1)
  if (tickerSVHistory.length > 0) {
    const latest = tickerSVHistory[0];
    const ratio = latest.shortRatio;
    let s: number;
    if (ratio < 0.30) s = 1;     // Low short selling = bullish
    else if (ratio < 0.40) s = 0.5;
    else if (ratio > 0.55) s = -1; // Majority short selling = bearish
    else if (ratio > 0.45) s = -0.5;
    else s = 0;
    factors.push({
      name: 'Short Volume',
      score: s, maxScore: 1,
      description: ratio > 0.50 ? `${(ratio * 100).toFixed(0)}% short volume — active short selling` :
        ratio < 0.35 ? `${(ratio * 100).toFixed(0)}% short volume — minimal short activity` :
        `${(ratio * 100).toFixed(0)}% short volume — normal range`,
      signal: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
    });
  }

  // 9. Reg SHO (weight 1) — contrarian: FTDs = forced covering potential
  if (onRegSHO) {
    factors.push({
      name: 'Reg SHO Threshold',
      score: 1, maxScore: 1,
      description: 'On Reg SHO list — persistent FTDs, forced covering potential (squeeze catalyst)',
      signal: 'bullish',
    });
  }

  // 10. Max Pain Convergence (weight 0.5)
  if (multiGEX?.spotPrice && multiGEX.aggregated?.callWall && multiGEX.aggregated?.putWall) {
    const spot = multiGEX.spotPrice;
    const call = multiGEX.aggregated.callWall;
    const put = multiGEX.aggregated.putWall;
    const range = call - put;
    if (range > 0) {
      const posInRange = (spot - put) / range; // 0 = at put wall, 1 = at call wall
      let s: number;
      if (posInRange > 0.85) s = -0.5;   // Near call wall = resistance
      else if (posInRange < 0.15) s = 0.5; // Near put wall = support
      else s = 0;
      if (s !== 0) {
        factors.push({
          name: 'GEX Range Position',
          score: s, maxScore: 0.5,
          description: posInRange > 0.8 ? 'Near call wall — dealer resistance overhead' :
            'Near put wall — dealer support below',
          signal: s > 0 ? 'bullish' : 'bearish',
        });
      }
    }
  }

  // Compute total score normalized to -100 to +100
  const totalScore = factors.reduce((sum, f) => sum + f.score, 0);
  const maxPossible = factors.reduce((sum, f) => sum + f.maxScore, 0);
  const normalized = maxPossible > 0 ? Math.round((totalScore / maxPossible) * 100) : 0;

  return { score: normalized, factors };
}

// ─── Format Helpers ─────────────────────────────────────────

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
  } catch { return d; }
}

function formatShortDate(d: string): string {
  if (!d) return '';
  try {
    return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return d; }
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

// ─── Score Display ──────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const abs = Math.abs(score);
  const label = abs >= 60 ? 'Strong' : abs >= 30 ? 'Moderate' : abs >= 10 ? 'Lean' : 'Neutral';
  const direction = score > 5 ? 'Bullish' : score < -5 ? 'Bearish' : 'Neutral';
  const color = score > 30 ? 'text-green-400' : score > 5 ? 'text-green-400/70' :
    score < -30 ? 'text-red-400' : score < -5 ? 'text-red-400/70' : 'text-text-muted';
  const bgColor = score > 30 ? 'bg-green-500' : score > 5 ? 'bg-green-500/70' :
    score < -30 ? 'bg-red-500' : score < -5 ? 'bg-red-500/70' : 'bg-text-muted';

  // Bar: centered at 50%, extends left (bearish) or right (bullish)
  const barWidth = Math.min(Math.abs(score), 100) / 2; // half-width percentage
  const barLeft = score >= 0 ? 50 : 50 - barWidth;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <span className={`text-3xl font-bold font-mono ${color}`}>
          {score > 0 ? '+' : ''}{score}
        </span>
        <span className={`text-lg font-semibold ${color}`}>
          {label} {direction}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-bg-tertiary overflow-hidden">
        <div className="absolute top-0 left-1/2 w-px h-full bg-text-muted/30" />
        <div
          className={`absolute top-0 h-full rounded-full ${bgColor} transition-all duration-500`}
          style={{ left: `${barLeft}%`, width: `${barWidth}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-text-muted/40 font-mono">
        <span>-100 Bearish</span>
        <span>Neutral</span>
        <span>+100 Bullish</span>
      </div>
    </div>
  );
}

function FactorRow({ factor }: { factor: ConvictionFactor }) {
  const icon = factor.signal === 'bullish' ? <TrendingUp className="w-3 h-3 text-green-400" /> :
    factor.signal === 'bearish' ? <TrendingDown className="w-3 h-3 text-red-400" /> :
    <Activity className="w-3 h-3 text-text-muted" />;
  const scoreColor = factor.score > 0 ? 'text-green-400' : factor.score < 0 ? 'text-red-400' : 'text-text-muted';

  return (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-bg-hover/30 transition-colors">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-mono font-semibold text-text-primary">{factor.name}</span>
          <span className={`text-xs font-mono font-bold ${scoreColor}`}>
            {factor.score > 0 ? '+' : ''}{factor.score.toFixed(1)}
          </span>
        </div>
        <p className="text-[10px] text-text-muted leading-tight">{factor.description}</p>
      </div>
    </div>
  );
}

// ─── Collapsible Section ────────────────────────────────────

function Section({ title, icon, badge, defaultOpen = true, children }: {
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
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

// ─── Main Component ─────────────────────────────────────────

export default function InstitutionalTab() {
  const { loadSymbol, setActiveTab, symbol, multiGEX, snapshot, recommendations } = useDashboardStore();
  const [apiData, setApiData] = useState<InstitutionalAPIData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoLoaded, setAutoLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = symbol ? `/api/market/institutional?ticker=${symbol}` : '/api/market/institutional';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setApiData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  // Auto-load on first render
  useEffect(() => {
    if (!autoLoaded) {
      setAutoLoaded(true);
      fetchData();
    }
  }, [autoLoaded, fetchData]);

  const navigateToStock = useCallback((sym: string) => {
    loadSymbol(sym);
    setActiveTab('overview');
  }, [loadSymbol, setActiveTab]);

  // Compute conviction score from store + API data
  const conviction = useMemo(() => {
    return computeConvictionScore(
      multiGEX ?? null,
      snapshot ?? null,
      recommendations ?? null,
      apiData?.tickerSI ?? null,
      apiData?.tickerSVHistory ?? [],
      apiData?.tickerOnRegSHO ?? false,
    );
  }, [multiGEX, snapshot, recommendations, apiData]);

  const hasTickerData = symbol && (multiGEX || apiData?.tickerSI || apiData?.tickerSVHistory?.length);

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-accent-purple" />
            <span className="panel-title">
              Institutional Analysis{symbol ? ` — ${symbol}` : ''}
            </span>
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

      {loading && !apiData && (
        <div className="panel p-8 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-accent-purple mr-3" />
          <span className="text-text-muted font-mono text-sm">Loading institutional data...</span>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          SECTION 1: CONVICTION SCORE (most important — top of page)
          ═══════════════════════════════════════════════════════════ */}
      {hasTickerData && (
        <Section
          title="Institutional Conviction Score"
          icon={<Target className="w-3.5 h-3.5 text-accent-purple" />}
          badge={
            <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
              conviction.score > 30 ? 'bg-green-500/10 text-green-400' :
              conviction.score > 5 ? 'bg-green-500/10 text-green-400/70' :
              conviction.score < -30 ? 'bg-red-500/10 text-red-400' :
              conviction.score < -5 ? 'bg-red-500/10 text-red-400/70' :
              'bg-bg-tertiary text-text-muted'
            }`}>
              {conviction.score > 0 ? '+' : ''}{conviction.score}
            </span>
          }
        >
          <div className="space-y-4">
            <ScoreBar score={conviction.score} />
            <div className="text-xs text-text-muted/60 font-mono">
              Composite of {conviction.factors.length} signals from options flow, dealer positioning, short data, and market structure.
            </div>
            <div className="space-y-0.5">
              {conviction.factors
                .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
                .map(f => <FactorRow key={f.name} factor={f} />)}
            </div>
          </div>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════════
          SECTION 2: DEALER POSITIONING (highest predictive value)
          ═══════════════════════════════════════════════════════════ */}
      {multiGEX && (
        <Section
          title="Dealer Positioning"
          icon={<Zap className="w-3.5 h-3.5 text-cyan-400" />}
          badge={
            <span className={`text-xs font-mono px-2 py-0.5 rounded ${
              recommendations?.gammaRegime === 'long' ? 'bg-green-500/10 text-green-400' :
              recommendations?.gammaRegime === 'short' ? 'bg-red-500/10 text-red-400' :
              'bg-bg-tertiary text-text-muted'
            }`}>
              {recommendations?.gammaRegime === 'long' ? 'Long Gamma' :
               recommendations?.gammaRegime === 'short' ? 'Short Gamma' : 'Neutral'}
            </span>
          }
        >
          <div className="space-y-4">
            {/* Key Levels Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard
                label="Net GEX"
                value={formatGEX(multiGEX.aggregated.totalGEX)}
                color={multiGEX.aggregated.totalGEX >= 0 ? 'green' : 'red'}
                sub={multiGEX.aggregated.totalGEX >= 0 ? 'Supportive' : 'Volatile'}
              />
              <MetricCard
                label="Gamma Flip"
                value={multiGEX.aggregated.gammaFlip ? `$${multiGEX.aggregated.gammaFlip.toFixed(0)}` : 'N/A'}
                color={multiGEX.aggregated.gammaFlip && multiGEX.spotPrice > multiGEX.aggregated.gammaFlip ? 'green' : 'red'}
                sub={multiGEX.aggregated.gammaFlip
                  ? `${((multiGEX.spotPrice - multiGEX.aggregated.gammaFlip) / multiGEX.spotPrice * 100).toFixed(1)}% ${multiGEX.spotPrice > multiGEX.aggregated.gammaFlip ? 'above' : 'below'}`
                  : ''}
              />
              <MetricCard
                label="Call Wall"
                value={multiGEX.aggregated.callWall ? `$${multiGEX.aggregated.callWall.toFixed(0)}` : 'N/A'}
                color="muted"
                sub="Resistance"
              />
              <MetricCard
                label="Put Wall"
                value={multiGEX.aggregated.putWall ? `$${multiGEX.aggregated.putWall.toFixed(0)}` : 'N/A'}
                color="muted"
                sub="Support"
              />
            </div>

            {/* Vanna / Charm */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard
                label="Vanna"
                value={formatGEX(multiGEX.aggregated.totalVanna)}
                color={multiGEX.aggregated.totalVanna > 0 ? 'green' : multiGEX.aggregated.totalVanna < 0 ? 'red' : 'muted'}
                sub={multiGEX.aggregated.totalVanna > 0 ? 'Vol drop = buying' : multiGEX.aggregated.totalVanna < 0 ? 'Vol spike = selling' : 'Neutral'}
              />
              <MetricCard
                label="Charm"
                value={formatGEX(multiGEX.aggregated.totalCharm)}
                color={multiGEX.aggregated.totalCharm > 0 ? 'green' : multiGEX.aggregated.totalCharm < 0 ? 'red' : 'muted'}
                sub={multiGEX.aggregated.totalCharm > 0 ? 'Time decay = buying' : multiGEX.aggregated.totalCharm < 0 ? 'Time decay = selling' : 'Neutral'}
              />
              <MetricCard
                label="Volume P/C"
                value={multiGEX.volume.volumePCR.toFixed(2)}
                color={multiGEX.volume.volumePCR < 0.8 ? 'green' : multiGEX.volume.volumePCR > 1.2 ? 'red' : 'muted'}
                sub={multiGEX.volume.volumePCR < 0.8 ? 'Call-dominant' : multiGEX.volume.volumePCR > 1.2 ? 'Put-heavy' : 'Balanced'}
              />
              <MetricCard
                label="Max Pain"
                value={multiGEX.maxPain?.strike ? `$${multiGEX.maxPain.strike.toFixed(0)}` : 'N/A'}
                color="muted"
                sub={multiGEX.maxPain?.strike
                  ? `Spot ${((multiGEX.spotPrice - multiGEX.maxPain.strike) / multiGEX.spotPrice * 100).toFixed(1)}% ${multiGEX.spotPrice > multiGEX.maxPain.strike ? 'above' : 'below'}`
                  : ''}
              />
            </div>

            {/* IV Context */}
            {snapshot?.iv && (
              <div className="grid grid-cols-3 gap-3">
                <MetricCard
                  label="IV Rank"
                  value={`${snapshot.iv.ivRank}`}
                  color={snapshot.iv.ivRank > 70 ? 'red' : snapshot.iv.ivRank < 25 ? 'green' : 'muted'}
                  sub={snapshot.iv.ivRank > 70 ? 'Elevated fear' : snapshot.iv.ivRank < 25 ? 'Cheap options' : 'Mid-range'}
                />
                <MetricCard
                  label="Current IV"
                  value={`${(snapshot.iv.currentIV * 100).toFixed(1)}%`}
                  color="muted"
                  sub={`HV: ${(snapshot.iv.hvCurrent * 100).toFixed(1)}%`}
                />
                <MetricCard
                  label="IV/HV Ratio"
                  value={snapshot.iv.ivHvRatio.toFixed(2)}
                  color={snapshot.iv.ivHvRatio > 1.3 ? 'red' : snapshot.iv.ivHvRatio < 0.8 ? 'green' : 'muted'}
                  sub={snapshot.iv.ivHvRatio > 1.2 ? 'IV overpriced' : snapshot.iv.ivHvRatio < 0.9 ? 'IV underpriced' : 'Fair value'}
                />
              </div>
            )}

            <p className="text-[10px] text-text-muted/50 px-1">
              Dealer positioning from {multiGEX.expirationsCovered.length} expiration{multiGEX.expirationsCovered.length !== 1 ? 's' : ''}. GEX = gamma exposure, Vanna = delta sensitivity to vol, Charm = delta sensitivity to time.
            </p>
          </div>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════════
          SECTION 3: SHORT PRESSURE (per-ticker)
          ═══════════════════════════════════════════════════════════ */}
      {apiData && symbol && (
        <Section
          title={`Short Pressure — ${symbol}`}
          icon={<ShieldAlert className="w-3.5 h-3.5 text-orange-400" />}
          badge={apiData.tickerOnRegSHO ? (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
              REG SHO
            </span>
          ) : null}
        >
          <div className="space-y-4">
            {/* Short Interest */}
            {apiData.tickerSI ? (
              <div>
                <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Short Interest</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricCard
                    label="Days to Cover"
                    value={`${apiData.tickerSI.daysToCover.toFixed(1)}d`}
                    color={apiData.tickerSI.daysToCover > 10 ? 'red' : apiData.tickerSI.daysToCover > 5 ? 'yellow' : 'muted'}
                    sub={apiData.tickerSI.daysToCover > 10 ? 'Heavy' : apiData.tickerSI.daysToCover > 5 ? 'Moderate' : 'Low'}
                  />
                  <MetricCard
                    label="Shares Short"
                    value={formatVolume(apiData.tickerSI.shortInterest)}
                    color="muted"
                    sub={`ADV: ${formatVolume(apiData.tickerSI.avgDailyVolume)}`}
                  />
                  <MetricCard
                    label="Change"
                    value={apiData.tickerSI.changePercent !== 0 ? `${apiData.tickerSI.changePercent > 0 ? '+' : ''}${apiData.tickerSI.changePercent.toFixed(1)}%` : '—'}
                    color={apiData.tickerSI.changePercent > 5 ? 'red' : apiData.tickerSI.changePercent < -5 ? 'green' : 'muted'}
                    sub={apiData.tickerSI.changePercent > 0 ? 'Shorts adding' : apiData.tickerSI.changePercent < 0 ? 'Shorts covering' : 'vs prior period'}
                  />
                  <MetricCard
                    label="Settlement"
                    value={formatShortDate(apiData.tickerSI.settlementDate)}
                    color="muted"
                    sub={isStale(apiData.tickerSI.settlementDate) ? 'Biweekly update' : 'Current'}
                  />
                </div>
              </div>
            ) : (
              <div className="text-xs text-text-muted font-mono py-2">
                No short interest data available for {symbol}. Data updates biweekly — this ticker may not be covered by Polygon SI.
              </div>
            )}

            {/* Short Volume History */}
            {apiData.tickerSVHistory && apiData.tickerSVHistory.length > 0 ? (
              <div>
                <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Daily Short Volume (Recent)</div>
                <div className="space-y-1">
                  {apiData.tickerSVHistory.slice(0, 5).map((day) => (
                    <div key={day.date} className="flex items-center gap-3 text-xs font-mono">
                      <span className="text-text-muted w-16">{formatShortDate(day.date)}</span>
                      <div className="flex-1 relative h-5 bg-bg-tertiary rounded overflow-hidden">
                        <div
                          className={`absolute left-0 top-0 h-full rounded transition-all ${
                            day.shortRatio > 0.55 ? 'bg-red-500/40' :
                            day.shortRatio > 0.45 ? 'bg-orange-500/30' :
                            'bg-blue-500/20'
                          }`}
                          style={{ width: `${Math.min(day.shortRatio * 100, 100)}%` }}
                        />
                        <div className="absolute inset-0 flex items-center px-2 justify-between">
                          <span className={`text-[10px] font-semibold ${
                            day.shortRatio > 0.50 ? 'text-red-400' :
                            day.shortRatio > 0.40 ? 'text-orange-400' :
                            'text-text-secondary'
                          }`}>
                            {(day.shortRatio * 100).toFixed(1)}%
                          </span>
                          <span className="text-[10px] text-text-muted">
                            {formatVolume(day.shortVolume)} / {formatVolume(day.totalVolume)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-text-muted/50 mt-1 px-1">
                  Short volume ratio = short sales / total volume. Above 50% = majority of trading is short selling.
                </p>
              </div>
            ) : (
              <div className="text-xs text-text-muted font-mono py-2">
                No daily short volume history for {symbol}.
              </div>
            )}

            {/* Ticker Swap Data */}
            {apiData.tickerSwaps && (apiData.tickerSwaps.totalOpen > 0 || apiData.tickerSwaps.maturitiesToday > 0) && (
              <div>
                <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">DTCC Equity Swaps</div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricCard
                    label="Open Swaps"
                    value={apiData.tickerSwaps.totalOpen.toLocaleString()}
                    color="muted"
                    sub={formatNotional(apiData.tickerSwaps.totalNotional) + ' notional'}
                  />
                  <MetricCard
                    label="Maturing Today"
                    value={apiData.tickerSwaps.maturitiesToday.toLocaleString()}
                    color={apiData.tickerSwaps.maturitiesToday > 10 ? 'yellow' : 'muted'}
                    sub={apiData.tickerSwaps.maturitiesToday > 0 ? formatNotional(apiData.tickerSwaps.notionalToday) : 'None'}
                  />
                  <MetricCard
                    label="Maturing This Week"
                    value={apiData.tickerSwaps.maturitiesWeek.toLocaleString()}
                    color={apiData.tickerSwaps.maturitiesWeek > 50 ? 'yellow' : 'muted'}
                    sub={apiData.tickerSwaps.maturitiesWeek > 0 ? formatNotional(apiData.tickerSwaps.notionalWeek) : 'None'}
                  />
                  <MetricCard
                    label="Reg SHO"
                    value={apiData.tickerOnRegSHO ? 'YES' : 'No'}
                    color={apiData.tickerOnRegSHO ? 'red' : 'green'}
                    sub={apiData.tickerOnRegSHO ? 'Persistent FTDs' : 'No FTD issues'}
                  />
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════════
          SECTION 4: MARKET-WIDE SCREENER (expandable)
          ═══════════════════════════════════════════════════════════ */}
      {apiData && (
        <>
          {/* DTCC Swaps */}
          <Section
            title="DTCC Equity Swap Maturities"
            icon={<ArrowRightLeft className="w-3.5 h-3.5 text-accent-purple" />}
            badge={<DataAge asOf={apiData.swapSummary.asOf} />}
            defaultOpen={false}
          >
            {apiData.swapSummary.available ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricCard label="Maturities Today" value={apiData.swapSummary.totalMaturitiesToday.toLocaleString()} color="muted" />
                  <MetricCard label="Notional Today" value={formatNotional(apiData.swapSummary.totalNotionalToday)} color="purple" />
                  <MetricCard label="Maturities Week" value={apiData.swapSummary.totalMaturitiesWeek.toLocaleString()} color="muted" />
                  <MetricCard label="Notional Week" value={formatNotional(apiData.swapSummary.totalNotionalWeek)} color="purple" />
                </div>
                {apiData.swapSummary.topMaturities.length > 0 && (
                  <div>
                    <div className="text-xs text-text-muted font-mono mb-2 uppercase tracking-wider">Top Maturities by Notional</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                      {apiData.swapSummary.topMaturities.slice(0, 10).map(m => (
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
              <p className="text-sm text-text-muted text-center py-4">DTCC swap data unavailable.</p>
            )}
          </Section>

          {/* Reg SHO */}
          <Section
            title="Reg SHO Threshold List"
            icon={<ShieldAlert className="w-3.5 h-3.5 text-red-400" />}
            badge={<span className="text-xs text-text-muted font-mono">{apiData.regSHOList.length} securities</span>}
            defaultOpen={false}
          >
            {apiData.regSHOList.length > 0 ? (
              <div>
                <p className="text-xs text-text-muted mb-3">Securities with persistent FTDs — potential short squeeze catalysts.</p>
                <div className="flex flex-wrap gap-2">
                  {apiData.regSHOList.map(sym => (
                    <span key={sym} className="text-xs font-mono px-3 py-1 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 cursor-pointer hover:bg-red-500/20 transition-colors" onClick={() => navigateToStock(sym)}>
                      {sym}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted text-center py-4">No Reg SHO data available.</p>
            )}
          </Section>

          {/* SI Screener */}
          <Section
            title="High Short Interest Screener"
            icon={<BarChart3 className="w-3.5 h-3.5 text-orange-400" />}
            badge={<DataAge asOf={apiData.siAsOf} />}
            defaultOpen={false}
          >
            {apiData.siScreener.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/30">
                      <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Symbol</th>
                      <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">DTC</th>
                      <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Short Interest</th>
                      <th className="px-3 py-2 text-right text-xs font-mono text-text-muted">Avg Daily Vol</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiData.siScreener.map((s, idx) => (
                      <tr key={s.symbol} className={`border-b border-border/10 hover:bg-bg-hover/50 cursor-pointer transition-colors ${idx % 2 === 0 ? 'bg-bg-secondary/30' : ''}`} onClick={() => navigateToStock(s.symbol)}>
                        <td className="px-3 py-2 font-mono font-semibold text-text-primary">{s.symbol}</td>
                        <td className={`px-3 py-2 font-mono text-right ${s.daysToCover > 20 ? 'text-orange-400 font-semibold' : s.daysToCover > 10 ? 'text-yellow-400' : 'text-text-secondary'}`}>{s.daysToCover.toFixed(1)}d</td>
                        <td className="px-3 py-2 font-mono text-right text-text-secondary">{formatVolume(s.shortInterest)}</td>
                        <td className="px-3 py-2 font-mono text-right text-text-muted">{formatVolume(s.avgDailyVolume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-text-muted text-center py-4">No high short-interest data available.</p>
            )}
          </Section>

          {/* SV Screener */}
          <Section
            title="High Short Volume Screener"
            icon={<Activity className="w-3.5 h-3.5 text-yellow-400" />}
            badge={<DataAge asOf={apiData.svAsOf} />}
            defaultOpen={false}
          >
            {apiData.svScreener.length > 0 ? (
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
                    {apiData.svScreener.slice(0, 20).map((s, idx) => (
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
            ) : (
              <p className="text-sm text-text-muted text-center py-4">No high short-volume data available.</p>
            )}
          </Section>
        </>
      )}

      {/* Footer */}
      <div className="text-center text-[10px] text-text-muted/40 font-mono py-2">
        Short Interest &amp; Volume via Polygon.io &bull; DTCC Swap Data &bull; FINRA Reg SHO &bull; Options positioning via Tradier
      </div>
    </div>
  );
}

// ─── Metric Card Component ──────────────────────────────────

function MetricCard({ label, value, color = 'muted', sub }: {
  label: string;
  value: string;
  color?: 'green' | 'red' | 'yellow' | 'purple' | 'muted';
  sub?: string;
}) {
  const valueColor = {
    green: 'text-green-400',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    purple: 'text-accent-purple',
    muted: 'text-text-primary',
  }[color];

  return (
    <div className="bg-bg-secondary/50 rounded-lg px-3 py-2 border border-border/20">
      <div className="text-[10px] text-text-muted font-mono uppercase tracking-wider mb-0.5">{label}</div>
      <div className={`text-lg font-bold font-mono ${valueColor}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-muted/60 font-mono">{sub}</div>}
    </div>
  );
}
