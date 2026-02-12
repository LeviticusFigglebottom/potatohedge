export const maxDuration = 15;

/**
 * Diagnostics API — MCP-accessible endpoint for monitoring, debugging, and acting on the dashboard.
 *
 * GET /api/diagnostics?check=health       — Overall system health
 * GET /api/diagnostics?check=trades       — Tracked trades data + quality issues
 * GET /api/diagnostics?check=analytics    — Strategy performance breakdowns
 * GET /api/diagnostics?check=errors       — Recent error log
 * GET /api/diagnostics?check=errors&severity=error&source=polygon&limit=20
 * GET /api/diagnostics?check=apis         — External API connectivity test
 * GET /api/diagnostics?check=trade&id=... — Deep inspect a single trade
 *
 * POST /api/diagnostics  { action: 'log-error', ... }       — Log client-side error
 * POST /api/diagnostics  { action: 'trigger-eval', ... }    — Trigger evaluation cycle
 * POST /api/diagnostics  { action: 'fix-trade', id, fixes } — Fix a specific trade
 * POST /api/diagnostics  { action: 'clear-expired' }        — Remove expired/stale trades
 * POST /api/diagnostics  { action: 'clear-errors' }         — Clear error log
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadHistory, getPersistenceStatus, testConnection } from '@/lib/persistence';
import {
  getRecentErrors,
  getErrorSummary,
  logError,
  clearErrors,
  type ErrorSeverity,
  type ErrorSource,
} from '@/lib/errorLogger';

// ─── GET Handler ──────────────────────────────────────────

export async function GET(request: NextRequest) {
  const check = request.nextUrl.searchParams.get('check') || 'health';

  try {
    switch (check) {
      case 'health':
        return NextResponse.json(await getHealth());

      case 'trades':
        return NextResponse.json(await getTradesReport());

      case 'analytics':
        return NextResponse.json(await getAnalyticsReport());

      case 'errors': {
        const severity = request.nextUrl.searchParams.get('severity') as ErrorSeverity | null;
        const source = request.nextUrl.searchParams.get('source') as ErrorSource | null;
        const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50', 10);
        const since = request.nextUrl.searchParams.get('since');
        return NextResponse.json({
          summary: getErrorSummary(),
          entries: getRecentErrors({
            limit,
            severity: severity || undefined,
            source: source || undefined,
            since: since ? parseInt(since, 10) : undefined,
          }),
        });
      }

      case 'apis':
        return NextResponse.json(await testApis());

      case 'trade': {
        const id = request.nextUrl.searchParams.get('id');
        if (!id) return NextResponse.json({ error: 'id parameter required' }, { status: 400 });
        return NextResponse.json(await inspectTrade(id));
      }

      default:
        return NextResponse.json({ error: `Unknown check: ${check}` }, { status: 400 });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── POST Handler ─────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body as { action: string };

    switch (action) {
      case 'log-error': {
        const { severity, source, message, context } = body;
        const entry = logError(
          severity || 'error',
          source || 'client',
          message || 'Unknown error',
          context
        );
        return NextResponse.json({ ok: true, entry });
      }

      case 'clear-errors':
        clearErrors();
        return NextResponse.json({ ok: true, message: 'Error log cleared' });

      case 'clear-expired':
        return NextResponse.json(await clearExpiredTrades());

      case 'fix-trade': {
        const { id, fixes } = body;
        if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
        return NextResponse.json(await fixTrade(id, fixes));
      }

      case 'force-evaluate':
        return NextResponse.json(await forceEvaluateTrades());

      case 'force-close': {
        const { id: closeId, reason } = body;
        if (!closeId) return NextResponse.json({ error: 'id required' }, { status: 400 });
        return NextResponse.json(await forceCloseTrade(closeId, reason || 'manual-close'));
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── Health Check ─────────────────────────────────────────

async function getHealth() {
  const persistence = getPersistenceStatus();
  const connected = await testConnection();
  const errorSummary = getErrorSummary();

  // Load tracked trades from server
  const trades = await loadTrackedTradesFromServer();

  const openTrades = trades.filter(t => t.status === 'pending' || t.status === 'entered');
  const unpricedTrades = openTrades.filter(t => !t.entryDebit || t.entryDebit === 0);
  const expiredNotClosed = trades.filter(t => {
    if (t.status === 'exited' || t.status === 'expired') return false;
    const expDate = new Date(t.expirationDate + 'T16:00:00-05:00').getTime();
    return Date.now() > expDate;
  });

  // Data quality checks
  const issues: string[] = [];
  if (!connected) issues.push('No persistence backend connected (Redis/Blob)');
  if (unpricedTrades.length > 0) issues.push(`${unpricedTrades.length} trades awaiting entry pricing`);
  if (expiredNotClosed.length > 0) issues.push(`${expiredNotClosed.length} trades past expiration but not closed`);
  if (errorSummary.recentCritical.length > 0) issues.push(`${errorSummary.recentCritical.length} critical errors in last hour`);

  // Check for trades with suspicious data
  const badLegs = trades.filter(t => t.legs.length === 0 || t.legs.some(l => !l.optionSymbol));
  if (badLegs.length > 0) issues.push(`${badLegs.length} trades with missing/invalid leg data`);

  const status = issues.length === 0 ? 'healthy' : issues.some(i => i.includes('critical')) ? 'critical' : 'degraded';

  return {
    status,
    timestamp: Date.now(),
    persistence: { ...persistence, connected },
    trades: {
      total: trades.length,
      open: openTrades.length,
      pending: trades.filter(t => t.status === 'pending').length,
      entered: trades.filter(t => t.status === 'entered').length,
      exited: trades.filter(t => t.status === 'exited').length,
      expired: trades.filter(t => t.status === 'expired').length,
      unpriced: unpricedTrades.length,
      expiredNotClosed: expiredNotClosed.length,
    },
    errors: errorSummary,
    issues,
    apis: {
      tradier: !!process.env.TRADIER_API_KEY,
      polygon: !!process.env.POLYGON_API_KEY,
      claude: !!process.env.ANTHROPIC_API_KEY,
    },
  };
}

// ─── Trades Report ────────────────────────────────────────

async function getTradesReport() {
  const trades = await loadTrackedTradesFromServer();

  // Data quality analysis
  const qualityIssues: { tradeId: string; symbol: string; strategy: string; issues: string[] }[] = [];

  for (const t of trades) {
    const issues: string[] = [];

    // Check legs
    if (t.legs.length === 0) issues.push('No legs');
    for (const leg of t.legs) {
      if (!leg.optionSymbol) issues.push(`Leg missing OCC symbol`);
      if (leg.entryMid === 0 && (t.status === 'entered' || t.status === 'exited')) {
        issues.push(`Leg ${leg.optionSymbol || 'unknown'} has zero entry price despite status=${t.status}`);
      }
      if (leg.side !== 'long' && leg.side !== 'short') issues.push(`Leg ${leg.optionSymbol || 'unknown'} has invalid side: ${leg.side}`);
    }

    // Check pricing
    if (t.status === 'entered' && (!t.entryDebit || t.entryDebit === 0)) {
      issues.push('Entered but entryDebit is 0/null');
    }

    // Check for phantom P/L
    if (t.realizedPLPct !== null && Math.abs(t.realizedPLPct) > 500) {
      issues.push(`Suspicious P/L: ${t.realizedPLPct.toFixed(1)}% — possible pricing error`);
    }

    // Check max risk
    if (!t.maxRisk || t.maxRisk <= 0) issues.push('Missing max risk calculation');

    if (issues.length > 0) {
      qualityIssues.push({ tradeId: t.id, symbol: t.symbol, strategy: t.strategy, issues });
    }
  }

  return {
    total: trades.length,
    trades: trades.map(t => ({
      id: t.id,
      symbol: t.symbol,
      strategy: t.strategy,
      direction: t.direction,
      source: t.source,
      status: t.status,
      outcome: t.outcome,
      legs: t.legs.length,
      entryDebit: t.entryDebit,
      exitValue: t.exitValue,
      realizedPL: t.realizedPL,
      realizedPLPct: t.realizedPLPct,
      maxRisk: t.maxRisk,
      priceHistoryPoints: t.priceHistory.length,
      trackedAt: new Date(t.trackedAt).toISOString(),
      expirationDate: t.expirationDate,
    })),
    qualityIssues,
  };
}

// ─── Analytics Report ─────────────────────────────────────

async function getAnalyticsReport() {
  const trades = await loadTrackedTradesFromServer();
  const closed = trades.filter(t => t.status === 'exited' || t.status === 'expired');

  const wins = closed.filter(t => t.outcome === 'win');
  const losses = closed.filter(t => t.outcome === 'loss');

  // Strategy performance
  const byStrategy: Record<string, { count: number; wins: number; losses: number; totalPL: number; avgPL: number; winRate: number }> = {};
  for (const t of closed) {
    if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { count: 0, wins: 0, losses: 0, totalPL: 0, avgPL: 0, winRate: 0 };
    const s = byStrategy[t.strategy];
    s.count++;
    if (t.outcome === 'win') s.wins++;
    if (t.outcome === 'loss') s.losses++;
    s.totalPL += t.realizedPL ?? 0;
  }
  for (const key of Object.keys(byStrategy)) {
    const s = byStrategy[key];
    s.avgPL = s.count > 0 ? s.totalPL / s.count : 0;
    s.winRate = (s.wins + s.losses) > 0 ? s.wins / (s.wins + s.losses) : 0;
  }

  // Source performance
  const bySource: Record<string, { count: number; wins: number; losses: number; totalPL: number; winRate: number }> = {};
  for (const t of closed) {
    if (!bySource[t.source]) bySource[t.source] = { count: 0, wins: 0, losses: 0, totalPL: 0, winRate: 0 };
    const s = bySource[t.source];
    s.count++;
    if (t.outcome === 'win') s.wins++;
    if (t.outcome === 'loss') s.losses++;
    s.totalPL += t.realizedPL ?? 0;
  }
  for (const key of Object.keys(bySource)) {
    const s = bySource[key];
    s.winRate = (s.wins + s.losses) > 0 ? s.wins / (s.wins + s.losses) : 0;
  }

  // Direction performance
  const byDirection: Record<string, { count: number; wins: number; totalPL: number; winRate: number }> = {};
  for (const t of closed) {
    if (!byDirection[t.direction]) byDirection[t.direction] = { count: 0, wins: 0, totalPL: 0, winRate: 0 };
    const d = byDirection[t.direction];
    d.count++;
    if (t.outcome === 'win') d.wins++;
    d.totalPL += t.realizedPL ?? 0;
  }
  for (const key of Object.keys(byDirection)) {
    const d = byDirection[key];
    d.winRate = d.count > 0 ? d.wins / d.count : 0;
  }

  return {
    overview: {
      totalTracked: trades.length,
      open: trades.filter(t => t.status === 'pending' || t.status === 'entered').length,
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length + losses.length) > 0 ? (wins.length / (wins.length + losses.length) * 100).toFixed(1) + '%' : 'N/A',
      totalPL: closed.reduce((s, t) => s + (t.realizedPL ?? 0), 0),
      avgPL: closed.length > 0 ? closed.reduce((s, t) => s + (t.realizedPL ?? 0), 0) / closed.length : 0,
    },
    byStrategy,
    bySource,
    byDirection,
    recommendations: generateRecommendations(trades, byStrategy, bySource),
  };
}

function generateRecommendations(
  trades: ServerTrade[],
  byStrategy: Record<string, { count: number; wins: number; winRate: number; avgPL: number }>,
  bySource: Record<string, { count: number; wins: number; winRate: number }>
): string[] {
  const recs: string[] = [];

  // Find best/worst strategies
  const strategies = Object.entries(byStrategy).filter(([, s]) => s.count >= 3);
  const bestStrat = strategies.sort((a, b) => b[1].winRate - a[1].winRate)[0];
  const worstStrat = strategies.sort((a, b) => a[1].winRate - b[1].winRate)[0];

  if (bestStrat && bestStrat[1].winRate > 0.6) {
    recs.push(`Best performing strategy: "${bestStrat[0]}" with ${(bestStrat[1].winRate * 100).toFixed(0)}% win rate over ${bestStrat[1].count} trades`);
  }
  if (worstStrat && worstStrat[1].winRate < 0.4 && worstStrat[1].count >= 3) {
    recs.push(`Worst performing strategy: "${worstStrat[0]}" with ${(worstStrat[1].winRate * 100).toFixed(0)}% win rate — consider reducing allocation`);
  }

  // Source comparison
  const sources = Object.entries(bySource).filter(([, s]) => s.count >= 3);
  if (sources.length > 1) {
    const best = sources.sort((a, b) => b[1].winRate - a[1].winRate)[0];
    recs.push(`Most reliable source: "${best[0]}" with ${(best[1].winRate * 100).toFixed(0)}% win rate`);
  }

  // Data quality
  const unpriced = trades.filter(t => (t.status === 'pending' || t.status === 'entered') && (!t.entryDebit || t.entryDebit === 0));
  if (unpriced.length > 0) {
    recs.push(`${unpriced.length} open trades still awaiting entry pricing — TrackerMonitor may not be running during market hours`);
  }

  return recs;
}

// ─── API Connectivity Test ────────────────────────────────

async function testApis() {
  const results: Record<string, { available: boolean; latencyMs?: number; error?: string }> = {};

  // Tradier
  const tradierKey = process.env.TRADIER_API_KEY;
  if (tradierKey) {
    const start = Date.now();
    try {
      const baseUrl = process.env.TRADIER_SANDBOX === 'true'
        ? 'https://sandbox.tradier.com/v1'
        : 'https://api.tradier.com/v1';
      const res = await fetch(`${baseUrl}/markets/quotes?symbols=SPY&greeks=false`, {
        headers: { Authorization: `Bearer ${tradierKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      results.tradier = { available: res.ok, latencyMs: Date.now() - start };
      if (!res.ok) results.tradier.error = `HTTP ${res.status}`;
    } catch (e) {
      results.tradier = { available: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : 'Unknown' };
    }
  } else {
    results.tradier = { available: false, error: 'TRADIER_API_KEY not set' };
  }

  // Polygon
  const polygonKey = process.env.POLYGON_API_KEY;
  if (polygonKey) {
    const start = Date.now();
    try {
      const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/prev?apiKey=${polygonKey}`, {
        signal: AbortSignal.timeout(5000),
      });
      results.polygon = { available: res.ok, latencyMs: Date.now() - start };
      if (!res.ok) results.polygon.error = `HTTP ${res.status}`;
    } catch (e) {
      results.polygon = { available: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : 'Unknown' };
    }
  } else {
    results.polygon = { available: false, error: 'POLYGON_API_KEY not set' };
  }

  // Anthropic (Claude)
  results.anthropic = {
    available: !!process.env.ANTHROPIC_API_KEY,
    error: process.env.ANTHROPIC_API_KEY ? undefined : 'ANTHROPIC_API_KEY not set',
  };

  // Persistence — test each backend individually with detail
  const persistence = getPersistenceStatus();

  // Redis
  if (persistence.redis) {
    const start = Date.now();
    try {
      const redis = await import('@/lib/persistence').then(m => m.testConnection());
      results.redis = { available: redis, latencyMs: Date.now() - start };
      if (!redis) results.redis.error = 'Ping failed — check UPSTASH_REDIS_REST_URL/TOKEN';
    } catch (e) {
      results.redis = { available: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : 'Unknown' };
    }
  } else {
    results.redis = { available: false, error: 'Not configured (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)' };
  }

  // Blob
  if (persistence.blob) {
    const start = Date.now();
    try {
      const { list } = await import('@vercel/blob');
      await list({ prefix: 'optix-history/', limit: 1 });
      results.blob = { available: true, latencyMs: Date.now() - start };
    } catch (e) {
      results.blob = { available: false, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : 'Unknown' };
    }
  } else {
    results.blob = { available: false, error: 'Not configured (set BLOB_READ_WRITE_TOKEN). Optional if Redis is active.' };
  }

  // Overall persistence
  results.persistence = {
    available: (results.redis?.available || results.blob?.available) ?? false,
    error: (!results.redis?.available && !results.blob?.available) ? 'No persistence backend reachable' : undefined,
  };

  // Market hours status
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const time = et.getHours() * 60 + et.getMinutes();
  const marketOpen = day >= 1 && day <= 5 && time >= 570 && time <= 975;
  results._marketHours = {
    available: marketOpen,
    error: marketOpen ? undefined : `Market closed (ET: ${et.toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]}). TrackerMonitor is dormant.`,
  };

  return results;
}

// ─── Trade Inspection ─────────────────────────────────────

async function inspectTrade(id: string) {
  const trades = await loadTrackedTradesFromServer();
  const trade = trades.find(t => t.id === id);
  if (!trade) return { error: 'Trade not found', availableIds: trades.map(t => t.id).slice(0, 20) };

  const issues: string[] = [];

  // Validate legs
  for (const leg of trade.legs) {
    if (leg.entryMid === 0 && trade.status !== 'pending') {
      issues.push(`Leg ${leg.optionSymbol}: entry price still 0 despite status=${trade.status}`);
    }
    if (leg.side !== 'long' && leg.side !== 'short') {
      issues.push(`Leg ${leg.optionSymbol}: invalid side "${leg.side}"`);
    }
    // Check OCC symbol format
    const occRegex = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
    if (!occRegex.test(leg.optionSymbol)) {
      issues.push(`Leg ${leg.optionSymbol}: invalid OCC symbol format`);
    }
  }

  // Check pricing consistency
  if (trade.entryDebit !== null && trade.entryDebit !== 0) {
    const calculatedEntry = trade.legs.reduce((sum, leg) => {
      const multiplier = leg.side === 'long' ? 1 : -1;
      return sum + leg.entryMid * multiplier * leg.quantity * 100;
    }, 0);
    if (Math.abs(calculatedEntry - trade.entryDebit) > 1) {
      issues.push(`Entry debit mismatch: stored=${trade.entryDebit.toFixed(2)}, calculated from legs=${calculatedEntry.toFixed(2)}`);
    }
  }

  return {
    trade,
    issues,
    priceHistoryLength: trade.priceHistory.length,
    lastPriceSnapshot: trade.priceHistory.length > 0 ? trade.priceHistory[trade.priceHistory.length - 1] : null,
    ageMinutes: Math.round((Date.now() - trade.trackedAt) / 60000),
    daysToExpiry: Math.max(0, Math.round((new Date(trade.expirationDate + 'T16:00:00-05:00').getTime() - Date.now()) / 86400000)),
  };
}

// ─── Trade Fix ────────────────────────────────────────────

async function fixTrade(id: string, fixes: Record<string, unknown>) {
  // This operates on server-side data. Client needs to reload from server.
  const trades = await loadTrackedTradesFromServer();
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) return { error: 'Trade not found' };

  const original = { ...trades[idx] };

  // Apply allowed fixes
  const allowedFields = ['status', 'entryDebit', 'exitValue', 'maxRisk', 'outcome', 'realizedPL', 'realizedPLPct', 'exitReason', 'notes'];
  const applied: string[] = [];
  for (const [key, value] of Object.entries(fixes)) {
    if (allowedFields.includes(key)) {
      (trades[idx] as Record<string, unknown>)[key] = value;
      applied.push(key);
    }
  }

  if (applied.length === 0) return { error: 'No valid fixes provided', allowedFields };

  // Save back to server
  const { saveHistoryBulk } = await import('@/lib/persistence');
  const records = trades.map(t => ({
    ...t,
    date: t.id,
    timestamp: t.trackedAt,
  }));
  await saveHistoryBulk('optix:tracked-trades:all', records);

  return { ok: true, tradeId: id, applied, before: pick(original, applied), after: pick(trades[idx], applied) };
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of keys) result[k] = obj[k];
  return result;
}

// ─── Clear Expired Trades ─────────────────────────────────

async function clearExpiredTrades() {
  const trades = await loadTrackedTradesFromServer();
  const now = Date.now();

  // Find trades that are past expiration but still open
  const toExpire = trades.filter(t => {
    if (t.status === 'exited' || t.status === 'expired') return false;
    const expDate = new Date(t.expirationDate + 'T16:00:00-05:00').getTime();
    return now > expDate;
  });

  if (toExpire.length === 0) return { ok: true, message: 'No expired trades to clean up', total: trades.length };

  // Mark them as expired
  for (const t of toExpire) {
    t.status = 'expired' as ServerTrade['status'];
    t.exitedAt = now;
    t.exitReason = 'expiration';
    if (t.outcome === null) t.outcome = 'loss';
  }

  // Save back
  const { saveHistoryBulk } = await import('@/lib/persistence');
  const records = trades.map(t => ({
    ...t,
    date: t.id,
    timestamp: t.trackedAt,
  }));
  await saveHistoryBulk('optix:tracked-trades:all', records);

  return { ok: true, expired: toExpire.length, total: trades.length, expiredIds: toExpire.map(t => t.id) };
}

// ─── Helpers ──────────────────────────────────────────────

interface ServerTrade {
  id: string;
  source: string;
  symbol: string;
  strategy: string;
  direction: string;
  status: 'pending' | 'entered' | 'exited' | 'expired';
  outcome: 'win' | 'loss' | 'breakeven' | null;
  legs: Array<{
    optionSymbol: string;
    optionType: string;
    strike: number;
    expiration: string;
    side: 'long' | 'short';
    quantity: number;
    entryMid: number;
    exitMid: number | null;
    entryBid: number;
    entryAsk: number;
    exitBid: number | null;
    exitAsk: number | null;
    entryDelta: number;
    entryGamma: number;
    entryTheta: number;
    entryVega: number;
    entryIV: number;
  }>;
  entryDebit: number | null;
  exitValue: number | null;
  realizedPL: number | null;
  realizedPLPct: number | null;
  maxRisk: number | null;
  confidence: string;
  score: number;
  trackedAt: number;
  enteredAt: number | null;
  exitedAt: number | null;
  expirationDate: string;
  priceHistory: { timestamp: number; spotPrice: number; positionValue: number }[];
  exitReason: string | null;
  spotAtEntry: number;
  spotAtExit: number | null;
  reasoning: string[];
  tags: string[];
  notes: string;
  [key: string]: unknown;
}

async function loadTrackedTradesFromServer(): Promise<ServerTrade[]> {
  try {
    const data = await loadHistory<ServerTrade & { date: string; timestamp: number }>(
      'optix:tracked-trades:all',
      365
    );
    return data || [];
  } catch {
    return [];
  }
}

async function saveTrackedTradesToServer(trades: ServerTrade[]): Promise<void> {
  const { saveHistoryBulk } = await import('@/lib/persistence');
  const records = trades.map(t => ({ ...t, date: t.id, timestamp: t.trackedAt }));
  await saveHistoryBulk('optix:tracked-trades:all', records);
}

// ─── Server-side price fetch ─────────────────────────────

async function fetchLivePrices(
  occSymbols: string[],
  underlying: string
): Promise<{
  quotes: Record<string, { bid: number; ask: number; mid: number }>;
  spot: number | null;
}> {
  const token = process.env.TRADIER_API_KEY;
  if (!token) return { quotes: {}, spot: null };

  const baseUrl = process.env.TRADIER_SANDBOX === 'true'
    ? 'https://sandbox.tradier.com/v1'
    : 'https://api.tradier.com/v1';

  const allSymbols = [...occSymbols, underlying].join(',');
  const res = await fetch(
    `${baseUrl}/markets/quotes?symbols=${encodeURIComponent(allSymbols)}&greeks=false`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) throw new Error(`Tradier HTTP ${res.status}`);

  const data = await res.json();
  const rawQuotes = data.quotes?.quote;
  if (!rawQuotes) return { quotes: {}, spot: null };

  const arr = Array.isArray(rawQuotes) ? rawQuotes : [rawQuotes];
  const quotes: Record<string, { bid: number; ask: number; mid: number }> = {};
  let spot: number | null = null;

  for (const q of arr) {
    if (!q.symbol) continue;
    if (q.symbol.toUpperCase() === underlying.toUpperCase()) {
      spot = q.last ?? q.bid ?? 0;
      continue;
    }
    const bid = q.bid ?? 0;
    const ask = q.ask ?? 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : q.last ?? 0;
    quotes[q.symbol] = { bid, ask, mid };
  }
  return { quotes, spot };
}

// ─── Server-side position math ───────────────────────────

function calcPositionValue(
  legs: ServerTrade['legs'],
  mode: 'entry' | 'exit'
): number {
  let value = 0;
  for (const leg of legs) {
    const mid = mode === 'entry' ? leg.entryMid : (leg.exitMid ?? leg.entryMid);
    const multiplier = leg.side === 'long' ? 1 : -1;
    value += mid * multiplier * leg.quantity * 100;
  }
  return value;
}

// ─── Force-evaluate all open trades (works outside market hours) ──

async function forceEvaluateTrades() {
  const trades = await loadTrackedTradesFromServer();
  const openTrades = trades.filter(t => t.status === 'pending' || t.status === 'entered');
  if (openTrades.length === 0) return { ok: true, message: 'No open trades to evaluate', total: trades.length };

  const results: { tradeId: string; symbol: string; action: string; detail: string }[] = [];
  const errors: { tradeId: string; error: string }[] = [];

  // Group by underlying
  const byUnderlying = new Map<string, ServerTrade[]>();
  for (const t of openTrades) {
    const arr = byUnderlying.get(t.symbol) || [];
    arr.push(t);
    byUnderlying.set(t.symbol, arr);
  }

  for (const [underlying, underlyingTrades] of byUnderlying) {
    const occSymbols = new Set<string>();
    for (const t of underlyingTrades) {
      for (const leg of t.legs) {
        if (leg.optionSymbol) occSymbols.add(leg.optionSymbol);
      }
    }
    if (occSymbols.size === 0) continue;

    let quotes: Record<string, { bid: number; ask: number; mid: number }>;
    let spot: number | null;
    try {
      ({ quotes, spot } = await fetchLivePrices([...occSymbols], underlying));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      for (const t of underlyingTrades) errors.push({ tradeId: t.id, error: `Price fetch failed: ${msg}` });
      continue;
    }

    const currentSpot = spot ?? 0;

    for (const trade of underlyingTrades) {
      try {
        const idx = trades.findIndex(t => t.id === trade.id);
        if (idx === -1) continue;
        const now = Date.now();

        // Check expiration
        const expDate = new Date(trade.expirationDate + 'T16:00:00-05:00').getTime();
        if (now >= expDate) {
          const exitLegs = trade.legs.map(leg => {
            const price = quotes[leg.optionSymbol];
            return { ...leg, exitBid: price?.bid ?? 0, exitAsk: price?.ask ?? 0, exitMid: price?.mid ?? 0 };
          });
          const exitValue = calcPositionValue(exitLegs, 'exit');
          const entryValue = trade.entryDebit ?? calcPositionValue(trade.legs, 'entry');
          const pl = exitValue - entryValue;
          const plPct = trade.maxRisk && trade.maxRisk !== 0 ? (pl / Math.abs(trade.maxRisk)) * 100 : 0;

          trades[idx] = {
            ...trades[idx],
            status: 'expired',
            exitedAt: now,
            spotAtExit: currentSpot,
            legs: exitLegs,
            exitValue,
            realizedPL: pl,
            realizedPLPct: plPct,
            exitReason: 'expiration',
            outcome: pl > 0.5 ? 'win' : pl < -0.5 ? 'loss' : 'breakeven',
          };
          results.push({
            tradeId: trade.id, symbol: underlying, action: 'expired',
            detail: `${trade.strategy}${trade.expirationDate ? ` (${trade.expirationDate})` : ''} — expired with P/L $${pl.toFixed(2)} (${plPct.toFixed(1)}%)`,
          });
          continue;
        }

        // Pending → entered
        let justEntered = false;
        if (trade.status === 'pending') {
          const entryLegs = trade.legs.map(leg => {
            const price = quotes[leg.optionSymbol];
            if (price && price.mid > 0) {
              return { ...leg, entryBid: price.bid, entryAsk: price.ask, entryMid: price.mid };
            }
            return leg;
          });
          const entryValue = calcPositionValue(entryLegs, 'entry');
          trades[idx] = {
            ...trades[idx],
            status: 'entered',
            enteredAt: now,
            legs: entryLegs,
            entryDebit: entryValue,
          };
          justEntered = true;
        }

        // Evaluate entered trades for profit/stop
        const activeTrade = trades[idx];
        if (activeTrade.status === 'entered') {
          const currentLegs = activeTrade.legs.map(leg => {
            const price = quotes[leg.optionSymbol];
            return { ...leg, exitBid: price?.bid ?? 0, exitAsk: price?.ask ?? 0, exitMid: price?.mid ?? 0 };
          });
          const currentValue = calcPositionValue(currentLegs, 'exit');
          const entryValue = activeTrade.entryDebit ?? calcPositionValue(activeTrade.legs, 'entry');
          const unrealizedPL = currentValue - entryValue;
          const plPct = activeTrade.maxRisk && activeTrade.maxRisk !== 0
            ? (unrealizedPL / Math.abs(activeTrade.maxRisk)) * 100 : 0;

          // Price snapshot
          const snapshot = { timestamp: now, spotPrice: currentSpot, positionValue: currentValue };
          const priceHistory = [...(activeTrade.priceHistory || []), snapshot].slice(-100);

          const profitTarget = (activeTrade as Record<string, unknown>).profitTargetPct as number ?? 50;
          const stopLoss = (activeTrade as Record<string, unknown>).stopLossPct as number ?? 100;

          const label = `${trade.strategy}${trade.expirationDate ? ` (${trade.expirationDate})` : ''}`;

          if (plPct >= profitTarget) {
            trades[idx] = {
              ...trades[idx], status: 'exited', exitedAt: now, spotAtExit: currentSpot,
              legs: currentLegs, exitValue: currentValue, realizedPL: unrealizedPL,
              realizedPLPct: plPct, exitReason: 'profit-target', outcome: 'win', priceHistory,
            };
            results.push({
              tradeId: trade.id, symbol: underlying, action: 'profit-target',
              detail: `${label} — hit profit target: $${unrealizedPL.toFixed(2)} (${plPct.toFixed(1)}%)`,
            });
          } else if (plPct <= -stopLoss) {
            trades[idx] = {
              ...trades[idx], status: 'exited', exitedAt: now, spotAtExit: currentSpot,
              legs: currentLegs, exitValue: currentValue, realizedPL: unrealizedPL,
              realizedPLPct: plPct, exitReason: 'stop-loss', outcome: 'loss', priceHistory,
            };
            results.push({
              tradeId: trade.id, symbol: underlying, action: 'stop-loss',
              detail: `${label} — hit stop loss: $${unrealizedPL.toFixed(2)} (${plPct.toFixed(1)}%)`,
            });
          } else {
            trades[idx] = { ...trades[idx], priceHistory };
            results.push({
              tradeId: trade.id, symbol: underlying,
              action: justEntered ? 'entered' : 'priced',
              detail: justEntered
                ? `${label} — filled entry at $${entryValue.toFixed(2)}, current P/L: $${unrealizedPL.toFixed(2)} (${plPct.toFixed(1)}%)`
                : `${label} — unrealized P/L: $${unrealizedPL.toFixed(2)} (${plPct.toFixed(1)}%)`,
            });
          }
        }
      } catch (e) {
        errors.push({ tradeId: trade.id, error: e instanceof Error ? e.message : 'Unknown' });
      }
    }
  }

  await saveTrackedTradesToServer(trades);

  // Close paper positions for any trades that just exited (profit target, stop loss, expiration)
  const exitedTradeIds = results.filter(r =>
    r.action === 'profit-target' || r.action === 'stop-loss' || r.action === 'expired'
  ).map(r => r.tradeId);
  const paperCloseCount = await closePaperPositionsForTrades(trades, exitedTradeIds);

  return {
    ok: true,
    evaluated: openTrades.length,
    total: trades.length,
    results,
    errors: errors.length > 0 ? errors : undefined,
    paperPositionsClosed: paperCloseCount > 0 ? paperCloseCount : undefined,
  };
}

async function closePaperPositionsForTrades(trades: ServerTrade[], tradeIds: string[]): Promise<number> {
  if (tradeIds.length === 0 || !process.env.TRADIER_SANDBOX_KEY) return 0;
  let closed = 0;
  try {
    const { closePosition, parseOCCSymbol } = await import('@/lib/providers/tradierPaper');
    for (const tradeId of tradeIds) {
      const trade = trades.find(t => t.id === tradeId);
      if (!trade) continue;
      for (const leg of trade.legs) {
        if (!leg.optionSymbol) continue;
        const parsed = parseOCCSymbol(leg.optionSymbol);
        const underlying = parsed?.underlying || trade.symbol;
        const qty = leg.quantity * (leg.side === 'long' ? 1 : -1);
        try {
          await closePosition(underlying, leg.optionSymbol, qty);
          closed++;
        } catch {
          // Best effort — position may not exist
        }
      }
    }
  } catch {
    // Import or general error
  }
  return closed;
}

// ─── Force-close a single trade with live pricing ────────

async function forceCloseTrade(id: string, reason: string) {
  const trades = await loadTrackedTradesFromServer();
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) return { error: 'Trade not found' };

  const trade = trades[idx];
  if (trade.status === 'exited' || trade.status === 'expired') {
    return { error: `Trade already ${trade.status}` };
  }

  const now = Date.now();

  // Try to get live prices for proper exit
  const occSymbols = trade.legs.map(l => l.optionSymbol).filter(Boolean);
  let exitLegs = trade.legs;
  let currentSpot = 0;

  if (occSymbols.length > 0) {
    try {
      const { quotes, spot } = await fetchLivePrices(occSymbols, trade.symbol);
      currentSpot = spot ?? 0;
      exitLegs = trade.legs.map(leg => {
        const price = quotes[leg.optionSymbol];
        return { ...leg, exitBid: price?.bid ?? 0, exitAsk: price?.ask ?? 0, exitMid: price?.mid ?? 0 };
      });
    } catch {
      // Use zero exit prices — better than staying stuck open
      exitLegs = trade.legs.map(leg => ({ ...leg, exitBid: 0, exitAsk: 0, exitMid: 0 }));
    }
  }

  const exitValue = calcPositionValue(exitLegs, 'exit');
  const entryValue = trade.entryDebit ?? calcPositionValue(trade.legs, 'entry');
  const pl = exitValue - entryValue;
  const plPct = trade.maxRisk && trade.maxRisk !== 0 ? (pl / Math.abs(trade.maxRisk)) * 100 : 0;

  const isExpiration = reason === 'expiration';
  trades[idx] = {
    ...trades[idx],
    status: isExpiration ? 'expired' : 'exited',
    exitedAt: now,
    spotAtExit: currentSpot,
    legs: exitLegs,
    exitValue,
    realizedPL: pl,
    realizedPLPct: plPct,
    exitReason: reason,
    outcome: pl > 0.5 ? 'win' : pl < -0.5 ? 'loss' : 'breakeven',
  };

  await saveTrackedTradesToServer(trades);

  // Also close paper positions on Tradier sandbox (best-effort, server-side)
  const paperCloseResults: { symbol: string; ok: boolean; error?: string }[] = [];
  const sandboxKey = process.env.TRADIER_SANDBOX_KEY;
  if (sandboxKey) {
    try {
      const { closePosition, parseOCCSymbol } = await import('@/lib/providers/tradierPaper');
      for (const leg of trade.legs) {
        if (!leg.optionSymbol) continue;
        const parsed = parseOCCSymbol(leg.optionSymbol);
        const underlying = parsed?.underlying || trade.symbol;
        const qty = leg.quantity * (leg.side === 'long' ? 1 : -1);
        try {
          await closePosition(underlying, leg.optionSymbol, qty);
          paperCloseResults.push({ symbol: leg.optionSymbol, ok: true });
        } catch (e) {
          paperCloseResults.push({ symbol: leg.optionSymbol, ok: false, error: e instanceof Error ? e.message : 'Unknown' });
        }
      }
    } catch (e) {
      paperCloseResults.push({ symbol: '*', ok: false, error: `Import error: ${e instanceof Error ? e.message : 'Unknown'}` });
    }
  }

  return {
    ok: true,
    tradeId: id,
    status: trades[idx].status,
    outcome: trades[idx].outcome,
    realizedPL: pl,
    realizedPLPct: plPct,
    exitValue,
    priced: currentSpot > 0,
    paperPositionsClosed: paperCloseResults.length > 0 ? paperCloseResults : undefined,
  };
}
