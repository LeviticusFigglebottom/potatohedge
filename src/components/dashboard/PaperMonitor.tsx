'use client';

import { useEffect, useRef, useCallback } from 'react';

/**
 * Background monitor for paper trading positions.
 * Runs at the app level (page.tsx) so it checks positions regardless of active tab.
 * Polls every 60s, checks positions against stored exit rules, auto-closes when hit.
 * Only active during US market hours and only when there are active rules.
 */

interface TradeRule {
  occSymbol: string;
  thesis: string;
  targetPrice: number | null;
  stopPrice: number | null;
  costBasis: number;
  createdAt: string;
  autoExit: boolean;
  exitTriggered?: 'target' | 'stop' | null;
  exitOrderId?: number;
}

function loadRules(): TradeRule[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem('optix-paper-rules') || '[]');
  } catch { return []; }
}

function saveRules(rules: TradeRule[]) {
  localStorage.setItem('optix-paper-rules', JSON.stringify(rules));
}

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false; // weekend
  const hours = et.getHours();
  const mins = et.getMinutes();
  const time = hours * 60 + mins;
  // Pre-market 8:00 to after-hours 18:00 ET (wider window for options)
  return time >= 480 && time <= 1080;
}

export default function PaperMonitor() {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const runningRef = useRef(false);

  const checkPositions = useCallback(async () => {
    // Don't overlap checks
    if (runningRef.current) return;

    // Only check if there are active rules
    const rules = loadRules();
    const activeRules = rules.filter(r => r.autoExit && !r.exitTriggered && (r.targetPrice || r.stopPrice));
    if (activeRules.length === 0) return;

    // Only check during market hours (options have no live quotes outside)
    if (!isMarketHours()) return;

    runningRef.current = true;
    try {
      const res = await fetch('/api/paper/account');
      if (!res.ok || res.status === 501) return;
      const data = await res.json();
      const positions = data.positions || [];

      for (const pos of positions) {
        const rule = activeRules.find(r => r.occSymbol === pos.symbol);
        if (!rule) continue;
        const currentPrice = pos.currentPrice ?? 0;
        if (currentPrice <= 0) continue;

        let triggered: 'target' | 'stop' | null = null;

        // Check take profit (long positions: current >= target)
        if (rule.targetPrice && currentPrice >= rule.targetPrice && pos.quantity > 0) {
          triggered = 'target';
        }
        // Check stop loss (long positions: current <= stop)
        if (rule.stopPrice && currentPrice <= rule.stopPrice && pos.quantity > 0) {
          triggered = 'stop';
        }

        if (triggered) {
          try {
            const closeRes = await fetch('/api/paper/close', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ symbol: pos.symbol, quantity: pos.quantity }),
            });
            const closeData = await closeRes.json();
            if (closeRes.ok) {
              // Update the rule
              const allRules = loadRules();
              const idx = allRules.findIndex(r => r.occSymbol === pos.symbol);
              if (idx >= 0) {
                allRules[idx].exitTriggered = triggered;
                allRules[idx].exitOrderId = closeData.orderId;
                saveRules(allRules);
              }
              console.log(`[PaperMonitor] Auto-closed ${pos.symbol}: ${triggered} hit at $${currentPrice.toFixed(2)}, order #${closeData.orderId}`);
            }
          } catch {
            // Will retry next cycle
          }
        }
      }
    } catch {
      // Silent fail — background monitor shouldn't disrupt the app
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Initial check after 5s delay (let the app settle)
    const startDelay = setTimeout(checkPositions, 5000);
    // Then check every 60s
    intervalRef.current = setInterval(checkPositions, 60000);
    return () => {
      clearTimeout(startDelay);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [checkPositions]);

  // Renders nothing — pure background logic
  return null;
}
