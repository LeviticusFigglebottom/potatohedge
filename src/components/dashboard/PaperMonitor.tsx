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

        // Enforce minimum holding period: don't auto-exit within 5 minutes of creation
        const createdTime = new Date(rule.createdAt).getTime();
        const ageMs = Date.now() - createdTime;
        if (ageMs < 5 * 60 * 1000) continue; // 5-minute grace period

        let triggered: 'target' | 'stop' | null = null;

        // Grouped percentage-based P&L (spreads, condors, straddles)
        if (rule.profitTargetPct || rule.stopLossPct) {
          // Use NET cost basis (sum with sign) for proper spread P/L calculation
          // Credit spreads: net cost_basis is negative (credit received)
          // Debit spreads: net cost_basis is positive (debit paid)
          const netCost = matched.reduce((s, p) => s + p.cost_basis, 0);
          const totalPL = matched.reduce((s, p) => s + p.unrealizedPL, 0);

          // For percentage calc, use absolute net cost as the reference
          // For very small positions (< $25 net premium), use dollar-based thresholds instead
          const absNetCost = Math.abs(netCost);

          if (absNetCost < 25) {
            // Thin premium positions: use absolute dollar thresholds instead of percentages
            // Require at least $10 profit or $50 loss before triggering
            const dollarTarget = Math.max(10, absNetCost * (rule.profitTargetPct / 100));
            const dollarStop = Math.max(50, absNetCost * (rule.stopLossPct / 100));

            if (rule.profitTargetPct && totalPL >= dollarTarget) triggered = 'target';
            if (rule.stopLossPct && totalPL <= -dollarStop) triggered = 'stop';
          } else {
            // Normal positions: use percentage of net cost basis
            const plPct = absNetCost > 0 ? (totalPL / absNetCost) * 100 : 0;

            if (rule.profitTargetPct && plPct >= rule.profitTargetPct) triggered = 'target';
            if (rule.stopLossPct && plPct <= -rule.stopLossPct) triggered = 'stop';
          }
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
