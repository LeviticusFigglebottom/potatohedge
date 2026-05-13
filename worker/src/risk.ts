import { loadConfig } from './config.js';
import { log } from './log.js';
import { buildOccSymbol } from './alpaca.js';
import { dteFromExpiration } from './market.js';
import { getOptionQuoteForLeg, resetQuoteCache, type OptionQuote } from './quotes.js';
import type { Direction, NormalizedTrade } from './types.js';

// One entry per open *trade* (multi-leg spread = one entry), so the
// concurrency caps line up with the user's mental model of "positions".
export interface OpenPositionSummary {
  tradeKey: string;
  underlying: string;
  direction: Direction;
}

export interface SizingResult {
  trade: NormalizedTrade;
  contracts: number; // number of spread units
  perLegQuotes: Record<string, OptionQuote>; // keyed by occSymbol
  estimatedCostUsd: number; // signed: + debit, - credit
  reason?: string; // populated if rejected
  rejected: boolean;
}

interface SizeOptions {
  portfolioValue: number;
  buyingPower: number;
  openPositions: OpenPositionSummary[];
}

function bucketCount(positions: OpenPositionSummary[], dir: Direction): number {
  return positions.filter((p) => p.direction === dir).length;
}

export async function sizeAndFilter(
  trades: NormalizedTrade[],
  opts: SizeOptions,
): Promise<SizingResult[]> {
  const cfg = loadConfig();
  const out: SizingResult[] = [];

  // Live counters mutate as we accept trades, so the caps apply across the
  // batch (not just against the snapshot at tick start).
  const liveOpen = [...opts.openPositions];

  // Fresh tick — drop cached chains so we don't size against stale quotes.
  resetQuoteCache();

  for (const trade of trades) {
    const reject = (reason: string): SizingResult => ({
      trade,
      contracts: 0,
      perLegQuotes: {},
      estimatedCostUsd: 0,
      reason,
      rejected: true,
    });

    if (liveOpen.length >= cfg.MAX_CONCURRENT_POSITIONS) {
      out.push(reject(`max concurrent positions reached (${cfg.MAX_CONCURRENT_POSITIONS})`));
      continue;
    }
    if (bucketCount(liveOpen, trade.direction) >= cfg.MAX_PER_DIRECTION) {
      out.push(reject(`directional cap reached for ${trade.direction} (${cfg.MAX_PER_DIRECTION})`));
      continue;
    }

    // DTE gates. Two separate checks:
    //   1. Any leg below MIN_OPEN_DTE is too short to amortize theta or
    //      give the manager a meaningful window to react. Catches
    //      long-only straddles (0–2 DTE bets) that the short-leg check
    //      below doesn't see.
    //   2. Any short leg already inside ASSIGNMENT_CLOSE_DTE would be
    //      flagged for close on the very next planExits — opening it
    //      just wastes capital and creates stuck working orders.
    let minLegDte = Number.POSITIVE_INFINITY;
    let minShortDte = Number.POSITIVE_INFINITY;
    for (const leg of trade.legs) {
      try {
        const d = dteFromExpiration(leg.expiration);
        if (d < minLegDte) minLegDte = d;
        if (leg.side === 'short' && d < minShortDte) minShortDte = d;
      } catch {
        /* unparseable expiration handled elsewhere */
      }
    }
    if (Number.isFinite(minLegDte) && minLegDte < cfg.MIN_OPEN_DTE) {
      out.push(reject(`leg DTE ${minLegDte} < MIN_OPEN_DTE (${cfg.MIN_OPEN_DTE}) — too short to manage`));
      continue;
    }
    if (Number.isFinite(minShortDte) && minShortDte <= cfg.ASSIGNMENT_CLOSE_DTE) {
      out.push(reject(`short leg DTE ${minShortDte} <= ASSIGNMENT_CLOSE_DTE (${cfg.ASSIGNMENT_CLOSE_DTE}) — would close on next tick`));
      continue;
    }

    // Pull live quotes for every leg via Tradier (chain-cached), fallback
    // to Alpaca per-symbol. If anything is unquotable, skip.
    const quotes: Record<string, OptionQuote> = {};
    let unquotable = false;
    for (const leg of trade.legs) {
      const sym = buildOccSymbol(leg);
      const q = await getOptionQuoteForLeg(leg);
      if (!q) {
        unquotable = true;
        log.warn('skipping trade — leg unquotable', {
          trade: trade.key,
          leg: sym,
          underlying: leg.underlying,
          strike: leg.strike,
          right: leg.right,
          expiration: leg.expiration,
        });
        break;
      }
      quotes[sym] = q;
    }
    if (unquotable) {
      out.push(reject('one or more legs unquotable'));
      continue;
    }

    // Per-spread cost from live quotes (cross the spread for safety):
    //   long leg → pay ask, short leg → receive bid.
    let perSpreadDebitUsdPerShare = 0;
    for (const leg of trade.legs) {
      const sym = buildOccSymbol(leg);
      const q = quotes[sym];
      if (!q) continue;
      const px = leg.side === 'long' ? q.ask : q.bid;
      const sign = leg.side === 'long' ? 1 : -1;
      perSpreadDebitUsdPerShare += sign * px * leg.ratio;
    }
    const perSpreadCostUsd = perSpreadDebitUsdPerShare * 100;

    // For credits, capital at risk is the spread width minus credit.
    // For now we approximate "cost" as max(perSpreadCostUsd, credit_at_risk).
    // For pure debit trades this equals perSpreadCostUsd.
    const capitalAtRiskPerSpread = perSpreadCostUsd > 0
      ? perSpreadCostUsd
      : Math.max(50, Math.abs(perSpreadCostUsd) * 3); // conservative for credits

    const targetUsd = opts.portfolioValue * cfg.TARGET_ALLOC_PCT;
    let contracts = Math.max(1, Math.floor(targetUsd / capitalAtRiskPerSpread));

    const totalCostUsd = perSpreadCostUsd * contracts;
    if (totalCostUsd > 0 && totalCostUsd > opts.buyingPower * 0.95) {
      // shrink to fit
      contracts = Math.floor((opts.buyingPower * 0.95) / capitalAtRiskPerSpread);
      if (contracts < 1) {
        out.push(reject(`insufficient buying power (need $${capitalAtRiskPerSpread.toFixed(0)}, have $${opts.buyingPower.toFixed(0)})`));
        continue;
      }
    }

    out.push({
      trade,
      contracts,
      perLegQuotes: quotes,
      estimatedCostUsd: perSpreadCostUsd * contracts,
      rejected: false,
    });

    // Reserve one slot in the live counter for subsequent trades in this batch.
    liveOpen.push({
      tradeKey: trade.key,
      underlying: trade.underlying,
      direction: trade.direction,
    });
  }

  return out;
}
