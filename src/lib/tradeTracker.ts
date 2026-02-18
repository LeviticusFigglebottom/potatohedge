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
    if (!Array.isArray(parsed)) return [];
    // Filter out invalid/corrupted trades, then auto-expire stale
    const valid = parsed.filter(isValidTrade);
    return autoExpireStale(valid);
  } catch {
    return [];
  }
}

/**
 * Auto-expire trades that are past their expiration date but still open.
 * This handles the case where TrackerMonitor didn't run during expiration
 * (e.g., weekend expiration, after-hours, app not loaded).
 */
const PENDING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max for pending trades

function autoExpireStale(trades: TrackedTrade[]): TrackedTrade[] {
  const now = Date.now();
  let changed = false;
  for (const t of trades) {
    if (t.status === 'exited' || t.status === 'expired') continue;

    // Expire pending trades stuck for >30 minutes without ever getting priced
    if (t.status === 'pending' && now - t.trackedAt > PENDING_TIMEOUT_MS) {
      t.status = 'expired';
      t.exitedAt = now;
      t.exitReason = 'failed-entry';
      t.outcome = null;
      t.notes = (t.notes ? t.notes + ' | ' : '') + 'Auto-expired: unable to get entry prices within 30 minutes';
      changed = true;
      continue;
    }

    const expDate = new Date(t.expirationDate + 'T16:00:00-05:00').getTime();
    // Auto-expire if more than 1 hour past expiration
    if (now > expDate + 3600000) {
      t.status = 'expired';
      t.exitedAt = now;
      t.exitReason = 'expiration';
      if (t.outcome === null) {
        // Best-effort outcome: if we have an entry value, use last price snapshot
        const lastSnap = t.priceHistory.length > 0 ? t.priceHistory[t.priceHistory.length - 1] : null;
        if (lastSnap && t.entryDebit !== null) {
          const pl = lastSnap.positionValue - t.entryDebit;
          t.exitValue = lastSnap.positionValue;
          t.realizedPL = pl;
          t.realizedPLPct = calcPLPct(pl, t.entryDebit, t.maxRisk);
          t.outcome = pl > 0.5 ? 'win' : pl < -0.5 ? 'loss' : 'breakeven';
        } else {
          t.outcome = 'loss';
        }
      }
      changed = true;
    }
  }
  if (changed) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trades)); } catch {}
    syncTrackedTradesToServer(trades).catch(() => {});
  }
  return trades;
}

export function saveTrackedTrades(trades: TrackedTrade[]): void {
  if (typeof window === 'undefined') return;
  // Clean invalid trades before saving
  const cleaned = trades.filter(isValidTrade);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    // Track the save timestamp so sync knows local is fresh
    localStorage.setItem(STORAGE_KEY + ':lastSave', String(Date.now()));
  } catch {
    // localStorage full — silently fail
  }
  // Fire-and-forget server sync
  syncTrackedTradesToServer(cleaned).catch(() => {});
}

/**
 * Validate that a tracked trade has the minimum required data.
 * Filters out corrupted trades (no legs, missing fields).
 */
function isValidTrade(t: TrackedTrade): boolean {
  if (!t || !t.id || !t.symbol || !t.strategy) return false;
  if (!t.legs || !Array.isArray(t.legs) || t.legs.length === 0) return false;
  // At least one leg must have an option symbol
  if (!t.legs.some(l => l.optionSymbol)) return false;
  if (!t.expirationDate) return false;
  return true;
}

async function syncTrackedTradesToServer(trades: TrackedTrade[]): Promise<void> {
  // Wrap each trade as a history record with date + timestamp for persistence layer compat
  // Use trade ID as the `date` field because the persistence layer deduplicates by `date`.
  // Using the actual date would cause only 1 trade per day to survive server sync.
  const records = trades.map(t => ({
    ...t,
    date: t.id,  // unique per trade — prevents dedup from losing multi-trade-per-day data
    timestamp: t.trackedAt,
  }));
  // Use overwrite mode so the server always matches the client exactly.
  // This ensures deletions, purges, and dedup results propagate to the server.
  // Without overwrite, the server merge re-adds deleted/purged trades.
  await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'tracked-trades',
      ticker: '_ALL',
      records,
      mode: 'overwrite',
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export async function loadTrackedTradesWithSync(): Promise<TrackedTrade[]> {
  const local = loadTrackedTrades(); // already auto-expires stale + validates

  // If a purge happened recently, local is [] and we must NOT resurrect from server.
  // The purgedAt flag stays for 10 minutes to cover any server-sync race conditions.
  const purgedAtStr = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY + ':purgedAt') : null;
  const purgedAt = purgedAtStr ? parseInt(purgedAtStr, 10) : 0;
  if (purgedAt > 0 && Date.now() - purgedAt < 600000) {
    // Within 10 minutes of a purge — local is authoritative (empty), push to server
    syncTrackedTradesToServer(local).catch(() => {});
    return local;
  }
  // Clear stale purge flag
  if (purgedAt > 0) {
    try { localStorage.removeItem(STORAGE_KEY + ':purgedAt'); } catch {}
  }

  // If we saved locally very recently (within 10s), skip server fetch entirely
  const lastSaveStr = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY + ':lastSave') : null;
  const lastSave = lastSaveStr ? parseInt(lastSaveStr, 10) : 0;
  if (Date.now() - lastSave < 10000) {
    return local;
  }

  try {
    const res = await fetch('/api/history?type=tracked-trades&ticker=_ALL&days=365', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return local;
    const { records: server } = await res.json() as { records: TrackedTrade[] };
    if (!server || !Array.isArray(server) || server.length === 0) {
      if (local.length > 0) syncTrackedTradesToServer(local).catch(() => {});
      return local;
    }

    // If local is empty and there was a recent save (within 5 min), don't adopt server data.
    // The user explicitly cleared it.
    if (local.length === 0 && lastSave > 0 && Date.now() - lastSave < 300000) {
      syncTrackedTradesToServer([]).catch(() => {});
      return local;
    }

    const localIds = new Set(local.map(t => t.id));
    const merged = [...local];

    for (const serverTrade of server) {
      if (!isValidTrade(serverTrade)) continue;
      if (!localIds.has(serverTrade.id)) {
        // Server has a trade local doesn't — only adopt if local hasn't been saved recently
        if (lastSave > 0 && Date.now() - lastSave < 300000) continue;
        merged.push(serverTrade);
      } else {
        const localTrade = merged.find(t => t.id === serverTrade.id)!;
        // Adopt server priceHistory if it has more data points
        if (serverTrade.priceHistory && serverTrade.priceHistory.length > (localTrade.priceHistory?.length || 0)) {
          const localIdx = merged.findIndex(t => t.id === serverTrade.id);
          if (localIdx !== -1) {
            merged[localIdx] = { ...localTrade, priceHistory: serverTrade.priceHistory };
          }
        }
      }
    }

    merged.sort((a, b) => b.trackedAt - a.trackedAt);
    // Deduplicate: if same symbol + strategy + expiration exists multiple times, keep newest
    const seen = new Set<string>();
    const deduped = merged.filter(t => {
      const key = `${t.symbol}|${t.strategy}|${t.expirationDate}`;
      // Allow multiple closed trades with the same key, only dedup open ones
      if (t.status === 'exited' || t.status === 'expired') return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(deduped)); } catch {}
    syncTrackedTradesToServer(deduped).catch(() => {});
    return deduped;
  } catch {
    return local;
  }
}

// ─── CRUD Operations ────────────────────────────────────────

export function addTrackedTrade(trade: TrackedTrade): TrackedTrade[] {
  const trades = loadTrackedTrades();
  // Don't add exact ID duplicates
  if (trades.some(t => t.id === trade.id)) return trades;
  // Don't add functional duplicates (same symbol + strategy + expiration that are still open)
  if (isDuplicateTrack(trades, trade.symbol, trade.strategy, trade.expirationDate)) return trades;
  trades.unshift(trade);
  saveTrackedTrades(trades);
  return trades;
}

/**
 * Check if a functionally equivalent open trade already exists.
 */
export function isDuplicateTrack(
  trades: TrackedTrade[],
  symbol: string,
  strategy: string,
  expirationDate: string
): boolean {
  return trades.some(t =>
    t.symbol === symbol &&
    t.strategy === strategy &&
    t.expirationDate === expirationDate &&
    (t.status === 'pending' || t.status === 'entered')
  );
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
  // Force immediate server sync so the deletion persists across tab switches
  syncTrackedTradesToServer(trades).catch(() => {});
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
 * Compute P/L% using cost basis (abs of entry debit/credit) as denominator.
 * This matches the recommendation engine's intent: profitTargetPct and stopLossPct
 * are defined as "% of cost" — e.g., 50 means take profit at +50% of premium paid
 * (debit) or +50% of credit received (credit spreads).
 *
 * Falls back to maxRisk (spread width) when cost basis is too small (<$25)
 * to avoid wild percentage swings on near-zero-cost positions.
 */
export function calcPLPct(pl: number, entryDebit: number | null, maxRisk: number | null): number {
  const costBasis = Math.abs(entryDebit ?? 0);
  if (costBasis > 25) return (pl / costBasis) * 100;
  if (maxRisk && maxRisk !== 0) return (pl / Math.abs(maxRisk)) * 100;
  return 0;
}

/**
 * Check a tracked trade against current market data and update its status.
 * Returns the updated trade if any changes were made, null otherwise.
 */
export function evaluateTrade(
  trade: TrackedTrade,
  currentSpot: number,
  currentLegPrices: { symbol: string; bid: number; ask: number; mid: number; last?: number }[]
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
    const correctedMaxRisk = calculateMaxRisk(trade.legs, trade.strategy, currentSpot);
    const plPct = calcPLPct(pl, entryValue, correctedMaxRisk);

    updates.status = 'expired';
    updates.exitedAt = now;
    updates.spotAtExit = currentSpot;
    updates.legs = exitLegs;
    updates.exitValue = exitValue;
    updates.realizedPL = pl;
    updates.realizedPLPct = plPct;
    updates.maxRisk = correctedMaxRisk;
    updates.exitReason = 'expiration';
    updates.outcome = pl > 0.5 ? 'win' : pl < -0.5 ? 'loss' : 'breakeven';

    const trades = updateTrackedTrade(trade.id, updates);
    return trades.find(t => t.id === trade.id) ?? null;
  }

  // If pending, capture entry prices and transition to entered
  if (trade.status === 'pending') {
    // Fill entry prices from current market data (first observation = entry)
    // Use mid price preferentially; fall back to last price or (bid+ask)/2
    const entryLegs = trade.legs.map(leg => {
      const price = currentLegPrices.find(p => p.symbol === leg.optionSymbol);
      if (price) {
        const bestMid = price.mid > 0 ? price.mid : (price.last ?? 0);
        if (bestMid > 0) {
          return { ...leg, entryBid: price.bid, entryAsk: price.ask, entryMid: bestMid };
        }
      }
      return leg;
    });

    const pricedCount = entryLegs.filter(l => l.entryMid > 0).length;
    const totalLegs = entryLegs.length;
    const pendingMinutes = (now - trade.trackedAt) / 60000;

    // Enter if MOST legs have prices (≥50%) — don't wait forever for illiquid legs.
    // For single-leg trades, still require the leg to be priced.
    // After 15 min pending, relax to just 1 priced leg to avoid getting stuck.
    const normalMin = totalLegs <= 2 ? totalLegs : Math.ceil(totalLegs * 0.5);
    const minRequired = pendingMinutes > 15 ? Math.min(normalMin, 1) : normalMin;
    if (pricedCount < minRequired) {
      return null;
    }

    const entryValue = calculatePositionValue(entryLegs, 'entry');
    const recalcMaxRisk = calculateMaxRisk(entryLegs, trade.strategy, currentSpot);

    updates.status = 'entered';
    updates.enteredAt = now;
    updates.legs = entryLegs;
    updates.entryDebit = entryValue;
    updates.maxRisk = recalcMaxRisk;
  }

  // Calculate current position value for entered trades
  if (trade.status === 'entered' || updates.status === 'entered') {
    const activeLeg = updates.legs ?? trade.legs;
    const currentLegs = activeLeg.map(leg => {
      const price = currentLegPrices.find(p => p.symbol === leg.optionSymbol);
      // Use mid > last > 0 as fallback chain
      const bestMid = price ? (price.mid > 0 ? price.mid : (price.last ?? price.mid)) : 0;
      return {
        ...leg,
        exitBid: price?.bid ?? 0,
        exitAsk: price?.ask ?? 0,
        exitMid: bestMid,
      };
    });

    const pricedLegs = currentLegs.filter(l => (l.exitMid ?? 0) > 0).length;
    const allCurrentPriced = pricedLegs === currentLegs.length;

    // Always compute position value (even with partial data) so we can add a snapshot
    const currentValue = calculatePositionValue(currentLegs, 'exit');
    const entryValue = updates.entryDebit ?? trade.entryDebit ?? calculatePositionValue(activeLeg, 'entry');

    // Fix maxRisk for existing trades that were calculated without quantity
    const effectiveMaxRisk = updates.maxRisk ?? trade.maxRisk ?? calculateMaxRisk(activeLeg, trade.strategy, currentSpot);
    const qty = Math.max(1, ...activeLeg.map(l => l.quantity));
    let correctedMaxRisk = effectiveMaxRisk;
    if (qty > 1 && effectiveMaxRisk > 0) {
      const strikes = activeLeg.map(l => l.strike).sort((a, b) => a - b);
      const width = strikes.length >= 2 ? strikes[strikes.length - 1] - strikes[0] : 0;
      if (width > 0 && Math.abs(effectiveMaxRisk - width * 100) < 1) {
        correctedMaxRisk = width * 100 * qty;
        updates.maxRisk = correctedMaxRisk;
      }
    }

    const unrealizedPL = currentValue - entryValue;
    // Use cost basis (abs of entry debit/credit) for P/L% — matches recommendation
    // engine intent where profitTargetPct/stopLossPct are "% of cost/credit".
    const plPct = calcPLPct(unrealizedPL, entryValue, correctedMaxRisk);

    // Always add a price snapshot — even with partial pricing.
    // This ensures P/L shows something rather than perpetual "—".
    const snapshot = { timestamp: now, spotPrice: currentSpot, positionValue: currentValue };
    updates.priceHistory = [...(trade.priceHistory || []), snapshot].slice(-100);

    // Only trigger exit conditions when ALL legs are fully priced
    // (prevents false exits from partial/missing quotes)
    if (allCurrentPriced) {
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
      } else if (plPct <= -trade.stopLossPct) {
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
  const correctedMaxRisk = calculateMaxRisk(trade.legs, trade.strategy, currentSpot);
  const plPct = calcPLPct(pl, entryValue, correctedMaxRisk);

  return updateTrackedTrade(tradeId, {
    status: 'exited',
    exitedAt: now,
    spotAtExit: currentSpot,
    legs: exitLegs,
    exitValue,
    realizedPL: pl,
    realizedPLPct: plPct,
    maxRisk: correctedMaxRisk,
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
  let parsedLegs: TrackedLeg[] = legs ?? parseLegsFromStrikesText(symbol, trade.strikes, trade.strategy, expirationDate, spotPrice);

  // Validate strikes are reasonable before sizing
  if (!hasAdequatePremium(parsedLegs, spotPrice)) {
    // Strikes are likely far OTM penny options — log warning but still track
    // The validateAndClampStrikes in parseLegsFromStrikesText should have fixed most cases
    console.warn(`[tradeTracker] Trade ${symbol} ${trade.strategy} may have inadequate premium — strikes far from spot $${spotPrice}`);
  }

  // Auto-size if all legs have qty=1 (no explicit sizing in the text).
  // The algo recommendations include "Nx" in strikes text which parseLegsFromStrikesText respects.
  // AI trade ideas typically don't include sizing, so we apply portfolio-based sizing here.
  const allQtyOne = parsedLegs.length > 0 && parsedLegs.every(l => l.quantity === 1);
  if (allQtyOne) {
    const optimalQty = sizePosition(parsedLegs, trade.strategy, spotPrice);
    if (optimalQty > 1) {
      parsedLegs = parsedLegs.map(l => ({ ...l, quantity: optimalQty }));
    }
  }

  // Calculate max risk
  const maxRisk = calculateMaxRisk(parsedLegs, trade.strategy, spotPrice);

  // If ALL legs have real entry prices, start as 'entered' immediately.
  // Otherwise start as 'pending' — TrackerMonitor will fill prices on first cycle.
  // This prevents "entered but zero-price legs" data quality issues.
  const allLegsHavePrices = parsedLegs.length > 0 && parsedLegs.every(l => l.entryMid > 0);
  const hasRealPrices = allLegsHavePrices;
  const entryValue = hasRealPrices ? calculatePositionValue(parsedLegs, 'entry') : null;
  const now = Date.now();

  return {
    id: `track-${source}-${symbol}-${now}-${Math.random().toString(36).slice(2, 7)}`,
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
    trackedAt: now,
    enteredAt: hasRealPrices ? now : null,
    exitedAt: null,
    expirationDate,
    status: hasRealPrices ? 'entered' : 'pending',
    outcome: null,
    entryDebit: entryValue,
    exitValue: null,
    realizedPL: null,
    realizedPLPct: null,
    maxRisk,
    priceHistory: hasRealPrices
      ? [{ timestamp: now, spotPrice, positionValue: entryValue! }]
      : [],
    exitReason: null,
    notes: '',
  };
}

/**
 * Fetch live option prices for a set of OCC symbols.
 * Used at trade creation time to get entry prices immediately.
 */
export async function fetchEntryPrices(
  occSymbols: string[],
  underlying: string
): Promise<{ quotes: Record<string, { bid: number; ask: number; mid: number; last: number }>; spot: number | null }> {
  if (typeof window === 'undefined' || occSymbols.length === 0) {
    return { quotes: {}, spot: null };
  }
  try {
    const res = await fetch(
      `/api/tracker/prices?symbols=${encodeURIComponent(occSymbols.join(','))}&underlying=${encodeURIComponent(underlying)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return { quotes: {}, spot: null };
    return await res.json();
  } catch {
    return { quotes: {}, spot: null };
  }
}

/**
 * Fill entry prices on TrackedLeg array from fetched quotes.
 * Returns updated legs with entryBid/entryAsk/entryMid populated.
 */
export function fillEntryPrices(
  legs: TrackedLeg[],
  quotes: Record<string, { bid: number; ask: number; mid: number; last?: number }>
): TrackedLeg[] {
  return legs.map(leg => {
    const q = quotes[leg.optionSymbol];
    if (!q) return leg;
    const bestMid = q.mid > 0 ? q.mid : (q.last ?? 0);
    if (bestMid <= 0) return leg;
    return { ...leg, entryBid: q.bid, entryAsk: q.ask, entryMid: bestMid };
  });
}

/**
 * Parse legs from the strikes text description.
 * This is a best-effort parser — option prices are estimated conservatively.
 * Real prices will be filled by TrackerMonitor on first evaluation cycle.
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
  const textLow = strikesText.toLowerCase();

  // Extract all dollar amounts from strikes text
  const allStrikes = [...strikesText.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));

  // Extract explicit buy/sell + strike + type patterns
  // e.g., "Sell $690P / Buy $685P" or "Buy $695C / Sell $700C"
  const sellStrikes = [...strikesText.matchAll(/sell\s+\$?(\d+(?:\.\d+)?)\s*([CP]|call|put)?/gi)].map(m => ({
    strike: parseFloat(m[1]),
    type: m[2] ? (m[2].toLowerCase().startsWith('c') ? 'call' : 'put') : null,
  }));
  const buyStrikes = [...strikesText.matchAll(/buy\s+\$?(\d+(?:\.\d+)?)\s*([CP]|call|put)?/gi)].map(m => ({
    strike: parseFloat(m[1]),
    type: m[2] ? (m[2].toLowerCase().startsWith('c') ? 'call' : 'put') : null,
  }));

  // Also detect "Sell $690P" format (strike immediately followed by C/P)
  const sellWithType = [...strikesText.matchAll(/sell[^$]*\$(\d+(?:\.\d+)?)([CP])/gi)].map(m => ({
    strike: parseFloat(m[1]),
    type: m[2].toLowerCase() === 'c' ? 'call' as const : 'put' as const,
  }));
  const buyWithType = [...strikesText.matchAll(/buy[^$]*\$(\d+(?:\.\d+)?)([CP])/gi)].map(m => ({
    strike: parseFloat(m[1]),
    type: m[2].toLowerCase() === 'c' ? 'call' as const : 'put' as const,
  }));

  // Merge type info
  for (const s of sellWithType) {
    const existing = sellStrikes.find(e => e.strike === s.strike);
    if (existing && !existing.type) existing.type = s.type;
    else if (!existing) sellStrikes.push({ strike: s.strike, type: s.type });
  }
  for (const b of buyWithType) {
    const existing = buyStrikes.find(e => e.strike === b.strike);
    if (existing && !existing.type) existing.type = b.type;
    else if (!existing) buyStrikes.push({ strike: b.strike, type: b.type });
  }

  // Detect quantity patterns like "2x" or "×2"
  const quantityMatch = strikesText.match(/(\d+)\s*x\s/i) || strikesText.match(/×\s*(\d+)/);
  const defaultQty = quantityMatch ? parseInt(quantityMatch[1]) : 1;

  // Helper to build OCC symbol
  const occ = (type: 'C' | 'P', strike: number) => {
    const d = new Date(expiration + 'T12:00:00');
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const s = String(Math.round(strike * 1000)).padStart(8, '0');
    return `${symbol.toUpperCase()}${yy}${mm}${dd}${type}${s}`;
  };

  const makeLeg = (strike: number, type: 'call' | 'put', side: 'long' | 'short', quantity: number = 1): TrackedLeg => ({
    optionSymbol: occ(type === 'call' ? 'C' : 'P', strike),
    optionType: type,
    strike,
    expiration,
    side,
    quantity,
    // Entry prices set to 0 — will be filled by TrackerMonitor with real market data
    entryBid: 0,
    entryAsk: 0,
    entryMid: 0,
    exitBid: null,
    exitAsk: null,
    exitMid: null,
    entryDelta: 0,
    entryGamma: 0,
    entryTheta: 0,
    entryVega: 0,
    entryIV: 0,
  });

  // ── Strategy-specific parsing ────────────────────────────

  // Iron Condor: sell inner call + sell inner put, buy outer wings
  if (stratLow.includes('iron condor')) {
    // Try to find 4 strikes
    if (allStrikes.length >= 4) {
      const sorted = [...allStrikes].sort((a, b) => a - b);
      legs.push(makeLeg(sorted[0], 'put', 'long'));    // buy lower put wing
      legs.push(makeLeg(sorted[1], 'put', 'short'));   // sell inner put
      legs.push(makeLeg(sorted[2], 'call', 'short'));  // sell inner call
      legs.push(makeLeg(sorted[3], 'call', 'long'));   // buy upper call wing
    } else if (sellStrikes.length >= 2) {
      // Sell strikes given, infer wings
      const putSell = sellStrikes.find(s => s.type === 'put')?.strike || Math.min(...sellStrikes.map(s => s.strike));
      const callSell = sellStrikes.find(s => s.type === 'call')?.strike || Math.max(...sellStrikes.map(s => s.strike));
      const width = 5; // default wing width
      legs.push(makeLeg(putSell - width, 'put', 'long'));
      legs.push(makeLeg(putSell, 'put', 'short'));
      legs.push(makeLeg(callSell, 'call', 'short'));
      legs.push(makeLeg(callSell + width, 'call', 'long'));
    }
  }
  // Iron Butterfly
  else if (stratLow.includes('iron butterfly') || stratLow.includes('iron fly')) {
    const center = allStrikes[0] || Math.round(spotPrice);
    const width = allStrikes.length >= 3 ? Math.abs(allStrikes[2] - allStrikes[0]) / 2 : 5;
    legs.push(makeLeg(center - width, 'put', 'long'));
    legs.push(makeLeg(center, 'put', 'short'));
    legs.push(makeLeg(center, 'call', 'short'));
    legs.push(makeLeg(center + width, 'call', 'long'));
  }
  // Bull Put Spread / Put Credit Spread
  else if (stratLow.includes('bull put') || (stratLow.includes('put') && stratLow.includes('credit'))) {
    const sell = sellStrikes[0]?.strike || Math.max(...allStrikes);
    const buy = buyStrikes[0]?.strike || Math.min(...allStrikes);
    if (sell && buy && isFinite(sell) && isFinite(buy)) {
      legs.push(makeLeg(sell, 'put', 'short'));
      legs.push(makeLeg(buy, 'put', 'long'));
    }
  }
  // Bear Call Spread / Call Credit Spread
  else if (stratLow.includes('bear call') || (stratLow.includes('call') && stratLow.includes('credit'))) {
    const sell = sellStrikes[0]?.strike || Math.min(...allStrikes);
    const buy = buyStrikes[0]?.strike || Math.max(...allStrikes);
    if (sell && buy && isFinite(sell) && isFinite(buy)) {
      legs.push(makeLeg(sell, 'call', 'short'));
      legs.push(makeLeg(buy, 'call', 'long'));
    }
  }
  // Bull Call Spread / Call Debit Spread
  else if (stratLow.includes('bull call') || stratLow.includes('call debit')) {
    const buy = buyStrikes[0]?.strike || Math.min(...allStrikes);
    const sell = sellStrikes[0]?.strike || Math.max(...allStrikes);
    if (buy && sell && isFinite(buy) && isFinite(sell)) {
      legs.push(makeLeg(buy, 'call', 'long'));
      legs.push(makeLeg(sell, 'call', 'short'));
    }
  }
  // Bear Put Spread / Put Debit Spread
  else if (stratLow.includes('bear put') || stratLow.includes('put debit')) {
    const buy = buyStrikes[0]?.strike || Math.max(...allStrikes);
    const sell = sellStrikes[0]?.strike || Math.min(...allStrikes);
    if (buy && sell && isFinite(buy) && isFinite(sell)) {
      legs.push(makeLeg(buy, 'put', 'long'));
      legs.push(makeLeg(sell, 'put', 'short'));
    }
  }
  // Call Ratio Backspread: sell 1 lower, buy 2 higher
  else if (stratLow.includes('ratio') && stratLow.includes('backspread') && stratLow.includes('call')) {
    if (allStrikes.length >= 2) {
      const sorted = [...allStrikes].sort((a, b) => a - b);
      legs.push(makeLeg(sorted[0], 'call', 'short', 1));
      legs.push(makeLeg(sorted[1], 'call', 'long', 2));
    }
  }
  // Put Ratio Backspread: sell 1 higher, buy 2 lower
  else if (stratLow.includes('ratio') && stratLow.includes('backspread') && stratLow.includes('put')) {
    if (allStrikes.length >= 2) {
      const sorted = [...allStrikes].sort((a, b) => a - b);
      legs.push(makeLeg(sorted[1], 'put', 'short', 1));
      legs.push(makeLeg(sorted[0], 'put', 'long', 2));
    }
  }
  // Ratio Spread (generic): detect from buy/sell patterns
  else if (stratLow.includes('ratio') && !stratLow.includes('backspread')) {
    if (allStrikes.length >= 2) {
      const sorted = [...allStrikes].sort((a, b) => a - b);
      const type = stratLow.includes('put') ? 'put' : 'call';
      if (type === 'call') {
        legs.push(makeLeg(sorted[0], 'call', 'long', 1));
        legs.push(makeLeg(sorted[1], 'call', 'short', 2));
      } else {
        legs.push(makeLeg(sorted[1], 'put', 'long', 1));
        legs.push(makeLeg(sorted[0], 'put', 'short', 2));
      }
    }
  }
  // Jade Lizard: short put + bear call spread (short call + long higher call)
  else if (stratLow.includes('jade lizard')) {
    if (allStrikes.length >= 3) {
      const sorted = [...allStrikes].sort((a, b) => a - b);
      legs.push(makeLeg(sorted[0], 'put', 'short'));
      legs.push(makeLeg(sorted[1], 'call', 'short'));
      legs.push(makeLeg(sorted[2], 'call', 'long'));
    }
  }
  // Straddle
  else if (stratLow.includes('straddle')) {
    const strike = allStrikes[0] || Math.round(spotPrice);
    const side = stratLow.includes('short') || stratLow.includes('sell') ? 'short' : 'long';
    legs.push(makeLeg(strike, 'call', side));
    legs.push(makeLeg(strike, 'put', side));
  }
  // Strangle
  else if (stratLow.includes('strangle')) {
    const putStrike = Math.min(...allStrikes) || Math.round(spotPrice * 0.97);
    const callStrike = Math.max(...allStrikes) || Math.round(spotPrice * 1.03);
    const side = stratLow.includes('short') || stratLow.includes('sell') ? 'short' : 'long';
    legs.push(makeLeg(callStrike, 'call', side));
    legs.push(makeLeg(putStrike, 'put', side));
  }
  // Calendar / Diagonal Spread (same strike, different expirations)
  else if (stratLow.includes('calendar') || stratLow.includes('diagonal')) {
    const strike = allStrikes[0] || Math.round(spotPrice);
    const type = stratLow.includes('put') ? 'put' : 'call';
    // Front month: short, back month: long (standard calendar)
    legs.push(makeLeg(strike, type as 'call' | 'put', 'short'));
    // For the long leg, we'd ideally use a later expiration, but we use same for tracking
    legs.push(makeLeg(strike, type as 'call' | 'put', 'long'));
  }
  // Butterfly
  else if (stratLow.includes('butterfly')) {
    const type = stratLow.includes('put') ? 'put' : 'call';
    if (allStrikes.length >= 3) {
      const sorted = [...allStrikes].sort((a, b) => a - b);
      legs.push(makeLeg(sorted[0], type as 'call' | 'put', 'long'));
      legs.push(makeLeg(sorted[1], type as 'call' | 'put', 'short', 2));
      legs.push(makeLeg(sorted[2], type as 'call' | 'put', 'long'));
    }
  }
  // Cash-Secured Put / Naked Put / Short Put / Put Sale → SELL put
  else if (
    (stratLow.includes('cash') && stratLow.includes('put')) ||
    stratLow.includes('naked put') ||
    stratLow.includes('short put') ||
    (stratLow.includes('put') && (stratLow.includes('sale') || stratLow.includes('sell') || stratLow.includes('write')))
  ) {
    const strike = allStrikes[0] || Math.round(spotPrice * 0.97);
    legs.push(makeLeg(strike, 'put', 'short'));
  }
  // Covered Call / Naked Call / Short Call / Call Sale → SELL call
  else if (
    stratLow.includes('covered call') ||
    stratLow.includes('naked call') ||
    stratLow.includes('short call') ||
    (stratLow.includes('call') && (stratLow.includes('sale') || stratLow.includes('sell') || stratLow.includes('write')))
  ) {
    const strike = allStrikes[0] || Math.round(spotPrice * 1.03);
    legs.push(makeLeg(strike, 'call', 'short'));
  }
  // Explicit sell/buy patterns in strikes text
  else if (sellStrikes.length > 0 || buyStrikes.length > 0) {
    for (const s of sellStrikes) {
      const type = s.type || (textLow.includes('put') ? 'put' : 'call');
      legs.push(makeLeg(s.strike, type as 'call' | 'put', 'short'));
    }
    for (const b of buyStrikes) {
      const type = b.type || (textLow.includes('put') ? 'put' : 'call');
      legs.push(makeLeg(b.strike, type as 'call' | 'put', 'long'));
    }
  }
  // Fallback: single leg — detect side from strategy name
  else {
    const strike = allStrikes[0] || Math.round(spotPrice);
    const type = /put|bear/i.test(strategy + strikesText) ? 'put' : 'call';
    // Detect if this is a short/sell position from strategy name
    const isShort = /\b(sell|short|write|sale|credit|naked|covered)\b/i.test(strategy);
    legs.push(makeLeg(strike, type as 'call' | 'put', isShort ? 'short' : 'long'));
  }

  // Validate strikes: clamp any that are too far from spot
  if (legs.length > 0 && spotPrice > 0) {
    const validated = validateAndClampStrikes(legs, spotPrice);
    // Rebuild OCC symbols for any legs whose strikes changed
    for (let i = 0; i < legs.length; i++) {
      if (legs[i].strike !== validated[i].strike) {
        const type = validated[i].optionType === 'call' ? 'C' : 'P';
        validated[i] = {
          ...validated[i],
          optionSymbol: occ(type as 'C' | 'P', validated[i].strike),
        };
      }
    }
    return validated;
  }

  return legs;
}

/**
 * Estimate max risk for a given position structure.
 * Returns in dollar terms for the TOTAL position (accounting for quantity).
 */
function calculateMaxRisk(legs: TrackedLeg[], strategy: string, spotPrice: number): number {
  const stratLow = strategy.toLowerCase();
  // Use the max quantity across legs (they should all be the same for a spread)
  const qty = Math.max(1, ...legs.map(l => l.quantity));

  // For defined-risk spreads, max risk = spread width × 100 × quantity
  const strikes = legs.map(l => l.strike).sort((a, b) => a - b);
  const hasMultipleLegs = legs.length >= 2;

  // Iron condor / iron butterfly: max risk = wider wing × 100 × qty
  if (stratLow.includes('iron condor') || stratLow.includes('iron butterfly') || stratLow.includes('iron fly')) {
    if (strikes.length >= 4) {
      const putWingWidth = strikes[1] - strikes[0];
      const callWingWidth = strikes[3] - strikes[2];
      return Math.max(putWingWidth, callWingWidth) * 100 * qty;
    }
  }

  // Vertical spreads (2 legs, same type): max risk = width × 100 × qty
  if (hasMultipleLegs && strikes.length >= 2) {
    const width = strikes[strikes.length - 1] - strikes[0];
    if (width > 0 && width <= 100) { // sanity check
      return width * 100 * qty;
    }
  }

  // Cash-secured put: max risk = strike × 100 × qty
  if (stratLow.includes('cash') && stratLow.includes('put')) {
    const putStrike = strikes[0] || spotPrice;
    return putStrike * 100 * qty;
  }

  // Naked put / short put
  if ((stratLow.includes('naked') || stratLow.includes('short')) && stratLow.includes('put')) {
    const putStrike = strikes[0] || spotPrice;
    return putStrike * 100 * qty;
  }

  // Single long option: max risk = premium paid (unknown, estimate from spot)
  if (legs.length === 1 && legs[0].side === 'long') {
    return spotPrice * 0.03 * 100 * qty;
  }

  // Straddle/strangle: max risk = total premium paid
  if (stratLow.includes('straddle') || stratLow.includes('strangle')) {
    if (legs.every(l => l.side === 'long')) {
      return spotPrice * 0.04 * 100 * qty;
    }
  }

  // Fallback: conservative estimate based on spot
  return spotPrice * 0.05 * 100 * qty;
}

// ─── Strike Validation ───────────────────────────────────

const MAX_ATR_DISTANCE = 2.0; // Max distance from spot in ATR multiples
const DEFAULT_ATR_PCT = 0.015; // 1.5% default ATR if unknown
const MIN_PREMIUM_PER_CONTRACT = 0.10; // $0.10 minimum per option leg
const MIN_POSITION_VALUE = 100; // $100 minimum notional per contract

/**
 * Validate that strikes are reasonable relative to spot price.
 * Returns clamped strikes if they're too far OTM, or null if unfixable.
 * Uses 2 ATR as the maximum distance from spot.
 */
export function validateAndClampStrikes(
  legs: TrackedLeg[],
  spotPrice: number,
  atrPercent?: number,
): TrackedLeg[] {
  if (spotPrice <= 0) return legs;
  const atr = spotPrice * (atrPercent || DEFAULT_ATR_PCT);
  const maxDist = atr * MAX_ATR_DISTANCE;
  const minStrike = spotPrice - maxDist;
  const maxStrike = spotPrice + maxDist;

  return legs.map(leg => {
    if (leg.strike >= minStrike && leg.strike <= maxStrike) return leg;
    // Clamp to boundary — snap to nearest valid strike
    const clamped = leg.strike < minStrike ? minStrike : maxStrike;
    // Round to standard strike increments
    const step = spotPrice > 200 ? 5 : spotPrice > 50 ? 2.5 : 1;
    const rounded = Math.round(clamped / step) * step;
    return { ...leg, strike: rounded };
  });
}

/**
 * Check if a set of legs would produce penny options (premium < $0.10).
 * Uses distance from spot as a proxy when we don't have live quotes.
 * Returns true if the position likely has adequate premium.
 */
export function hasAdequatePremium(
  legs: TrackedLeg[],
  spotPrice: number,
): boolean {
  // If we already have live prices, check directly
  if (legs.some(l => l.entryMid > 0)) {
    return legs.every(l => l.entryMid === 0 || l.entryMid >= MIN_PREMIUM_PER_CONTRACT);
  }
  // Heuristic: options >1.5 ATR from spot on weekly expirations are likely pennies
  // For now, check that no single-leg trade has strikes >10% from spot
  for (const leg of legs) {
    const distPct = Math.abs(leg.strike - spotPrice) / spotPrice;
    if (distPct > 0.10 && legs.length === 1) return false; // likely penny option
    if (distPct > 0.15) return false; // definitely too far OTM for any strategy
  }
  return true;
}

// ─── Position Sizing ─────────────────────────────────────

const PORTFOLIO_SIZE = 100_000;
const MAX_ALLOCATION_PCT = 0.05; // 5% of portfolio per trade
const MIN_ALLOCATION_PCT = 0.01; // 1% minimum per trade
const MAX_CONTRACTS_SINGLE = 10; // Cap for naked/single-leg (unlimited downside)
const MAX_CONTRACTS_SPREAD = 20; // Higher cap for defined-risk spreads

/**
 * Calculate the per-contract max risk for a given set of legs.
 * Returns the max risk in dollars for ONE contract of the position.
 */
export function maxRiskPerContract(legs: TrackedLeg[], strategy: string, spotPrice: number): number {
  const stratLow = strategy.toLowerCase();
  const strikes = legs.map(l => l.strike).sort((a, b) => a - b);

  // Iron condor: wider wing width × 100
  if (stratLow.includes('iron condor') || stratLow.includes('iron butterfly') || stratLow.includes('iron fly')) {
    if (strikes.length >= 4) {
      const putWing = strikes[1] - strikes[0];
      const callWing = strikes[3] - strikes[2];
      return Math.max(putWing, callWing) * 100;
    }
  }

  // Vertical spreads: width × 100
  if (legs.length >= 2 && strikes.length >= 2) {
    const width = strikes[strikes.length - 1] - strikes[0];
    if (width > 0 && width <= 100) return width * 100;
  }

  // Cash-secured/naked puts: strike × 100
  if ((stratLow.includes('cash') || stratLow.includes('naked') || stratLow.includes('short')) && stratLow.includes('put')) {
    return (strikes[0] || spotPrice) * 100;
  }

  // Single long option: estimate ~3% of spot × 100
  if (legs.length === 1 && legs[0].side === 'long') {
    return spotPrice * 0.03 * 100;
  }

  // Straddle/strangle: ~4% of spot × 100
  if (stratLow.includes('straddle') || stratLow.includes('strangle')) {
    return spotPrice * 0.04 * 100;
  }

  // Fallback: 5% of spot × 100
  return spotPrice * 0.05 * 100;
}

/**
 * Calculate optimal contract quantity for a trade, targeting 1-5% of portfolio.
 * Also enforces minimum position value ($100 per contract notional).
 * Defined-risk spreads allow up to 20 contracts; naked/single-leg capped at 10.
 */
export function sizePosition(legs: TrackedLeg[], strategy: string, spotPrice: number): number {
  const riskPer = maxRiskPerContract(legs, strategy, spotPrice);
  if (riskPer <= 0) return 1;

  // Defined-risk (spreads) can size more aggressively since max loss is capped
  const isDefinedRisk = legs.length >= 2 && legs.some(l => l.side === 'long') && legs.some(l => l.side === 'short');
  const maxContracts = isDefinedRisk ? MAX_CONTRACTS_SPREAD : MAX_CONTRACTS_SINGLE;

  const maxAllocation = PORTFOLIO_SIZE * MAX_ALLOCATION_PCT; // $5,000
  const minAllocation = PORTFOLIO_SIZE * MIN_ALLOCATION_PCT; // $1,000

  // Target: fill up to max allocation
  const targetQty = Math.floor(maxAllocation / riskPer);
  // Floor: at least meet min allocation
  const minQty = Math.ceil(minAllocation / riskPer);

  let qty = Math.max(1, Math.min(maxContracts, Math.max(minQty, targetQty)));

  // Enforce minimum position value: if we have entry prices, check that
  // total position notional per contract ≥ $100 ($1.00 × 100 shares).
  // If premium is too low, reduce qty to 1 (the trade itself is suspect).
  const pricedLegs = legs.filter(l => l.entryMid > 0);
  if (pricedLegs.length > 0) {
    const avgMid = pricedLegs.reduce((s, l) => s + l.entryMid, 0) / pricedLegs.length;
    if (avgMid < MIN_PREMIUM_PER_CONTRACT) {
      // Penny options — sizing won't help, just use 1 contract
      qty = 1;
    }
  }

  return qty;
}

// ─── Retroactive Resizing ─────────────────────────────────

/**
 * Resize all open trades that still have qty=1 to portfolio-appropriate sizes.
 * Returns the number of trades resized.
 */
export function resizeExistingTrades(): number {
  const trades = loadTrackedTrades();
  let resized = 0;
  for (const t of trades) {
    if (t.status !== 'pending' && t.status !== 'entered') continue;
    const allQtyOne = t.legs.length > 0 && t.legs.every(l => l.quantity === 1);
    if (!allQtyOne) continue;

    const optimalQty = sizePosition(t.legs, t.strategy, t.spotAtEntry);
    if (optimalQty > 1) {
      t.legs = t.legs.map(l => ({ ...l, quantity: optimalQty }));
      // Recalculate maxRisk and entryDebit with new quantity
      t.maxRisk = calculateMaxRisk(t.legs, t.strategy, t.spotAtEntry);
      if (t.entryDebit !== null) {
        t.entryDebit = calculatePositionValue(t.legs, 'entry');
      }
      // Clear stale price history (values were for qty=1)
      t.priceHistory = [];
      resized++;
    }
  }
  if (resized > 0) {
    saveTrackedTrades(trades);
  }
  return resized;
}

// ─── Purge Helpers ────────────────────────────────────────

/**
 * Remove all closed/expired/exited trades from localStorage and server.
 * Returns only the remaining open trades.
 */
export function purgeClosedTrades(): TrackedTrade[] {
  const all = loadTrackedTrades();
  const open = all.filter(t => t.status === 'pending' || t.status === 'entered');
  saveTrackedTrades(open);
  return open;
}

/**
 * Remove ALL tracked trades (full reset).
 * Sets a purge timestamp so loadTrackedTradesWithSync won't resurrect server data.
 */
export function purgeAllTrades(): TrackedTrade[] {
  if (typeof window === 'undefined') return [];
  localStorage.setItem(STORAGE_KEY, '[]');
  // Set lastSave to NOW so the 10s skip + 5-minute protection both apply
  localStorage.setItem(STORAGE_KEY + ':lastSave', String(Date.now()));
  // Record that a purge happened — loadTrackedTradesWithSync will respect this
  localStorage.setItem(STORAGE_KEY + ':purgedAt', String(Date.now()));
  localStorage.removeItem(STORAGE_KEY + ':deletedIds');
  syncTrackedTradesToServer([]).catch(() => {});
  return [];
}

// ─── Paper Position Close Helper ──────────────────────────

/**
 * Close all paper positions for a tracked trade's legs.
 * Best-effort: silently ignores failures (position may not exist on Tradier).
 */
export async function closePaperPositions(trade: TrackedTrade): Promise<void> {
  if (typeof window === 'undefined') return;
  for (const leg of trade.legs) {
    if (!leg.optionSymbol) continue;
    const quantity = leg.quantity * (leg.side === 'long' ? 1 : -1);
    try {
      await fetch('/api/paper/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: leg.optionSymbol, quantity }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best effort — position may not exist, may be already closed, or sandbox may be down
    }
  }
}

/**
 * Mark a paper trade rule as triggered (so PaperMonitor won't double-close).
 */
export function markPaperRuleTriggered(trade: TrackedTrade, trigger: 'target' | 'stop'): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem('optix-paper-rules');
    if (!raw) return;
    const rules = JSON.parse(raw) as Array<{
      id: string;
      occSymbols?: string[];
      exitTriggered?: string | null;
      [key: string]: unknown;
    }>;
    // Find matching rule by OCC symbols overlap
    const tradeOCCs = new Set(trade.legs.map(l => l.optionSymbol));
    const idx = rules.findIndex(r =>
      r.occSymbols?.some(s => tradeOCCs.has(s))
    );
    if (idx >= 0) {
      rules[idx].exitTriggered = trigger;
      localStorage.setItem('optix-paper-rules', JSON.stringify(rules));
    }
  } catch {}
}
