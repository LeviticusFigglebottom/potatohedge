'use client';

import { useEffect, useRef, useCallback } from 'react';
import {
  loadTrackedTrades,
  evaluateTrade,
  closePaperPositions,
  markPaperRuleTriggered,
  type TrackedTrade,
} from '@/lib/tradeTracker';

/**
 * Background monitor for tracked AI/algo trade recommendations.
 * Runs at the app level (page.tsx) — checks tracked trades regardless of active tab.
 *
 * During market hours: polls every 90s, fetches live option prices for all open trades,
 * evaluates against profit targets, stop losses, and expiration.
 *
 * Outside market hours: polls every 5 minutes, only checks for expired trades
 * (no live price fetch — Tradier won't return real-time quotes).
 *
 * When a trade exits (profit target, stop loss, expiration), it also:
 * 1. Closes the actual Tradier paper positions (best-effort)
 * 2. Marks the corresponding TradeRule as triggered (prevents PaperMonitor double-close)
 */

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const time = et.getHours() * 60 + et.getMinutes();
  // 9:30 AM - 4:15 PM ET (slightly after close for final settlement)
  return time >= 570 && time <= 975;
}

// Log errors to the diagnostics API for MCP visibility
function logToServer(severity: string, message: string, context?: Record<string, unknown>) {
  fetch('/api/diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'log-error', severity, source: 'tracker-monitor', message, context }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

/**
 * When a tracked trade exits, close paper positions and mark TradeRule as triggered.
 */
async function handleTradeExit(trade: TrackedTrade, trigger: 'target' | 'stop') {
  try {
    await closePaperPositions(trade);
    markPaperRuleTriggered(trade, trigger);
    logToServer('info', `Auto-closed paper positions for ${trade.symbol} ${trade.strategy} — ${trigger}`, {
      tradeId: trade.id, symbol: trade.symbol, strategy: trade.strategy, trigger,
    });
  } catch (e) {
    logToServer('warn', `Failed to close paper positions for ${trade.symbol}: ${e instanceof Error ? e.message : 'Unknown'}`, {
      tradeId: trade.id,
    });
  }
}

export default function TrackerMonitor() {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const afterHoursRef = useRef<NodeJS.Timeout | null>(null);
  const runningRef = useRef(false);

  const evaluateTrackedTrades = useCallback(async () => {
    if (runningRef.current) return;

    const trades = loadTrackedTrades();
    const openTrades = trades.filter(
      (t) => t.status === 'pending' || t.status === 'entered'
    );
    if (openTrades.length === 0) return;

    const marketOpen = isMarketHours();

    // Outside market hours: only handle expired trades (no price fetching)
    if (!marketOpen) {
      const now = Date.now();
      for (const trade of openTrades) {
        const expDate = new Date(trade.expirationDate + 'T16:00:00-05:00').getTime();
        if (now > expDate + 3600000) { // 1 hour past expiration
          // autoExpireStale in loadTrackedTrades already handles marking — just close paper positions
          const freshTrades = loadTrackedTrades();
          const updated = freshTrades.find(t => t.id === trade.id);
          if (updated && (updated.status === 'expired' || updated.status === 'exited')) {
            await handleTradeExit(updated, 'stop');
          }
        }
      }
      return;
    }

    runningRef.current = true;
    try {
      // Group trades by underlying to minimize API calls
      const byUnderlying = new Map<string, TrackedTrade[]>();
      for (const trade of openTrades) {
        const existing = byUnderlying.get(trade.symbol) || [];
        existing.push(trade);
        byUnderlying.set(trade.symbol, existing);
      }

      for (const [underlying, underlyingTrades] of byUnderlying) {
        // Collect all unique OCC symbols for this underlying
        const occSymbols = new Set<string>();
        for (const trade of underlyingTrades) {
          for (const leg of trade.legs) {
            if (leg.optionSymbol) occSymbols.add(leg.optionSymbol);
          }
        }

        if (occSymbols.size === 0) continue;

        // Fetch live prices for all legs + underlying spot price
        try {
          const symbolsParam = [...occSymbols].join(',');
          const res = await fetch(
            `/api/tracker/prices?symbols=${encodeURIComponent(symbolsParam)}&underlying=${encodeURIComponent(underlying)}`,
            { signal: AbortSignal.timeout(10000) }
          );

          if (!res.ok) {
            logToServer('warn', `Price fetch failed for ${underlying}: HTTP ${res.status}`, { underlying, status: res.status });
            continue;
          }

          let data: {
            quotes: Record<string, { bid: number; ask: number; mid: number; last: number }>;
            spot: number | null;
          };
          try {
            data = await res.json();
          } catch (e) {
            logToServer('error', `JSON parse error on price response for ${underlying}`, { underlying, error: String(e) });
            continue;
          }

          const currentSpot = data.spot ?? 0;
          if (currentSpot <= 0) {
            logToServer('warn', `No spot price returned for ${underlying}`, { underlying, quotesCount: Object.keys(data.quotes).length });
            continue;
          }

          // Build leg prices array
          const legPrices = Object.entries(data.quotes).map(([symbol, q]) => ({
            symbol,
            bid: q.bid,
            ask: q.ask,
            mid: q.mid,
          }));

          // Log pricing gaps
          const missingQuotes = [...occSymbols].filter(s => !data.quotes[s]);
          if (missingQuotes.length > 0) {
            logToServer('warn', `Missing quotes for ${missingQuotes.length} OCC symbols`, { underlying, missing: missingQuotes });
          }

          // Evaluate each trade
          for (const trade of underlyingTrades) {
            try {
              const updatedTrade = evaluateTrade(trade, currentSpot, legPrices);
              // If trade was exited, close paper positions and mark rule
              if (updatedTrade && (updatedTrade.status === 'exited' || updatedTrade.status === 'expired')) {
                const trigger = updatedTrade.exitReason === 'profit-target' ? 'target' : 'stop';
                await handleTradeExit(updatedTrade, trigger);
              }
            } catch (e) {
              logToServer('error', `Evaluation failed for trade ${trade.id}`, { tradeId: trade.id, strategy: trade.strategy, error: String(e) });
            }
          }
        } catch (e) {
          logToServer('error', `Network error fetching prices for ${underlying}`, { underlying, error: String(e) });
        }
      }
    } catch (e) {
      logToServer('critical', `TrackerMonitor cycle failed`, { error: String(e) });
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Initial check after 10s delay (let the app settle)
    const startDelay = setTimeout(evaluateTrackedTrades, 10000);

    // Market hours: check every 90s
    intervalRef.current = setInterval(evaluateTrackedTrades, 90000);

    // After hours: check every 5 minutes for expiration handling
    afterHoursRef.current = setInterval(() => {
      if (!isMarketHours()) evaluateTrackedTrades();
    }, 300000);

    return () => {
      clearTimeout(startDelay);
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (afterHoursRef.current) clearInterval(afterHoursRef.current);
    };
  }, [evaluateTrackedTrades]);

  return null;
}
