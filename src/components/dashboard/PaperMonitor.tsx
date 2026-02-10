'use client';

import { useEffect, useRef, useCallback } from 'react';

/**
 * Background monitor for paper trading positions.
 * Runs at the app level (page.tsx) — checks positions regardless of active tab.
 * Polls every 60s during market hours, checks grouped spread P&L against exit rules.
 * Supports both new grouped rules (spreads) and legacy single-symbol rules.
 */

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
  // Legacy single-position fields
  occSymbol?: string;
  targetPrice?: number | null;
  stopPrice?: number | null;
  costBasis?: number;
}

interface Position {
  symbol: string;
  quantity: number;
  cost_basis: number;
  currentPrice: number;
  unrealizedPL: number;
}

function loadRules(): TradeRule[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem('optix-paper-rules') || '[]'); }
  catch { return []; }
}

function saveRules(rules: TradeRule[]) {
  localStorage.setItem('optix-paper-rules', JSON.stringify(rules));
}

function isMarketHours(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const time = et.getHours() * 60 + et.getMinutes();
  return time >= 480 && time <= 1080; // 8AM-6PM ET
}

export default function PaperMonitor() {
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const runningRef = useRef(false);

  const checkPositions = useCallback(async () => {
    if (runningRef.current) return;

    const rules = loadRules();
    const activeRules = rules.filter(r => r.autoExit && !r.exitTriggered);
    if (activeRules.length === 0) return;
    if (!isMarketHours()) return;

    runningRef.current = true;
    try {
      const res = await fetch('/api/paper/account');
      if (!res.ok || res.status === 501) return;
      const data = await res.json();
      const positions: Position[] = data.positions || [];

      for (const rule of activeRules) {
        // Collect OCC symbols for this rule (new grouped or legacy single)
        const ruleSymbols = rule.occSymbols?.length
          ? rule.occSymbols
          : rule.occSymbol ? [rule.occSymbol] : [];
        if (ruleSymbols.length === 0) continue;

        // Find matching positions
        const matched = positions.filter(p => ruleSymbols.includes(p.symbol));
        if (matched.length === 0) continue;

        let triggered: 'target' | 'stop' | null = null;

        // Grouped percentage-based P&L (spreads, condors, straddles)
        if (rule.profitTargetPct || rule.stopLossPct) {
          const totalCost = matched.reduce((s, p) => s + Math.abs(p.cost_basis), 0);
          const totalPL = matched.reduce((s, p) => s + p.unrealizedPL, 0);
          const plPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

          if (rule.profitTargetPct && plPct >= rule.profitTargetPct) triggered = 'target';
          if (rule.stopLossPct && plPct <= -rule.stopLossPct) triggered = 'stop';
        }

        // Legacy: absolute price targets
        if (!triggered && (rule.targetPrice || rule.stopPrice)) {
          for (const pos of matched) {
            if (pos.currentPrice <= 0 || pos.quantity <= 0) continue;
            if (rule.targetPrice && pos.currentPrice >= rule.targetPrice) triggered = 'target';
            if (rule.stopPrice && pos.currentPrice <= rule.stopPrice) triggered = 'stop';
          }
        }

        if (triggered) {
          console.log(`[PaperMonitor] ${triggered.toUpperCase()} HIT: ${rule.strategy || 'Trade'} on ${rule.underlying || '?'} — closing ${matched.length} position(s)`);
          let firstOrderId: number | undefined;
          for (const pos of matched) {
            try {
              const closeRes = await fetch('/api/paper/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: pos.symbol, quantity: pos.quantity }),
              });
              const closeData = await closeRes.json();
              if (closeRes.ok && !firstOrderId) firstOrderId = closeData.orderId;
            } catch { /* retry next cycle */ }
          }
          // Mark rule as triggered
          const allRules = loadRules();
          const idx = allRules.findIndex(r =>
            r.id === rule.id || (rule.occSymbol && r.occSymbol === rule.occSymbol)
          );
          if (idx >= 0) {
            allRules[idx].exitTriggered = triggered;
            allRules[idx].exitOrderId = firstOrderId;
            saveRules(allRules);
          }
        }
      }
    } catch {
      // Silent fail
    } finally {
      runningRef.current = false;
    }
  }, []);

  useEffect(() => {
    const startDelay = setTimeout(checkPositions, 5000);
    intervalRef.current = setInterval(checkPositions, 60000);
    return () => {
      clearTimeout(startDelay);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [checkPositions]);

  return null;
}
