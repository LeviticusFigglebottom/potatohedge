/**
 * AI Recommendation Trade Tracker
 *
 * Tracks AI-generated trade recommendations (from both the algorithm recommendation engine
 * and the AI briefing) to evaluate their performance over time.
 *
 * Each tracked trade records:
 * - The original recommendation details (strategy, strikes, direction, entry/exit criteria)
 * - Snapshot of market conditions at tracking time (spot price, IV, greeks, etc.)
 * - Live status: pending → entered → exited (with timestamps)
 * - Option prices at entry and exit for P/L calculation
 * - Outcome: win/loss/expired based on profit target / stop loss / expiration
 *
 * Storage: localStorage (immediate) + server sync via /api/history (persistent)
 */

// ─── Types ──────────────────────────────────────────────────

export type TradeStatus = 'pending' | 'entered' | 'exited' | 'expired';
export type TradeOutcome = 'win' | 'loss' | 'breakeven' | null;
export type TradeSource = 'algorithm' | 'ai-briefing' | 'ai-analysis';

export interface TrackedLeg {
  optionSymbol: string;       // OCC symbol
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;         // YYYY-MM-DD
  side: 'long' | 'short';    // from trader perspective
  quantity: number;
  // Prices at tracking time (mid quote estimates)
  entryBid: number;
  entryAsk: number;
  entryMid: number;
  // Prices at exit (filled when trade exits)
  exitBid: number | null;
  exitAsk: number | null;
  exitMid: number | null;
  // Greeks at entry
  entryDelta: number;
  entryGamma: number;
  entryTheta: number;
  entryVega: number;
  entryIV: number;
}

export interface TrackedTrade {
  id: string;
  // Source info
  source: TradeSource;
  // Underlying
  symbol: string;
  spotAtEntry: number;
  spotAtExit: number | null;
  // Strategy
  strategy: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: string;
  score: number;
  // Trade details
  legs: TrackedLeg[];
  // Entry/exit criteria from the recommendation
  entryCondition: string;
  profitTargetPct: number;
  stopLossPct: number;
  riskDescription: string;
  reasoning: string[];
  tags: string[];
  // Market conditions at tracking time
  marketSnapshot: {
    ivRank: number;
    currentIV: number;
    hvCurrent: number;
    totalGEX: number;
    gammaFlip: number | null;
    callWall: number | null;
    putWall: number | null;
    biasScore: number;
    overallBias: string;
    volRegime: string;
    gammaRegime: string;
  };
  // Timing
  trackedAt: number;          // epoch ms — when user clicked "Track"
  enteredAt: number | null;   // epoch ms — when entry condition met / immediately
  exitedAt: number | null;    // epoch ms — when exit condition triggered
  expirationDate: string;     // YYYY-MM-DD — latest leg expiration
  // Status
  status: TradeStatus;
  outcome: TradeOutcome;
  // P&L
  entryDebit: number | null;  // net debit paid (positive) or credit received (negative) per spread
  exitValue: number | null;   // net value at exit
  realizedPL: number | null;  // exitValue - entryDebit (for debits) or entryCredit - exitValue (for credits)
  realizedPLPct: number | null; // as % of max risk
  maxRisk: number | null;     // max possible loss for the position
  // Price snapshots over time for charting
  priceHistory: { timestamp: number; spotPrice: number; positionValue: number }[];
  // Notes
  exitReason: string | null;  // 'profit-target' | 'stop-loss' | 'expiration' | 'manual'
  notes: string;
}

// ─── Aggregate Analytics ────────────────────────────────────

export interface TradeAnalytics {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;            // wins / (wins + losses) as 0-1
  avgWinPct: number;          // average winning trade return %
  avgLossPct: number;         // average losing trade return %
  profitFactor: number;       // gross wins / gross losses
  totalPL: number;            // sum of all realized P/L
  avgPL: number;              // average P/L per closed trade
  avgHoldingDays: number;     // average time in trade
  bestTrade: { id: string; symbol: string; strategy: string; plPct: number } | null;
  worstTrade: { id: string; symbol: string; strategy: string; plPct: number } | null;
  bySource: Record<TradeSource, { count: number; wins: number; winRate: number; avgPL: number }>;
  byStrategy: Record<string, { count: number; wins: number; winRate: number; avgPL: number }>;
  byDirection: Record<string, { count: number; wins: number; winRate: number; avgPL: number }>;
}

// ─── Storage ────────────────────────────────────────────────

const STORAGE_KEY = 'optix_tracked_trades';

export function loadTrackedTrades(): TrackedTrade[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTrackedTrades(trades: TrackedTrade[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  } catch {
    // localStorage full — silently fail
  }
  // Fire-and-forget server sync
  syncTrackedTradesToServer(trades).catch(() => {});
}

async function syncTrackedTradesToServer(trades: TrackedTrade[]): Promise<void> {
  // Wrap each trade as a history record with date + timestamp for persistence layer compat
  const records = trades.map(t => ({
    ...t,
    date: new Date(t.trackedAt).toISOString().slice(0, 10),
    timestamp: t.trackedAt,
  }));
  await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'tracked-trades',
      ticker: '_ALL',
      records,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export async function loadTrackedTradesWithSync(): Promise<TrackedTrade[]> {
  const local = loadTrackedTrades();
  try {
    const res = await fetch('/api/history?type=tracked-trades&ticker=_ALL&days=365', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return local;
    const { records: server } = await res.json() as { records: TrackedTrade[] };
    if (!server || !Array.isArray(server) || server.length === 0) {
      // Push local to server if we have data
      if (local.length > 0) syncTrackedTradesToServer(local).catch(() => {});
      return local;
    }
    // Merge by ID, prefer newer timestamp
    const byId = new Map<string, TrackedTrade>();
    for (const t of server) byId.set(t.id, t);
    for (const t of local) {
      const existing = byId.get(t.id);
      if (!existing || t.trackedAt >= existing.trackedAt) {
        byId.set(t.id, t);
      }
    }
    const merged = Array.from(byId.values());
    merged.sort((a, b) => b.trackedAt - a.trackedAt);
    // Update localStorage
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch {}
    return merged;
  } catch {
    return local;
  }
}

// ─── CRUD Operations ────────────────────────────────────────

export function addTrackedTrade(trade: TrackedTrade): TrackedTrade[] {
  const trades = loadTrackedTrades();
  // Don't add duplicates
  if (trades.some(t => t.id === trade.id)) return trades;
  trades.unshift(trade);
  saveTrackedTrades(trades);
  return trades;
}

export function updateTrackedTrade(id: string, updates: Partial<TrackedTrade>): TrackedTrade[] {
  const trades = loadTrackedTrades();
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) return trades;
  trades[idx] = { ...trades[idx], ...updates };
  saveTrackedTrades(trades);
  return trades;
}

export function removeTrackedTrade(id: string): TrackedTrade[] {
  const trades = loadTrackedTrades().filter(t => t.id !== id);
  saveTrackedTrades(trades);
  return trades;
}

// ─── Trade Evaluation ───────────────────────────────────────

/**
 * Calculate the estimated position value from option mid prices.
 * For debit spreads: sum of (long leg mid - short leg mid) * quantity
 * For credit spreads: sum of (short leg mid - long leg mid) * quantity
 */
export function calculatePositionValue(legs: TrackedLeg[], useMid: 'entry' | 'exit' = 'entry'): number {
  let value = 0;
  for (const leg of legs) {
    const mid = useMid === 'entry' ? leg.entryMid : (leg.exitMid ?? leg.entryMid);
    const multiplier = leg.side === 'long' ? 1 : -1;
    value += mid * multiplier * leg.quantity * 100; // options are 100 shares per contract
  }
  return value;
}

/**
 * Check a tracked trade against current market data and update its status.
 * Returns the updated trade if any changes were made, null otherwise.
 */
export function evaluateTrade(
  trade: TrackedTrade,
  currentSpot: number,
  currentLegPrices: { symbol: string; bid: number; ask: number; mid: number }[]
): TrackedTrade | null {
  // Skip already closed trades
  if (trade.status === 'exited' || trade.status === 'expired') return null;

  const now = Date.now();
  const updates: Partial<TrackedTrade> = {};

  // Check expiration first
  const expDate = new Date(trade.expirationDate + 'T16:00:00-05:00').getTime(); // 4PM ET
  if (now >= expDate) {
    // Calculate final value
    const exitLegs = trade.legs.map(leg => {
      const price = currentLegPrices.find(p => p.symbol === leg.optionSymbol);
      return { ...leg, exitBid: price?.bid ?? 0, exitAsk: price?.ask ?? 0, exitMid: price?.mid ?? 0 };
    });
    const exitValue = calculatePositionValue(exitLegs, 'exit');
    const entryValue = trade.entryDebit ?? calculatePositionValue(trade.legs, 'entry');
    const pl = exitValue - entryValue;
    const plPct = trade.maxRisk && trade.maxRisk !== 0 ? (pl / Math.abs(trade.maxRisk)) * 100 : 0;

    updates.status = 'expired';
    updates.exitedAt = now;
    updates.spotAtExit = currentSpot;
    updates.legs = exitLegs;
    updates.exitValue = exitValue;
    updates.realizedPL = pl;
    updates.realizedPLPct = plPct;
    updates.exitReason = 'expiration';
    updates.outcome = pl > 0.5 ? 'win' : pl < -0.5 ? 'loss' : 'breakeven';

    const trades = updateTrackedTrade(trade.id, updates);
    return trades.find(t => t.id === trade.id) ?? null;
  }

  // If pending, auto-enter immediately (we track at market)
  if (trade.status === 'pending') {
    updates.status = 'entered';
    updates.enteredAt = now;
  }

  // Calculate current position value for entered trades
  if (trade.status === 'entered' || updates.status === 'entered') {
    const currentLegs = trade.legs.map(leg => {
      const price = currentLegPrices.find(p => p.symbol === leg.optionSymbol);
      return { ...leg, exitBid: price?.bid ?? 0, exitAsk: price?.ask ?? 0, exitMid: price?.mid ?? 0 };
    });
    const currentValue = calculatePositionValue(currentLegs, 'exit');
    const entryValue = trade.entryDebit ?? calculatePositionValue(trade.legs, 'entry');
    const unrealizedPL = currentValue - entryValue;
    const plPct = trade.maxRisk && trade.maxRisk !== 0 ? (unrealizedPL / Math.abs(trade.maxRisk)) * 100 : 0;

    // Add price snapshot
    const snapshot = { timestamp: now, spotPrice: currentSpot, positionValue: currentValue };
    updates.priceHistory = [...(trade.priceHistory || []), snapshot].slice(-100); // keep last 100 points

    // Check profit target
    if (plPct >= trade.profitTargetPct) {
      updates.status = 'exited';
      updates.exitedAt = now;
      updates.spotAtExit = currentSpot;
      updates.legs = currentLegs;
      updates.exitValue = currentValue;
      updates.realizedPL = unrealizedPL;
      updates.realizedPLPct = plPct;
      updates.exitReason = 'profit-target';
      updates.outcome = 'win';
    }
    // Check stop loss
    else if (plPct <= -trade.stopLossPct) {
      updates.status = 'exited';
      updates.exitedAt = now;
      updates.spotAtExit = currentSpot;
      updates.legs = currentLegs;
      updates.exitValue = currentValue;
      updates.realizedPL = unrealizedPL;
      updates.realizedPLPct = plPct;
      updates.exitReason = 'stop-loss';
      updates.outcome = 'loss';
    }
  }

  if (Object.keys(updates).length === 0) return null;

  const trades = updateTrackedTrade(trade.id, updates);
  return trades.find(t => t.id === trade.id) ?? null;
}

/**
 * Manually close a tracked trade.
 */
export function manuallyExitTrade(
  tradeId: string,
  currentSpot: number,
  currentLegPrices: { symbol: string; bid: number; ask: number; mid: number }[],
  trade: TrackedTrade
): TrackedTrade[] {
  const now = Date.now();
  const exitLegs = trade.legs.map(leg => {
    const price = currentLegPrices.find(p => p.symbol === leg.optionSymbol);
    return { ...leg, exitBid: price?.bid ?? 0, exitAsk: price?.ask ?? 0, exitMid: price?.mid ?? 0 };
  });
  const exitValue = calculatePositionValue(exitLegs, 'exit');
  const entryValue = trade.entryDebit ?? calculatePositionValue(trade.legs, 'entry');
  const pl = exitValue - entryValue;
  const plPct = trade.maxRisk && trade.maxRisk !== 0 ? (pl / Math.abs(trade.maxRisk)) * 100 : 0;

  return updateTrackedTrade(tradeId, {
    status: 'exited',
    exitedAt: now,
    spotAtExit: currentSpot,
    legs: exitLegs,
    exitValue,
    realizedPL: pl,
    realizedPLPct: plPct,
    exitReason: 'manual',
    outcome: pl > 0.5 ? 'win' : pl < -0.5 ? 'loss' : 'breakeven',
  });
}

// ─── Analytics Computation ──────────────────────────────────

export function computeAnalytics(trades: TrackedTrade[]): TradeAnalytics {
  const closed = trades.filter(t => t.status === 'exited' || t.status === 'expired');
  const open = trades.filter(t => t.status === 'pending' || t.status === 'entered');

  const wins = closed.filter(t => t.outcome === 'win');
  const losses = closed.filter(t => t.outcome === 'loss');
  const breakevens = closed.filter(t => t.outcome === 'breakeven');

  const winPLs = wins.map(t => t.realizedPLPct ?? 0);
  const lossPLs = losses.map(t => t.realizedPLPct ?? 0);

  const avgWinPct = winPLs.length > 0 ? winPLs.reduce((a, b) => a + b, 0) / winPLs.length : 0;
  const avgLossPct = lossPLs.length > 0 ? lossPLs.reduce((a, b) => a + b, 0) / lossPLs.length : 0;

  const grossWins = wins.reduce((s, t) => s + Math.max(0, t.realizedPL ?? 0), 0);
  const grossLosses = losses.reduce((s, t) => s + Math.abs(Math.min(0, t.realizedPL ?? 0)), 0);
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  const totalPL = closed.reduce((s, t) => s + (t.realizedPL ?? 0), 0);

  // Average holding time
  const holdingDays = closed
    .filter(t => t.enteredAt && t.exitedAt)
    .map(t => (t.exitedAt! - t.enteredAt!) / (1000 * 60 * 60 * 24));
  const avgHoldingDays = holdingDays.length > 0 ? holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length : 0;

  // Best/worst trades
  const sortedByPL = [...closed].sort((a, b) => (b.realizedPLPct ?? 0) - (a.realizedPLPct ?? 0));
  const best = sortedByPL[0];
  const worst = sortedByPL[sortedByPL.length - 1];

  // Group by source
  const bySource: TradeAnalytics['bySource'] = {} as TradeAnalytics['bySource'];
  for (const src of ['algorithm', 'ai-briefing', 'ai-analysis'] as TradeSource[]) {
    const srcTrades = closed.filter(t => t.source === src);
    const srcWins = srcTrades.filter(t => t.outcome === 'win');
    bySource[src] = {
      count: srcTrades.length,
      wins: srcWins.length,
      winRate: srcTrades.length > 0 ? srcWins.length / srcTrades.length : 0,
      avgPL: srcTrades.length > 0 ? srcTrades.reduce((s, t) => s + (t.realizedPL ?? 0), 0) / srcTrades.length : 0,
    };
  }

  // Group by strategy
  const byStrategy: TradeAnalytics['byStrategy'] = {};
  for (const t of closed) {
    const key = t.strategy;
    if (!byStrategy[key]) byStrategy[key] = { count: 0, wins: 0, winRate: 0, avgPL: 0 };
    byStrategy[key].count++;
    if (t.outcome === 'win') byStrategy[key].wins++;
  }
  for (const key of Object.keys(byStrategy)) {
    const g = byStrategy[key];
    g.winRate = g.count > 0 ? g.wins / g.count : 0;
    const stratTrades = closed.filter(t => t.strategy === key);
    g.avgPL = stratTrades.length > 0 ? stratTrades.reduce((s, t) => s + (t.realizedPL ?? 0), 0) / stratTrades.length : 0;
  }

  // Group by direction
  const byDirection: TradeAnalytics['byDirection'] = {};
  for (const t of closed) {
    const key = t.direction;
    if (!byDirection[key]) byDirection[key] = { count: 0, wins: 0, winRate: 0, avgPL: 0 };
    byDirection[key].count++;
    if (t.outcome === 'win') byDirection[key].wins++;
  }
  for (const key of Object.keys(byDirection)) {
    const g = byDirection[key];
    g.winRate = g.count > 0 ? g.wins / g.count : 0;
    const dirTrades = closed.filter(t => t.direction === key);
    g.avgPL = dirTrades.length > 0 ? dirTrades.reduce((s, t) => s + (t.realizedPL ?? 0), 0) / dirTrades.length : 0;
  }

  return {
    totalTrades: trades.length,
    openTrades: open.length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakevens.length,
    winRate: (wins.length + losses.length) > 0 ? wins.length / (wins.length + losses.length) : 0,
    avgWinPct,
    avgLossPct,
    profitFactor,
    totalPL,
    avgPL: closed.length > 0 ? totalPL / closed.length : 0,
    avgHoldingDays,
    bestTrade: best ? { id: best.id, symbol: best.symbol, strategy: best.strategy, plPct: best.realizedPLPct ?? 0 } : null,
    worstTrade: worst && worst !== best ? { id: worst.id, symbol: worst.symbol, strategy: worst.strategy, plPct: worst.realizedPLPct ?? 0 } : null,
    bySource,
    byStrategy,
    byDirection,
  };
}

// ─── Factory: Build a TrackedTrade from recommendation data ─

export function buildTrackedTradeFromAlgo(params: {
  symbol: string;
  spotPrice: number;
  trade: {
    strategy: string;
    direction: string;
    confidence: string;
    score: number;
    expiration: string;
    strikes: string;
    entry: string;
    risk: string;
    reasoning: string[];
    tags: string[];
    profitTargetPct?: number;
    stopLossPct?: number;
  };
  marketSnapshot: TrackedTrade['marketSnapshot'];
  source: TradeSource;
  nearestExp: string;
  legs?: TrackedLeg[];
}): TrackedTrade {
  const { symbol, spotPrice, trade, marketSnapshot, source, nearestExp, legs } = params;

  // Parse expiration: use the provided nearestExp as the expiration date
  const expirationDate = nearestExp;

  // Build basic legs from strikes text if not provided
  const parsedLegs: TrackedLeg[] = legs ?? parseLegsFromStrikesText(symbol, trade.strikes, trade.strategy, expirationDate, spotPrice);

  // Calculate entry debit/credit and max risk
  const entryValue = calculatePositionValue(parsedLegs, 'entry');
  const maxRisk = calculateMaxRisk(parsedLegs, trade.strategy);

  return {
    id: `track-${source}-${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source,
    symbol,
    spotAtEntry: spotPrice,
    spotAtExit: null,
    strategy: trade.strategy,
    direction: trade.direction as TrackedTrade['direction'],
    confidence: trade.confidence,
    score: trade.score,
    legs: parsedLegs,
    entryCondition: trade.entry,
    profitTargetPct: trade.profitTargetPct ?? 50,
    stopLossPct: trade.stopLossPct ?? 50,
    riskDescription: trade.risk,
    reasoning: trade.reasoning,
    tags: trade.tags,
    marketSnapshot,
    trackedAt: Date.now(),
    enteredAt: Date.now(), // Enter immediately on track
    exitedAt: null,
    expirationDate,
    status: 'entered',
    outcome: null,
    entryDebit: entryValue,
    exitValue: null,
    realizedPL: null,
    realizedPLPct: null,
    maxRisk,
    priceHistory: [{ timestamp: Date.now(), spotPrice, positionValue: entryValue }],
    exitReason: null,
    notes: '',
  };
}

/**
 * Parse legs from the strikes text description.
 * This is a best-effort parser — option prices are estimated from the strategy context.
 */
function parseLegsFromStrikesText(
  symbol: string,
  strikesText: string,
  strategy: string,
  expiration: string,
  spotPrice: number
): TrackedLeg[] {
  const legs: TrackedLeg[] = [];
  const stratLow = strategy.toLowerCase();

  // Extract all dollar amounts
  const allStrikes = [...strikesText.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  const sellStrikes = [...strikesText.matchAll(/sell\s+\$(\d+(?:\.\d+)?)/gi)].map(m => parseFloat(m[1]));
  const buyStrikes = [...strikesText.matchAll(/buy\s+\$(\d+(?:\.\d+)?)/gi)].map(m => parseFloat(m[1]));

  // Helper to build OCC symbol
  const occ = (type: 'C' | 'P', strike: number) => {
    const d = new Date(expiration + 'T12:00:00');
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const s = String(Math.round(strike * 1000)).padStart(8, '0');
    return `${symbol.toUpperCase()}${yy}${mm}${dd}${type}${s}`;
  };

  // Estimate mid price based on distance from spot and strategy type
  const estimateMid = (strike: number, type: 'call' | 'put'): number => {
    const dist = type === 'call' ? spotPrice - strike : strike - spotPrice;
    const intrinsic = Math.max(0, dist);
    // Rough extrinsic estimate based on ATM ~2-5% of spot
    const extrinsic = Math.max(0.10, spotPrice * 0.02 * Math.exp(-Math.abs(strike - spotPrice) / spotPrice * 5));
    return Math.round((intrinsic + extrinsic) * 100) / 100;
  };

  const makeLeg = (strike: number, type: 'call' | 'put', side: 'long' | 'short'): TrackedLeg => {
    const mid = estimateMid(strike, type);
    return {
      optionSymbol: occ(type === 'call' ? 'C' : 'P', strike),
      optionType: type,
      strike,
      expiration,
      side,
      quantity: 1,
      entryBid: mid * 0.95,
      entryAsk: mid * 1.05,
      entryMid: mid,
      exitBid: null,
      exitAsk: null,
      exitMid: null,
      entryDelta: 0,
      entryGamma: 0,
      entryTheta: 0,
      entryVega: 0,
      entryIV: 0,
    };
  };

  // Parse based on strategy type
  if (stratLow.includes('iron condor')) {
    const sellCallMatch = strikesText.match(/sell\s+\$(\d+(?:\.\d+)?)c/i) || strikesText.match(/\$(\d+(?:\.\d+)?)C/);
    const sellPutMatch = strikesText.match(/sell\s+\$(\d+(?:\.\d+)?)p/i) || strikesText.match(/\$(\d+(?:\.\d+)?)P/);
    if (sellCallMatch && sellPutMatch) {
      const sc = parseFloat(sellCallMatch[1]);
      const sp = parseFloat(sellPutMatch[1]);
      const width = allStrikes.length > 2 ? Math.abs(allStrikes[2] - allStrikes[1]) : 5;
      legs.push(makeLeg(sc, 'call', 'short'), makeLeg(sc + width, 'call', 'long'), makeLeg(sp, 'put', 'short'), makeLeg(sp - width, 'put', 'long'));
    }
  } else if (stratLow.includes('bull put') || (stratLow.includes('put') && stratLow.includes('credit'))) {
    const sell = sellStrikes[0] || Math.max(...allStrikes);
    const buy = buyStrikes[0] || Math.min(...allStrikes);
    if (sell && buy) {
      legs.push(makeLeg(sell, 'put', 'short'), makeLeg(buy, 'put', 'long'));
    }
  } else if (stratLow.includes('bear call') || (stratLow.includes('call') && stratLow.includes('credit'))) {
    const sell = sellStrikes[0] || Math.min(...allStrikes);
    const buy = buyStrikes[0] || Math.max(...allStrikes);
    if (sell && buy) {
      legs.push(makeLeg(sell, 'call', 'short'), makeLeg(buy, 'call', 'long'));
    }
  } else if (stratLow.includes('bull call') || stratLow.includes('call debit')) {
    const buy = buyStrikes[0] || Math.min(...allStrikes);
    const sell = sellStrikes[0] || Math.max(...allStrikes);
    if (buy && sell) {
      legs.push(makeLeg(buy, 'call', 'long'), makeLeg(sell, 'call', 'short'));
    }
  } else if (stratLow.includes('bear put') || stratLow.includes('put debit')) {
    const buy = buyStrikes[0] || Math.max(...allStrikes);
    const sell = sellStrikes[0] || Math.min(...allStrikes);
    if (buy && sell) {
      legs.push(makeLeg(buy, 'put', 'long'), makeLeg(sell, 'put', 'short'));
    }
  } else if (stratLow.includes('straddle')) {
    const strike = allStrikes[0] || Math.round(spotPrice);
    legs.push(makeLeg(strike, 'call', 'long'), makeLeg(strike, 'put', 'long'));
  } else if (stratLow.includes('strangle')) {
    const putStrike = Math.min(...allStrikes) || Math.round(spotPrice * 0.97);
    const callStrike = Math.max(...allStrikes) || Math.round(spotPrice * 1.03);
    legs.push(makeLeg(callStrike, 'call', 'long'), makeLeg(putStrike, 'put', 'long'));
  } else {
    // Fallback: single leg
    const strike = allStrikes[0] || Math.round(spotPrice);
    const type = /put|bear/i.test(strategy) ? 'put' : 'call';
    legs.push(makeLeg(strike, type as 'call' | 'put', 'long'));
  }

  return legs;
}

/**
 * Estimate max risk for a given position structure.
 */
function calculateMaxRisk(legs: TrackedLeg[], strategy: string): number {
  const stratLow = strategy.toLowerCase();
  const entryValue = calculatePositionValue(legs, 'entry');

  if (stratLow.includes('debit') || stratLow.includes('straddle') || stratLow.includes('strangle')) {
    // Max risk = debit paid
    return Math.abs(entryValue);
  }

  if (stratLow.includes('credit') || stratLow.includes('iron condor')) {
    // Max risk = spread width * 100 - credit received
    const strikes = legs.map(l => l.strike).sort((a, b) => a - b);
    if (strikes.length >= 2) {
      const maxSpreadWidth = strikes[strikes.length - 1] - strikes[0];
      const perLegWidth = legs.length >= 4 ? (strikes[1] - strikes[0]) : maxSpreadWidth;
      return perLegWidth * 100 + entryValue; // credit is negative entryValue
    }
  }

  // Fallback: entry cost as max risk
  return Math.abs(entryValue);
}
