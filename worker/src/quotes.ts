// Quote provider used by the risk filter and the position manager.
//
// Primary source: Tradier's options chain endpoint. We already pull chains
// for every ticker in the briefing and Tradier's free tier has full OPRA
// coverage, so it gives us bids/asks for everything Alpaca's data plan
// might miss (sector ETFs, far-OTM strikes, longer-dated expirations).
//
// Fallback source: Alpaca's per-symbol options quote endpoint. Used only
// when Tradier doesn't have the specific contract.
//
// The exposed function (getOptionQuoteForLeg) accepts a leg description
// instead of an OCC symbol so we can group lookups by underlying+expiration
// and fetch each chain once per tick instead of once per leg.

import { getOptionsChain } from './lib/providers/tradier.js';
import { getOptionQuote as alpacaQuote, buildOccSymbol } from './alpaca.js';
import { log } from './log.js';
import type { NormalizedLeg, OptionRight } from './types.js';

export interface OptionQuote {
  bid: number;
  ask: number;
  mid: number;
  source: 'tradier' | 'alpaca';
}

interface ChainKey {
  underlying: string;
  expiration: string;
}

interface CachedRow {
  strike: number;
  right: OptionRight;
  bid: number;
  ask: number;
}

// Per-tick cache keyed by underlying+expiration. Cleared between ticks via
// resetQuoteCache() so a long-running worker doesn't serve stale data.
const chainCache = new Map<string, CachedRow[]>();

function key(k: ChainKey): string {
  return `${k.underlying}:${k.expiration}`;
}

export function resetQuoteCache(): void {
  chainCache.clear();
}

async function loadTradierChain(k: ChainKey): Promise<CachedRow[] | null> {
  const cacheKey = key(k);
  if (chainCache.has(cacheKey)) return chainCache.get(cacheKey)!;
  try {
    const chain = await getOptionsChain(k.underlying, k.expiration);
    const rows: CachedRow[] = [];
    for (const c of chain.calls) {
      rows.push({ strike: c.strike, right: 'call', bid: c.bid, ask: c.ask });
    }
    for (const p of chain.puts) {
      rows.push({ strike: p.strike, right: 'put', bid: p.bid, ask: p.ask });
    }
    chainCache.set(cacheKey, rows);
    return rows;
  } catch (e) {
    log.warn('tradier chain fetch failed — falling back to Alpaca per-symbol', {
      underlying: k.underlying,
      expiration: k.expiration,
      error: (e as Error).message,
    });
    return null;
  }
}

export async function getOptionQuoteForLeg(leg: NormalizedLeg): Promise<OptionQuote | null> {
  const rows = await loadTradierChain({ underlying: leg.underlying, expiration: leg.expiration });
  if (rows) {
    // Strike match with small float tolerance — Tradier sometimes returns
    // 52.5 vs our normalized 52.5000.
    const match = rows.find(
      (r) => r.right === leg.right && Math.abs(r.strike - leg.strike) < 0.001,
    );
    if (match && match.bid > 0 && match.ask > 0) {
      return {
        bid: match.bid,
        ask: match.ask,
        mid: (match.bid + match.ask) / 2,
        source: 'tradier',
      };
    }
  }

  // Fallback: try Alpaca per-symbol. Useful for the rare case Tradier is
  // missing a specific contract or the chain fetch failed.
  const occ = buildOccSymbol(leg);
  const alpaca = await alpacaQuote(occ);
  if (alpaca) {
    return { ...alpaca, source: 'alpaca' };
  }
  return null;
}
