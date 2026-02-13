'use client';

import { useState, useCallback } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import {
  Newspaper, Loader2, AlertTriangle, TrendingUp, TrendingDown, Minus,
  Wallet, ChevronDown, ChevronUp, CheckCircle2, Sparkles, Eye, Crosshair,
} from 'lucide-react';
import { buildTrackedTradeFromAlgo, addTrackedTrade, sizePosition, fetchEntryPrices, fillEntryPrices, calculatePositionValue, validateAndClampStrikes, type TrackedLeg } from '@/lib/tradeTracker';
import { addSignal, loadSignals } from '@/lib/signalTracker';

// ─── Trade rule storage (shared with PaperTradingTab + PaperMonitor) ───
interface TradeRule {
  id: string;
  occSymbols: string[];
  underlying: string;
  strategy: string;
  thesis: string;
  profitTargetPct: number;
  stopLossPct: number;
  autoExit: boolean;
  createdAt: string;
  exitTriggered?: 'target' | 'stop' | null;
  exitOrderId?: number;
  isAITracked?: boolean; // true = managed by TrackerMonitor, PaperMonitor will skip
  // Legacy single-position fields (kept for backward compat)
  occSymbol?: string;
  targetPrice?: number | null;
  stopPrice?: number | null;
  costBasis?: number;
}

function loadRules(): TradeRule[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem('optix-paper-rules') || '[]'); }
  catch { return []; }
}

function saveGroupRule(rule: TradeRule) {
  const rules = loadRules().filter(r => r.id !== rule.id);
  rules.push(rule);
  localStorage.setItem('optix-paper-rules', JSON.stringify(rules));
}

function parseQuantity(strikesText: string): number {
  const m = strikesText.match(/^(\d+)\s*x\s/i) || strikesText.match(/×\s*(\d+)/);
  return m ? Math.max(1, Math.min(10, parseInt(m[1]))) : 1;
}

/** Validate and clamp a strike to be within 2 ATR of spot. Returns clamped strike. */
function clampStrike(strike: number, spot: number, type: 'C' | 'P'): number {
  const atr = spot * 0.015; // 1.5% default ATR
  const maxDist = atr * 2;
  const step = spot > 200 ? 5 : spot > 50 ? 2.5 : 1;
  if (type === 'C' && strike > spot + maxDist) {
    return Math.round((spot + maxDist) / step) * step;
  }
  if (type === 'P' && strike < spot - maxDist) {
    return Math.round((spot - maxDist) / step) * step;
  }
  return strike;
}

/** Calculate proper contract quantity using portfolio sizing (1-5% of $100K). */
function calcQty(spot: number, strategy: string, legs: { strike: number; type: 'C' | 'P'; side: 'long' | 'short' }[]): number {
  const trackerLegs: TrackedLeg[] = legs.map(l => ({
    optionSymbol: '', optionType: l.type === 'C' ? 'call' : 'put',
    strike: l.strike, expiration: '', side: l.side === 'long' ? 'long' : 'short',
    quantity: 1, entryBid: 0, entryAsk: 0, entryMid: 0,
    exitBid: null, exitAsk: null, exitMid: null,
    entryDelta: 0, entryGamma: 0, entryTheta: 0, entryVega: 0, entryIV: 0,
  }));
  return sizePosition(trackerLegs, strategy, spot);
}

/** Resolve the best expiration date for a trade.
 *  Algorithm trades: use targetExp from recommendation engine (already resolved).
 *  AI trades: parse DTE from expiration text, pick best available exp.
 */
function resolveExpiration(opts: {
  targetExp?: string;
  expirationText?: string;
  nearestExp: string;
  weeklyExp?: string;
  monthlyExp?: string;
}): string {
  // If we have an explicit targetExp from the algorithm, use it
  if (opts.targetExp) return opts.targetExp;

  // For AI trades, try to parse DTE from the expiration text
  if (opts.expirationText) {
    const dteMatch = opts.expirationText.match(/(\d+)\s*(?:DTE|dte|days?)/i);
    const dte = dteMatch ? parseInt(dteMatch[1]) : 0;
    // Also check for "30-45 DTE" range format
    const rangeMatch = opts.expirationText.match(/(\d+)\s*[-–]\s*(\d+)\s*DTE/i);
    const maxDTE = rangeMatch ? parseInt(rangeMatch[2]) : dte;

    if (maxDTE >= 25 && opts.monthlyExp) return opts.monthlyExp;
    if (maxDTE >= 25 && opts.weeklyExp) return opts.weeklyExp; // fallback
    if (maxDTE >= 10 && opts.weeklyExp) return opts.weeklyExp;

    // Also try to parse a date directly (e.g., "2025-02-21")
    const dateMatch = opts.expirationText.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) return dateMatch[1];
  }

  return opts.nearestExp;
}

function buildOCC(symbol: string, expiration: string, type: 'C' | 'P', strike: number): string {
  const d = new Date(expiration + 'T12:00:00');
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const t = type === 'C' ? 'C' : 'P';
  const s = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${symbol.toUpperCase()}${yy}${mm}${dd}${t}${s}`;
}

interface TradeIdea {
  ticker: string;
  spot: number;
  bias: string;
  biasScore: number;
  strategy: string;
  direction: string;
  confidence: string;
  score: number;
  strikes: string;
  expiration: string;
  targetExp: string;
  entry: string;
  risk: string;
  reasoning: string[];
  tags: string[];
  profitTargetPct: number;
  stopLossPct: number;
  nearestExp: string;
  nearestDTE: number;
  weeklyExp?: string;
  monthlyExp?: string;
  ivRank: number;
  currentIV: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
}

interface AITradeIdea {
  title: string;
  ticker: string;
  direction: string;
  strategy: string;
  strikes: string;
  expiration: string;
  entry: string;
  target: string;
  stopMaxLoss: string;
  thesis: string;
  invalidation: string;
  // Enriched from stock scan
  spot: number;
  nearestExp: string;
  nearestDTE: number;
  weeklyExp?: string;
  monthlyExp?: string;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  ivRank: number;
  biasScore: number;
  bias: string;
}

interface BriefingResponse {
  analysis: string;
  stocksScanned: number;
  timestamp: number;
  indices: {
    symbol: string;
    price: number;
    changePct: number;
    bias: string;
    biasScore: number;
    gammaRegime: string;
    volRegime: string;
    ivRank: number;
  }[];
  vix: number;
  tradeIdeas?: TradeIdea[];
  aiTradeIdeas?: AITradeIdea[];
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

function renderInline(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>');
}

function RenderMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="text-sm font-bold text-accent-cyan uppercase tracking-wider mt-6 mb-2 first:mt-0 border-b border-border/20 pb-1">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-sm font-semibold text-text-primary mt-4 mb-1">{line.slice(4)}</h3>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={i} className="flex items-start gap-2 text-sm text-text-secondary ml-2 mb-0.5">
          <span className="text-accent-cyan shrink-0 mt-1">{'>'}</span>
          <span className="leading-relaxed" dangerouslySetInnerHTML={{ __html: renderInline(line.slice(2)) }} />
        </div>
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(
        <p key={i} className="text-sm text-text-secondary leading-relaxed mb-1" dangerouslySetInnerHTML={{ __html: renderInline(line) }} />
      );
    }
  }

  return <>{elements}</>;
}

function TradeIdeasPanel({ ideas }: { ideas: TradeIdea[] }) {
  const { setActiveTab } = useDashboardStore();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [paperStatus, setPaperStatus] = useState<Record<number, string>>({});
  const [trackedIdeas, setTrackedIdeas] = useState<Set<number>>(new Set());

  const handleTrack = async (idea: TradeIdea, idx: number, paperQuotes?: Record<string, { bid: number; ask: number; mid: number; last: number }>) => {
    // Use the algorithm's resolved targetExp (matches the recommended DTE)
    const exp = resolveExpiration({
      targetExp: idea.targetExp,
      nearestExp: idea.nearestExp,
      weeklyExp: idea.weeklyExp,
      monthlyExp: idea.monthlyExp,
    });
    // Build the trade first (with pending legs)
    const tracked = buildTrackedTradeFromAlgo({
      symbol: idea.ticker,
      spotPrice: idea.spot,
      trade: {
        strategy: idea.strategy,
        direction: idea.direction,
        confidence: idea.confidence,
        score: idea.score,
        expiration: idea.expiration,
        strikes: idea.strikes,
        entry: idea.entry,
        risk: idea.risk,
        reasoning: idea.reasoning,
        tags: idea.tags,
        profitTargetPct: idea.profitTargetPct,
        stopLossPct: idea.stopLossPct,
      },
      marketSnapshot: {
        ivRank: idea.ivRank,
        currentIV: idea.currentIV,
        hvCurrent: 0,
        totalGEX: 0,
        gammaFlip: idea.gammaFlip,
        callWall: idea.callWall,
        putWall: idea.putWall,
        biasScore: idea.biasScore,
        overallBias: idea.bias,
        volRegime: idea.ivRank > 60 ? 'high' : idea.ivRank < 30 ? 'low' : 'mid',
        gammaRegime: 'neutral',
      },
      source: 'ai-briefing',
      nearestExp: exp,
    });
    // Fill entry prices: prefer paper fill prices (consistency with paper tab),
    // then fall back to production API prices
    if (tracked.status === 'pending') {
      const occSymbols = tracked.legs.map(l => l.optionSymbol).filter(Boolean);
      const quotes = (paperQuotes && Object.keys(paperQuotes).length > 0)
        ? paperQuotes
        : (await fetchEntryPrices(occSymbols, idea.ticker)).quotes;
      if (Object.keys(quotes).length > 0) {
        tracked.legs = fillEntryPrices(tracked.legs, quotes);
        const hasRealPrices = tracked.legs.length > 0 && tracked.legs.every(l => l.entryMid > 0);
        if (hasRealPrices) {
          tracked.entryDebit = calculatePositionValue(tracked.legs, 'entry');
          tracked.status = 'entered';
          tracked.enteredAt = Date.now();
          tracked.priceHistory = [{ timestamp: Date.now(), spotPrice: idea.spot, positionValue: tracked.entryDebit }];
        }
      }
    }
    addTrackedTrade(tracked);
    setTrackedIdeas(prev => new Set(prev).add(idx));
  };

  const handlePaperTrade = async (idea: TradeIdea, idx: number) => {
    setPaperStatus(s => ({ ...s, [idx]: 'placing...' }));
    try {
      // Extract all dollar amounts from the strikes text
      const allStrikes = [...idea.strikes.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
      const stratLow = idea.strategy.toLowerCase();
      const strikesLow = idea.strikes.toLowerCase();

      // Determine strategy type from the strategy name
      const isIronCondor = stratLow.includes('iron condor');
      const isBullPut = stratLow.includes('bull put') || (stratLow.includes('put') && stratLow.includes('credit') && idea.direction === 'bullish');
      const isBearCall = stratLow.includes('bear call') || (stratLow.includes('call') && stratLow.includes('credit') && idea.direction === 'bearish');
      const isBullCall = stratLow.includes('bull call') || stratLow.includes('call debit') || (stratLow.includes('call') && stratLow.includes('debit'));
      const isBearPut = stratLow.includes('bear put') || stratLow.includes('put debit') || (stratLow.includes('put') && stratLow.includes('debit'));
      const isStraddle = stratLow.includes('straddle');
      const isStrangle = stratLow.includes('strangle');

      // Parse strikes based on "sell $X" / "buy $Y" keywords in the strikes text
      const sellStrikes = [...idea.strikes.matchAll(/sell\s+\$(\d+(?:\.\d+)?)/gi)].map(m => parseFloat(m[1]));
      const buyStrikes = [...idea.strikes.matchAll(/buy\s+\$(\d+(?:\.\d+)?)/gi)].map(m => parseFloat(m[1]));

      // Use the algorithm's resolved targetExp (matches the recommended DTE)
      const exp = resolveExpiration({
        targetExp: idea.targetExp,
        nearestExp: idea.nearestExp,
        weeklyExp: idea.weeklyExp,
        monthlyExp: idea.monthlyExp,
      });
      const thesis = `${idea.strategy} — ${idea.reasoning[0] || ''}`;
      let qty = parseQuantity(idea.strikes);

      if (isIronCondor && allStrikes.length >= 2) {
        // Iron condor: sell call + sell put, buy wings
        // strikes text: "Sell $700C / $680P. Wings ~$5 beyond."
        const sellCallMatch = strikesLow.match(/sell\s+\$(\d+(?:\.\d+)?)c/i) || strikesLow.match(/\$(\d+(?:\.\d+)?)c/i);
        const sellPutMatch = strikesLow.match(/sell\s+\$(\d+(?:\.\d+)?)p/i) || strikesLow.match(/\$(\d+(?:\.\d+)?)p/i);
        const wingsMatch = strikesLow.match(/wings?\s+~?\$(\d+(?:\.\d+)?)/i);
        const wingWidth = wingsMatch ? parseFloat(wingsMatch[1]) : 5;

        let sellCall = sellCallMatch ? parseFloat(sellCallMatch[1]) : allStrikes[0];
        let sellPut = sellPutMatch ? parseFloat(sellPutMatch[1]) : allStrikes[1] || allStrikes[0] - 20;
        // Ensure call is above put
        if (sellCall < sellPut) [sellCall, sellPut] = [sellPut, sellCall];
        // Clamp strikes to within 2 ATR of spot
        sellCall = clampStrike(sellCall, idea.spot, 'C');
        sellPut = clampStrike(sellPut, idea.spot, 'P');

        // Auto-size if no explicit qty in text
        if (qty === 1) {
          qty = calcQty(idea.spot, idea.strategy, [
            { strike: sellCall, type: 'C', side: 'short' },
            { strike: sellCall + wingWidth, type: 'C', side: 'long' },
            { strike: sellPut, type: 'P', side: 'short' },
            { strike: sellPut - wingWidth, type: 'P', side: 'long' },
          ]);
        }

        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spread',
            symbol: idea.ticker,
            orderType: 'credit',
            duration: 'gtc',
            legs: [
              { expiration: exp, optionType: 'C', strike: sellCall, side: 'sell_to_open', quantity: qty },
              { expiration: exp, optionType: 'C', strike: sellCall + wingWidth, side: 'buy_to_open', quantity: qty },
              { expiration: exp, optionType: 'P', strike: sellPut, side: 'sell_to_open', quantity: qty },
              { expiration: exp, optionType: 'P', strike: sellPut - wingWidth, side: 'buy_to_open', quantity: qty },
            ],
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `ic-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [
            buildOCC(idea.ticker, exp, 'C', sellCall),
            buildOCC(idea.ticker, exp, 'C', sellCall + wingWidth),
            buildOCC(idea.ticker, exp, 'P', sellPut),
            buildOCC(idea.ticker, exp, 'P', sellPut - wingWidth),
          ],
          underlying: idea.ticker, strategy: idea.strategy, thesis,
          profitTargetPct: idea.profitTargetPct, stopLossPct: idea.stopLossPct,
          autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed IC #${data.orderId} (TP: +${idea.profitTargetPct}% / SL: -${idea.stopLossPct}%)` }));

      } else if ((isBullPut || isBearCall || isBullCall || isBearPut) && (sellStrikes.length > 0 || buyStrikes.length > 0 || allStrikes.length >= 2)) {
        // Vertical spread: 2 legs
        let leg1Strike: number, leg2Strike: number;
        let leg1Side: string, leg2Side: string;
        let optType: 'C' | 'P';
        let orderType: string;

        if (isBullPut) {
          // Bull put spread (credit): sell higher put, buy lower put
          optType = 'P';
          orderType = 'credit';
          leg1Strike = clampStrike(sellStrikes[0] || Math.max(...allStrikes), idea.spot, 'P');
          leg2Strike = clampStrike(buyStrikes[0] || Math.min(...allStrikes), idea.spot, 'P');
          leg1Side = 'sell_to_open';
          leg2Side = 'buy_to_open';
        } else if (isBearCall) {
          // Bear call spread (credit): sell lower call, buy higher call
          optType = 'C';
          orderType = 'credit';
          leg1Strike = clampStrike(sellStrikes[0] || Math.min(...allStrikes), idea.spot, 'C');
          leg2Strike = clampStrike(buyStrikes[0] || Math.max(...allStrikes), idea.spot, 'C');
          leg1Side = 'sell_to_open';
          leg2Side = 'buy_to_open';
        } else if (isBullCall) {
          // Bull call spread (debit): buy lower call, sell higher call
          optType = 'C';
          orderType = 'debit';
          leg1Strike = clampStrike(buyStrikes[0] || Math.min(...allStrikes), idea.spot, 'C');
          leg2Strike = clampStrike(sellStrikes[0] || Math.max(...allStrikes), idea.spot, 'C');
          leg1Side = 'buy_to_open';
          leg2Side = 'sell_to_open';
        } else {
          // Bear put spread (debit): buy higher put, sell lower put
          optType = 'P';
          orderType = 'debit';
          leg1Strike = clampStrike(buyStrikes[0] || Math.max(...allStrikes), idea.spot, 'P');
          leg2Strike = clampStrike(sellStrikes[0] || Math.min(...allStrikes), idea.spot, 'P');
          leg1Side = 'buy_to_open';
          leg2Side = 'sell_to_open';
        }

        // Auto-size if no explicit qty in text
        if (qty === 1) {
          const s1Side = leg1Side.includes('sell') ? 'short' : 'long';
          const s2Side = leg2Side.includes('sell') ? 'short' : 'long';
          qty = calcQty(idea.spot, idea.strategy, [
            { strike: leg1Strike, type: optType, side: s1Side as 'long' | 'short' },
            { strike: leg2Strike, type: optType, side: s2Side as 'long' | 'short' },
          ]);
        }

        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spread',
            symbol: idea.ticker,
            orderType,
            duration: 'gtc',
            legs: [
              { expiration: exp, optionType: optType, strike: leg1Strike, side: leg1Side, quantity: qty },
              { expiration: exp, optionType: optType, strike: leg2Strike, side: leg2Side, quantity: qty },
            ],
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `spread-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, optType, leg1Strike), buildOCC(idea.ticker, exp, optType, leg2Strike)],
          underlying: idea.ticker, strategy: idea.strategy, thesis,
          profitTargetPct: idea.profitTargetPct, stopLossPct: idea.stopLossPct,
          autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed spread #${data.orderId} (TP: +${idea.profitTargetPct}% / SL: -${idea.stopLossPct}%)` }));

      } else if (isStraddle && allStrikes.length >= 1) {
        // Long straddle: buy call + buy put at same strike
        const strike = allStrikes[0];
        if (qty === 1) {
          qty = calcQty(idea.spot, idea.strategy, [
            { strike, type: 'C', side: 'long' }, { strike, type: 'P', side: 'long' },
          ]);
        }
        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spread',
            symbol: idea.ticker,
            orderType: 'debit',
            duration: 'gtc',
            legs: [
              { expiration: exp, optionType: 'C', strike, side: 'buy_to_open', quantity: qty },
              { expiration: exp, optionType: 'P', strike, side: 'buy_to_open', quantity: qty },
            ],
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `straddle-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, 'C', strike), buildOCC(idea.ticker, exp, 'P', strike)],
          underlying: idea.ticker, strategy: idea.strategy, thesis,
          profitTargetPct: idea.profitTargetPct, stopLossPct: idea.stopLossPct,
          autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed straddle #${data.orderId} (TP: +${idea.profitTargetPct}% / SL: -${idea.stopLossPct}%)` }));

      } else if (isStrangle && allStrikes.length >= 2) {
        // Long strangle: buy OTM put + buy OTM call
        const putStrike = Math.min(...allStrikes);
        const callStrike = Math.max(...allStrikes);
        if (qty === 1) {
          qty = calcQty(idea.spot, idea.strategy, [
            { strike: callStrike, type: 'C', side: 'long' }, { strike: putStrike, type: 'P', side: 'long' },
          ]);
        }
        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spread',
            symbol: idea.ticker,
            orderType: 'debit',
            duration: 'gtc',
            legs: [
              { expiration: exp, optionType: 'P', strike: putStrike, side: 'buy_to_open', quantity: qty },
              { expiration: exp, optionType: 'C', strike: callStrike, side: 'buy_to_open', quantity: qty },
            ],
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `strangle-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, 'P', putStrike), buildOCC(idea.ticker, exp, 'C', callStrike)],
          underlying: idea.ticker, strategy: idea.strategy, thesis,
          profitTargetPct: idea.profitTargetPct, stopLossPct: idea.stopLossPct,
          autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed strangle #${data.orderId} (TP: +${idea.profitTargetPct}% / SL: -${idea.stopLossPct}%)` }));

      } else {
        // Fallback: single leg (directional call or put)
        const optionType: 'C' | 'P' = /put|bear/i.test(idea.strategy) || idea.direction === 'bearish' ? 'P' : 'C';
        const strike = clampStrike(allStrikes[0] || Math.round(idea.spot), idea.spot, optionType);
        if (qty === 1) {
          qty = calcQty(idea.spot, idea.strategy, [{ strike, type: optionType, side: 'long' }]);
        }

        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'single',
            symbol: idea.ticker,
            expiration: exp,
            optionType,
            strike,
            side: 'buy_to_open',
            quantity: qty,
            orderType: 'market',
            duration: 'gtc',
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `single-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, optionType, strike)],
          underlying: idea.ticker, strategy: idea.strategy, thesis,
          profitTargetPct: idea.profitTargetPct || 75, stopLossPct: idea.stopLossPct || 50,
          autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed #${data.orderId} (TP: +${idea.profitTargetPct || 75}% / SL: -${idea.stopLossPct || 50}%)` }));
      }
      // Fetch paper account fills so tracker uses the same entry prices
      let paperQuotes: Record<string, { bid: number; ask: number; mid: number; last: number }> = {};
      try {
        await new Promise(r => setTimeout(r, 1500)); // wait for sandbox market fill
        const accRes = await fetch('/api/paper/account', { signal: AbortSignal.timeout(5000) });
        if (accRes.ok) {
          const accData = await accRes.json();
          for (const p of (accData.positions || []) as { symbol: string; costPerContract: number; bid: number; ask: number }[]) {
            const price = Math.abs(p.costPerContract);
            if (price > 0) paperQuotes[p.symbol] = { bid: p.bid || price, ask: p.ask || price, mid: price, last: price };
          }
        }
      } catch { /* fall back to production API prices */ }
      // Auto-track the paper trade so TrackerMonitor monitors it
      if (!trackedIdeas.has(idx)) handleTrack(idea, idx, paperQuotes);
    } catch (err) {
      setPaperStatus(s => ({ ...s, [idx]: `Error: ${err instanceof Error ? err.message : 'Failed'}` }));
    }
  };

  if (ideas.length === 0) return null;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Wallet className="w-4 h-4 text-accent-cyan" />
          Algorithm Trade Ideas ({ideas.length})
        </span>
        <button
          onClick={() => setActiveTab('paper')}
          className="text-xs font-mono text-text-muted hover:text-accent-cyan transition-colors"
        >
          Paper Trades →
        </button>
      </div>
      <div className="divide-y divide-border/10">
        {ideas.map((idea, idx) => {
          const isExp = expanded === idx;
          const status = paperStatus[idx];
          const dirColor = idea.direction === 'bullish' ? 'text-green-400' : idea.direction === 'bearish' ? 'text-red-400' : 'text-text-muted';
          const confBg = idea.confidence === 'high' ? 'bg-accent-cyan/15 text-accent-cyan' :
            idea.confidence === 'medium' ? 'bg-yellow-500/15 text-yellow-400' :
            'bg-bg-tertiary text-text-muted';

          return (
            <div key={idx} className="px-4 py-3">
              <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(isExp ? null : idx)}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono font-semibold text-text-primary">{idea.ticker}</span>
                  <span className={`text-xs font-mono ${dirColor}`}>{idea.direction}</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${confBg}`}>{idea.confidence}</span>
                  <span className="text-xs text-text-muted font-mono truncate hidden sm:inline">{idea.strategy}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-mono text-text-muted">Score: {idea.score}</span>
                  {isExp ? <ChevronUp className="w-3.5 h-3.5 text-text-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-text-muted" />}
                </div>
              </div>

              {isExp && (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                    <div><span className="text-text-muted">Strategy:</span> <span className="text-text-primary">{idea.strategy}</span></div>
                    <div><span className="text-text-muted">Strikes:</span> <span className="text-text-primary">{idea.strikes}</span></div>
                    <div><span className="text-text-muted">Exp:</span> <span className="text-text-primary">{idea.targetExp || idea.nearestExp} ({idea.expiration})</span></div>
                    <div><span className="text-text-muted">Spot:</span> <span className="text-text-primary">${idea.spot.toFixed(2)}</span></div>
                  </div>
                  <div className="text-xs font-mono text-text-muted">
                    <span className="text-text-muted">Entry:</span> {idea.entry}
                  </div>
                  <div className="text-xs font-mono text-text-muted">
                    <span className="text-text-muted">Risk:</span> {idea.risk}
                  </div>
                  <div className="text-xs font-mono text-text-muted">
                    <span className="text-text-muted">Key Levels:</span>{' '}
                    γFlip={idea.gammaFlip ? `$${idea.gammaFlip.toFixed(0)}` : 'N/A'}{' '}
                    CW={idea.callWall ? `$${idea.callWall.toFixed(0)}` : 'N/A'}{' '}
                    PW={idea.putWall ? `$${idea.putWall.toFixed(0)}` : 'N/A'}
                  </div>
                  {idea.reasoning.length > 0 && (
                    <div className="text-xs text-text-muted space-y-0.5">
                      {idea.reasoning.map((r, ri) => (
                        <div key={ri} className="flex items-start gap-1.5">
                          <span className="text-accent-cyan shrink-0">{'>'}</span>
                          <span>{r}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    {status?.startsWith('Placed') ? (
                      <span className="text-xs font-mono text-green-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> {status}
                      </span>
                    ) : status?.startsWith('Error') ? (
                      <span className="text-xs font-mono text-red-400">{status}</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handlePaperTrade(idea, idx); }}
                        disabled={status === 'placing...'}
                        className="px-3 py-1.5 rounded-md text-xs font-mono bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/25 hover:bg-accent-cyan/25 transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Wallet className="w-3.5 h-3.5" />
                        {status === 'placing...' ? 'Placing...' : 'Paper Trade'}
                      </button>
                    )}
                    {trackedIdeas.has(idx) ? (
                      <span className="text-xs font-mono text-accent-green flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Tracked
                      </span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleTrack(idea, idx); }}
                        className="px-3 py-1.5 rounded-md text-xs font-mono bg-accent-purple/15 text-accent-purple border border-accent-purple/25 hover:bg-accent-purple/25 transition-all flex items-center gap-1.5"
                      >
                        <Eye className="w-3.5 h-3.5" /> Track
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AITradeIdeasPanel({ ideas }: { ideas: AITradeIdea[] }) {
  const { setActiveTab } = useDashboardStore();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [paperStatus, setPaperStatus] = useState<Record<number, string>>({});
  const [trackedIdeas, setTrackedIdeas] = useState<Set<number>>(new Set());

  const handleTrack = async (idea: AITradeIdea, idx: number, paperQuotes?: Record<string, { bid: number; ask: number; mid: number; last: number }>) => {
    const dirLow = idea.direction.toLowerCase();
    const direction = dirLow.includes('bull') ? 'bullish' : dirLow.includes('bear') ? 'bearish' : 'neutral';
    const targetMatch = idea.target?.match(/(\d+)\s*%/);
    const stopMatch = idea.stopMaxLoss?.match(/(\d+)\s*%/);
    // Resolve expiration: use AI's stated DTE or fall back to available expirations
    const exp = resolveExpiration({
      expirationText: idea.expiration,
      nearestExp: idea.nearestExp,
      weeklyExp: idea.weeklyExp,
      monthlyExp: idea.monthlyExp,
    });
    const tracked = buildTrackedTradeFromAlgo({
      symbol: idea.ticker,
      spotPrice: idea.spot,
      trade: {
        strategy: idea.strategy,
        direction,
        confidence: 'medium',
        score: 70,
        expiration: idea.expiration,
        strikes: idea.strikes,
        entry: idea.entry,
        risk: idea.stopMaxLoss || 'See trade details',
        reasoning: [idea.thesis, idea.invalidation ? `Invalidation: ${idea.invalidation}` : ''].filter(Boolean),
        tags: ['ai-generated'],
        profitTargetPct: targetMatch ? parseInt(targetMatch[1]) : 50,
        stopLossPct: stopMatch ? parseInt(stopMatch[1]) : 100,
      },
      marketSnapshot: {
        ivRank: idea.ivRank,
        currentIV: 0,
        hvCurrent: 0,
        totalGEX: 0,
        gammaFlip: idea.gammaFlip,
        callWall: idea.callWall,
        putWall: idea.putWall,
        biasScore: idea.biasScore,
        overallBias: idea.bias,
        volRegime: idea.ivRank > 60 ? 'high' : idea.ivRank < 30 ? 'low' : 'mid',
        gammaRegime: 'neutral',
      },
      source: 'ai-analysis',
      nearestExp: exp,
    });
    // Fill entry prices: prefer paper fill prices (consistency with paper tab),
    // then fall back to production API prices
    if (tracked.status === 'pending') {
      const occSymbols = tracked.legs.map(l => l.optionSymbol).filter(Boolean);
      const quotes = (paperQuotes && Object.keys(paperQuotes).length > 0)
        ? paperQuotes
        : (await fetchEntryPrices(occSymbols, idea.ticker)).quotes;
      if (Object.keys(quotes).length > 0) {
        tracked.legs = fillEntryPrices(tracked.legs, quotes);
        const hasRealPrices = tracked.legs.length > 0 && tracked.legs.every(l => l.entryMid > 0);
        if (hasRealPrices) {
          tracked.entryDebit = calculatePositionValue(tracked.legs, 'entry');
          tracked.status = 'entered';
          tracked.enteredAt = Date.now();
          tracked.priceHistory = [{ timestamp: Date.now(), spotPrice: idea.spot, positionValue: tracked.entryDebit }];
        }
      }
    }
    addTrackedTrade(tracked);
    setTrackedIdeas(prev => new Set(prev).add(idx));
  };

  const handlePaperTrade = async (idea: AITradeIdea, idx: number) => {
    setPaperStatus(s => ({ ...s, [idx]: 'placing...' }));
    try {
      // Extract dollar amounts from strikes
      const allStrikes = [...idea.strikes.matchAll(/\$?(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
      const stratLow = idea.strategy.toLowerCase();
      const strikesLow = idea.strikes.toLowerCase();

      // Parse strategy type
      const isIronCondor = stratLow.includes('iron condor');
      const isBullPut = stratLow.includes('bull put') || (stratLow.includes('put') && stratLow.includes('credit') && idea.direction.toLowerCase().includes('bull'));
      const isBearCall = stratLow.includes('bear call') || (stratLow.includes('call') && stratLow.includes('credit') && idea.direction.toLowerCase().includes('bear'));
      const isBullCall = stratLow.includes('bull call') || stratLow.includes('call debit') || (stratLow.includes('call') && stratLow.includes('spread') && idea.direction.toLowerCase().includes('bull'));
      const isBearPut = stratLow.includes('bear put') || stratLow.includes('put debit') || (stratLow.includes('put') && stratLow.includes('spread') && idea.direction.toLowerCase().includes('bear'));
      const isStraddle = stratLow.includes('straddle');
      const isStrangle = stratLow.includes('strangle');

      const sellStrikes = [...idea.strikes.matchAll(/sell\s+\$?(\d+(?:\.\d+)?)/gi)].map(m => parseFloat(m[1]));
      const buyStrikes = [...idea.strikes.matchAll(/buy\s+\$?(\d+(?:\.\d+)?)/gi)].map(m => parseFloat(m[1]));

      // Also check strategy field for buy/sell
      const stratSell = [...idea.strategy.matchAll(/sell\s+\$?(\d+)/gi)].map(m => parseFloat(m[1]));
      const stratBuy = [...idea.strategy.matchAll(/buy\s+\$?(\d+)/gi)].map(m => parseFloat(m[1]));
      for (const s of stratSell) if (!sellStrikes.includes(s)) sellStrikes.push(s);
      for (const b of stratBuy) if (!buyStrikes.includes(b)) buyStrikes.push(b);

      // Resolve expiration: use AI's stated DTE or fall back to available expirations
      const exp = resolveExpiration({
        expirationText: idea.expiration,
        nearestExp: idea.nearestExp,
        weeklyExp: idea.weeklyExp,
        monthlyExp: idea.monthlyExp,
      });
      const thesis = `[AI] ${idea.title} — ${idea.thesis || idea.strategy}`;
      let qty = parseQuantity(idea.strikes);

      if (isIronCondor && allStrikes.length >= 2) {
        const sellCallMatch = strikesLow.match(/(\d+)\s*c/i) || strikesLow.match(/sell\s+\$?(\d+)/i);
        const sellPutMatch = strikesLow.match(/(\d+)\s*p/i);
        let sellCall = sellCallMatch ? parseFloat(sellCallMatch[1]) : Math.max(...allStrikes);
        let sellPut = sellPutMatch ? parseFloat(sellPutMatch[1]) : Math.min(...allStrikes);
        if (sellCall < sellPut) [sellCall, sellPut] = [sellPut, sellCall];
        // Clamp strikes to within 2 ATR of spot
        sellCall = clampStrike(sellCall, idea.spot, 'C');
        sellPut = clampStrike(sellPut, idea.spot, 'P');
        const wingWidth = 5;

        // Auto-size: target 1-5% of portfolio
        if (qty === 1) {
          qty = calcQty(idea.spot, idea.strategy, [
            { strike: sellCall, type: 'C', side: 'short' },
            { strike: sellCall + wingWidth, type: 'C', side: 'long' },
            { strike: sellPut, type: 'P', side: 'short' },
            { strike: sellPut - wingWidth, type: 'P', side: 'long' },
          ]);
        }

        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spread', symbol: idea.ticker, orderType: 'credit', duration: 'gtc',
            legs: [
              { expiration: exp, optionType: 'C', strike: sellCall, side: 'sell_to_open', quantity: qty },
              { expiration: exp, optionType: 'C', strike: sellCall + wingWidth, side: 'buy_to_open', quantity: qty },
              { expiration: exp, optionType: 'P', strike: sellPut, side: 'sell_to_open', quantity: qty },
              { expiration: exp, optionType: 'P', strike: sellPut - wingWidth, side: 'buy_to_open', quantity: qty },
            ],
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `ai-ic-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, 'C', sellCall), buildOCC(idea.ticker, exp, 'C', sellCall + wingWidth), buildOCC(idea.ticker, exp, 'P', sellPut), buildOCC(idea.ticker, exp, 'P', sellPut - wingWidth)],
          underlying: idea.ticker, strategy: `[AI] ${idea.strategy}`, thesis,
          profitTargetPct: 50, stopLossPct: 100, autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed IC ${qty}x #${data.orderId}` }));

      } else if ((isBullPut || isBearCall || isBullCall || isBearPut) && allStrikes.length >= 2) {
        let leg1Strike: number, leg2Strike: number;
        let leg1Side: string, leg2Side: string;
        let optType: 'C' | 'P';
        let orderType: string;

        if (isBullPut) {
          optType = 'P'; orderType = 'credit';
          leg1Strike = clampStrike(sellStrikes[0] || Math.max(...allStrikes), idea.spot, 'P');
          leg2Strike = clampStrike(buyStrikes[0] || Math.min(...allStrikes), idea.spot, 'P');
          leg1Side = 'sell_to_open'; leg2Side = 'buy_to_open';
        } else if (isBearCall) {
          optType = 'C'; orderType = 'credit';
          leg1Strike = clampStrike(sellStrikes[0] || Math.min(...allStrikes), idea.spot, 'C');
          leg2Strike = clampStrike(buyStrikes[0] || Math.max(...allStrikes), idea.spot, 'C');
          leg1Side = 'sell_to_open'; leg2Side = 'buy_to_open';
        } else if (isBullCall) {
          optType = 'C'; orderType = 'debit';
          leg1Strike = clampStrike(buyStrikes[0] || Math.min(...allStrikes), idea.spot, 'C');
          leg2Strike = clampStrike(sellStrikes[0] || Math.max(...allStrikes), idea.spot, 'C');
          leg1Side = 'buy_to_open'; leg2Side = 'sell_to_open';
        } else {
          optType = 'P'; orderType = 'debit';
          leg1Strike = clampStrike(buyStrikes[0] || Math.max(...allStrikes), idea.spot, 'P');
          leg2Strike = clampStrike(sellStrikes[0] || Math.min(...allStrikes), idea.spot, 'P');
          leg1Side = 'buy_to_open'; leg2Side = 'sell_to_open';
        }

        // Auto-size: target 1-5% of portfolio
        if (qty === 1) {
          const s1Side = leg1Side.includes('sell') ? 'short' : 'long';
          const s2Side = leg2Side.includes('sell') ? 'short' : 'long';
          qty = calcQty(idea.spot, idea.strategy, [
            { strike: leg1Strike, type: optType, side: s1Side as 'long' | 'short' },
            { strike: leg2Strike, type: optType, side: s2Side as 'long' | 'short' },
          ]);
        }

        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spread', symbol: idea.ticker, orderType, duration: 'gtc',
            legs: [
              { expiration: exp, optionType: optType, strike: leg1Strike, side: leg1Side, quantity: qty },
              { expiration: exp, optionType: optType, strike: leg2Strike, side: leg2Side, quantity: qty },
            ],
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `ai-spread-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, optType, leg1Strike), buildOCC(idea.ticker, exp, optType, leg2Strike)],
          underlying: idea.ticker, strategy: `[AI] ${idea.strategy}`, thesis,
          profitTargetPct: 50, stopLossPct: 50, autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed spread #${data.orderId}` }));

      } else if ((isStraddle || isStrangle) && allStrikes.length >= 1) {
        const strike1 = allStrikes[0];
        const strike2 = isStrangle && allStrikes.length >= 2 ? allStrikes[1] : strike1;
        const putStrike = Math.min(strike1, strike2);
        const callStrike = Math.max(strike1, strike2);
        // Auto-size
        if (qty === 1) {
          qty = calcQty(idea.spot, idea.strategy, [
            { strike: callStrike, type: 'C', side: 'long' },
            { strike: putStrike, type: 'P', side: 'long' },
          ]);
        }
        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'spread', symbol: idea.ticker, orderType: 'debit', duration: 'gtc',
            legs: [
              { expiration: exp, optionType: 'C', strike: callStrike, side: 'buy_to_open', quantity: qty },
              { expiration: exp, optionType: 'P', strike: putStrike, side: 'buy_to_open', quantity: qty },
            ],
            thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `ai-vol-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, 'C', callStrike), buildOCC(idea.ticker, exp, 'P', putStrike)],
          underlying: idea.ticker, strategy: `[AI] ${idea.strategy}`, thesis,
          profitTargetPct: 50, stopLossPct: 40, autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed ${isStraddle ? 'straddle' : 'strangle'} ${qty}x #${data.orderId}` }));

      } else {
        // Fallback: single leg
        const optionType: 'C' | 'P' = /put|bear/i.test(idea.strategy) || idea.direction.toLowerCase().includes('bear') ? 'P' : 'C';
        const strike = clampStrike(allStrikes[0] || Math.round(idea.spot), idea.spot, optionType);
        // Auto-size
        if (qty === 1) {
          qty = calcQty(idea.spot, idea.strategy, [
            { strike, type: optionType, side: 'long' },
          ]);
        }
        const res = await fetch('/api/paper/trade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'single', symbol: idea.ticker, expiration: exp, optionType,
            strike, side: 'buy_to_open', quantity: qty, orderType: 'market', duration: 'gtc', thesis,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        saveGroupRule({
          id: `ai-single-${idea.ticker}-${exp}-${Date.now()}`,
          occSymbols: [buildOCC(idea.ticker, exp, optionType, strike)],
          underlying: idea.ticker, strategy: `[AI] ${idea.strategy}`, thesis,
          profitTargetPct: 75, stopLossPct: 50, autoExit: true, isAITracked: true, createdAt: new Date().toISOString(),
        });
        setPaperStatus(s => ({ ...s, [idx]: `Placed #${data.orderId}` }));
      }
      // Fetch paper account fills so tracker uses the same entry prices
      let paperQuotes: Record<string, { bid: number; ask: number; mid: number; last: number }> = {};
      try {
        await new Promise(r => setTimeout(r, 1500)); // wait for sandbox market fill
        const accRes = await fetch('/api/paper/account', { signal: AbortSignal.timeout(5000) });
        if (accRes.ok) {
          const accData = await accRes.json();
          for (const p of (accData.positions || []) as { symbol: string; costPerContract: number; bid: number; ask: number }[]) {
            const price = Math.abs(p.costPerContract);
            if (price > 0) paperQuotes[p.symbol] = { bid: p.bid || price, ask: p.ask || price, mid: price, last: price };
          }
        }
      } catch { /* fall back to production API prices */ }
      // Auto-track the paper trade so TrackerMonitor monitors it
      if (!trackedIdeas.has(idx)) handleTrack(idea, idx, paperQuotes);
    } catch (err) {
      setPaperStatus(s => ({ ...s, [idx]: `Error: ${err instanceof Error ? err.message : 'Failed'}` }));
    }
  };

  if (ideas.length === 0) return null;

  return (
    <div className="panel border border-accent-purple/20">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent-purple" />
          AI Trade Picks ({ideas.length})
        </span>
        <button
          onClick={() => setActiveTab('paper')}
          className="text-xs font-mono text-text-muted hover:text-accent-purple transition-colors"
        >
          Paper Trades →
        </button>
      </div>
      <div className="divide-y divide-border/10">
        {ideas.map((idea, idx) => {
          const isExp = expanded === idx;
          const status = paperStatus[idx];
          const dirLow = idea.direction.toLowerCase();
          const dirColor = dirLow.includes('bull') ? 'text-green-400' : dirLow.includes('bear') ? 'text-red-400' : 'text-text-muted';

          return (
            <div key={idx} className="px-4 py-3">
              <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(isExp ? null : idx)}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-purple/15 text-accent-purple">AI</span>
                  <span className="font-mono font-semibold text-text-primary">{idea.ticker}</span>
                  <span className={`text-xs font-mono ${dirColor}`}>{idea.direction}</span>
                  <span className="text-xs text-text-muted font-mono truncate hidden sm:inline">{idea.title}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs font-mono text-text-muted">${idea.spot > 0 ? idea.spot.toFixed(2) : '—'}</span>
                  {isExp ? <ChevronUp className="w-3.5 h-3.5 text-text-muted" /> : <ChevronDown className="w-3.5 h-3.5 text-text-muted" />}
                </div>
              </div>

              {isExp && (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
                    <div><span className="text-text-muted">Strategy:</span> <span className="text-text-primary">{idea.strategy}</span></div>
                    <div><span className="text-text-muted">Strikes:</span> <span className="text-text-primary">{idea.strikes}</span></div>
                    <div><span className="text-text-muted">Exp:</span> <span className="text-text-primary">{idea.expiration}</span></div>
                    <div><span className="text-text-muted">Spot:</span> <span className="text-text-primary">${idea.spot > 0 ? idea.spot.toFixed(2) : '—'}</span></div>
                  </div>
                  {idea.entry && <div className="text-xs font-mono text-text-muted"><span className="text-text-muted">Entry:</span> {idea.entry}</div>}
                  {idea.target && <div className="text-xs font-mono text-text-muted"><span className="text-text-muted">Target:</span> {idea.target}</div>}
                  {idea.stopMaxLoss && <div className="text-xs font-mono text-text-muted"><span className="text-text-muted">Stop:</span> {idea.stopMaxLoss}</div>}
                  {idea.thesis && (
                    <div className="text-xs text-text-muted space-y-0.5">
                      <div className="flex items-start gap-1.5">
                        <span className="text-accent-purple shrink-0">{'>'}</span>
                        <span>{idea.thesis}</span>
                      </div>
                    </div>
                  )}
                  {idea.invalidation && (
                    <div className="text-xs text-red-400/70"><span className="text-text-muted">Invalidation:</span> {idea.invalidation}</div>
                  )}
                  <div className="text-xs font-mono text-text-muted/50">
                    Levels: γFlip={idea.gammaFlip ? `$${idea.gammaFlip.toFixed(0)}` : 'N/A'}{' '}
                    CW={idea.callWall ? `$${idea.callWall.toFixed(0)}` : 'N/A'}{' '}
                    PW={idea.putWall ? `$${idea.putWall.toFixed(0)}` : 'N/A'}
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    {status?.startsWith('Placed') ? (
                      <span className="text-xs font-mono text-green-400 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> {status}
                      </span>
                    ) : status?.startsWith('Error') ? (
                      <span className="text-xs font-mono text-red-400">{status}</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handlePaperTrade(idea, idx); }}
                        disabled={status === 'placing...'}
                        className="px-3 py-1.5 rounded-md text-xs font-mono bg-accent-purple/15 text-accent-purple border border-accent-purple/25 hover:bg-accent-purple/25 transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Wallet className="w-3.5 h-3.5" />
                        {status === 'placing...' ? 'Placing...' : 'Paper Trade'}
                      </button>
                    )}
                    {trackedIdeas.has(idx) ? (
                      <span className="text-xs font-mono text-accent-green flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Tracked
                      </span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleTrack(idea, idx); }}
                        className="px-3 py-1.5 rounded-md text-xs font-mono bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/25 hover:bg-accent-cyan/25 transition-all flex items-center gap-1.5"
                      >
                        <Eye className="w-3.5 h-3.5" /> Track
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BriefingTab() {
  const { briefingCache, setBriefingCache } = useDashboardStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState('');
  const [trackedSignals, setTrackedSignals] = useState<Set<string>>(() => {
    const existing = loadSignals();
    return new Set(existing.map(s => s.symbol));
  });

  const handleTrackSignal = useCallback(async (idx: { symbol: string; price: number; bias: string; biasScore: number; gammaRegime: string; volRegime: string; ivRank: number }) => {
    // Entry price MUST be current — never use stale briefing cache
    let entryPrice = 0;
    try {
      const res = await fetch(`/api/market/quote?symbol=${idx.symbol}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const q = await res.json();
        if (q.last > 0) entryPrice = q.last;
      }
    } catch { /* will check below */ }

    if (entryPrice <= 0) {
      console.warn(`Signal Tracker: could not get fresh price for ${idx.symbol}, skipping`);
      return;
    }

    addSignal({
      symbol: idx.symbol,
      entryPrice,
      bias: idx.bias as 'bullish' | 'bearish' | 'neutral',
      biasScore: idx.biasScore,
      gammaRegime: idx.gammaRegime,
      volRegime: idx.volRegime,
      ivRank: idx.ivRank,
      topSignal: '',
      gammaFlip: null,
      callWall: null,
      putWall: null,
      source: 'briefing',
    });
    setTrackedSignals(prev => new Set(prev).add(idx.symbol));
  }, []);

  const data = briefingCache as BriefingResponse | null;

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPhase('Scanning 21 stocks across indices, sectors, and Mag7...');

    try {
      const phaseTimer = setTimeout(() => setPhase('Analyzing GEX, IV, flow data for each stock...'), 8000);
      const phaseTimer2 = setTimeout(() => setPhase('Sending to Claude for narrative synthesis...'), 25000);
      const phaseTimer3 = setTimeout(() => setPhase('Claude is writing the briefing...'), 40000);

      const res = await fetch('/api/ai/briefing', {
        method: 'POST',
        signal: AbortSignal.timeout(120000),
      });

      clearTimeout(phaseTimer);
      clearTimeout(phaseTimer2);
      clearTimeout(phaseTimer3);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(text); msg = j.error || msg; } catch { if (text.length < 200) msg = text || msg; }
        throw new Error(msg);
      }

      const json = await res.json();
      setBriefingCache(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate briefing');
    } finally {
      setLoading(false);
      setPhase('');
    }
  }, [setBriefingCache]);

  // Empty state
  if (!data && !loading && !error) {
    return (
      <div className="panel">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Newspaper className="w-12 h-12 text-text-muted/30 mb-4" />
          <h3 className="text-lg font-semibold text-text-secondary mb-2">AI Daily Briefing</h3>
          <p className="text-sm text-text-muted max-w-lg mb-1">
            Runs full GEX/IV/flow analysis on 3 indices, 11 sector ETFs, and the Mag7 —
            then feeds ALL the data to Claude for intelligent cross-market synthesis.
          </p>
          <p className="text-xs text-text-muted/60 mb-6 max-w-lg">
            Identifies sector rotations, gamma regime divergences, IV mispricing,
            unusual positioning, and actionable trade setups.
          </p>
          <button
            onClick={fetchBriefing}
            className="px-6 py-2.5 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all font-medium flex items-center gap-2"
          >
            <Newspaper className="w-5 h-5" />
            Generate AI Briefing
          </button>
          <p className="text-xs text-text-muted/40 mt-3 font-mono">
            Takes ~30-60 seconds (scans 21 stocks + Claude analysis)
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
            <span className="panel-title">AI Daily Briefing</span>
            {data && (
              <span className="text-xs text-text-muted font-mono">
                {data.stocksScanned} stocks &bull; {new Date(data.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
          <button
            onClick={fetchBriefing}
            disabled={loading}
            className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-cyan/30 hover:text-accent-cyan transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Newspaper className="w-3.5 h-3.5" />}
            {loading ? 'Generating...' : 'Regenerate'}
          </button>
        </div>
      </div>

      {error && (
        <div className="panel border border-red-500/30 p-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {loading && (
        <div className="panel p-8">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-accent-cyan" />
            <div className="text-center">
              <p className="text-sm text-text-secondary font-mono">{phase}</p>
              <p className="text-xs text-text-muted/60 mt-1 font-mono">This can take 30-60 seconds</p>
            </div>
            <div className="w-64 h-1 bg-bg-tertiary rounded-full overflow-hidden">
              <div className="h-full bg-accent-cyan/50 rounded-full animate-pulse" style={{ width: '60%' }} />
            </div>
          </div>
        </div>
      )}

      {data && (
        <>
          {data.indices.length > 0 && (
            <div className="panel overflow-hidden">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border/20">
                {data.indices.map(idx => (
                  <div key={idx.symbol} className="bg-bg-secondary px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-text-muted">{idx.symbol}</span>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                          idx.bias === 'bullish' ? 'bg-green-500/15 text-green-400' :
                          idx.bias === 'bearish' ? 'bg-red-500/15 text-red-400' :
                          'bg-bg-tertiary text-text-muted'
                        }`}>
                          {idx.biasScore > 0 ? '+' : ''}{idx.biasScore}
                        </span>
                        {trackedSignals.has(idx.symbol) ? (
                          <Crosshair className="w-3 h-3 text-accent-cyan" />
                        ) : (
                          <button
                            onClick={() => handleTrackSignal(idx)}
                            title={`Track ${idx.symbol} signal`}
                            className="p-0.5 rounded hover:bg-accent-cyan/15 text-text-muted/40 hover:text-accent-cyan transition-colors"
                          >
                            <Crosshair className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="text-sm font-mono font-semibold text-text-primary">${idx.price.toFixed(2)}</div>
                    <div className="flex items-center justify-between mt-0.5">
                      <ChangeChip pct={idx.changePct} />
                      <span className="text-[10px] font-mono text-text-muted">
                        {idx.gammaRegime}γ IV{idx.ivRank}
                      </span>
                    </div>
                  </div>
                ))}
                {data.vix > 0 && (
                  <div className="bg-bg-secondary px-4 py-3">
                    <div className="text-xs font-mono text-text-muted mb-1">VIX</div>
                    <div className={`text-sm font-mono font-semibold ${data.vix > 25 ? 'text-red-400' : data.vix < 15 ? 'text-green-400' : 'text-text-primary'}`}>
                      {data.vix.toFixed(2)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="panel">
            <div className="px-5 py-4">
              <RenderMarkdown text={data.analysis} />
            </div>
          </div>

          {data.aiTradeIdeas && data.aiTradeIdeas.length > 0 && (
            <AITradeIdeasPanel ideas={data.aiTradeIdeas} />
          )}

          {data.tradeIdeas && data.tradeIdeas.length > 0 && (
            <TradeIdeasPanel ideas={data.tradeIdeas} />
          )}

          <div className="text-center text-[10px] text-text-muted/40 font-mono py-2">
            Generated by Claude Sonnet &bull; {data.stocksScanned} securities analyzed &bull;
            GEX/IV/Flow computed locally from Tradier + Polygon data
          </div>
        </>
      )}
    </div>
  );
}
