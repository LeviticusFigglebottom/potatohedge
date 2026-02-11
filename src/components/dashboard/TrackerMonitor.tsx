'use client';

import { useEffect, useRef, useCallback } from 'react';
import {
  loadTrackedTrades,
  evaluateTrade,
  type TrackedTrade,
} from '@/lib/tradeTracker';

/**
 * Background monitor for tracked AI/algo trade recommendations.
 * Runs at the app level (page.tsx) — checks tracked trades regardless of active tab.
 * Polls every 90s during market hours, fetches live option prices for all open tracked trades,
 * and evaluates them against profit targets, stop losses, and expiration.
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

export default function TrackerMonitor() {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const runningRef = useRef(false);

  const evaluateTrackedTrades = useCallback(async () => {
    if (runningRef.current) return;
    if (!isMarketHours()) return;

    const trades = loadTrackedTrades();
    const openTrades = trades.filter(
      (t) => t.status === 'pending' || t.status === 'entered'
    );
    if (openTrades.length === 0) return;

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

          if (!res.ok) continue;

          const data: {
            quotes: Record<string, { bid: number; ask: number; mid: number; last: number }>;
            spot: number | null;
          } = await res.json();

          const currentSpot = data.spot ?? 0;
          if (currentSpot <= 0) continue;

          // Build leg prices array
          const legPrices = Object.entries(data.quotes).map(([symbol, q]) => ({
            symbol,
            bid: q.bid,
            ask: q.ask,
            mid: q.mid,
          }));

          // Evaluate each trade
          for (const trade of underlyingTrades) {
            evaluateTrade(trade, currentSpot, legPrices);
          }
        } catch {
          // Network error for this underlying — skip, retry next cycle
        }
      }
    } catch {
      // Silent fail
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Initial check after 10s delay (let the app settle)
    const startDelay = setTimeout(evaluateTrackedTrades, 10000);
    // Then check every 90s
    intervalRef.current = setInterval(evaluateTrackedTrades, 90000);
    return () => {
      clearTimeout(startDelay);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [evaluateTrackedTrades]);

  return null;
}
