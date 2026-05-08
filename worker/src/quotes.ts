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

import { getOptionsChain, getExpirations } from './lib/providers/tradier.js';
import { getOptionQuote as alpacaQuote, buildOccSymbol } from './alpaca.js';
import { log } from './log.js';
import type { NormalizedLeg, OptionRight } from './types.js';

const SNAP_MAX_DAYS = 7;
const expirationsCache = new Map<string, string[]>();

async function listExpirations(underlying: string): Promise<string[]> {
  const hit = expirationsCache.get(underlying);
  if (hit) return hit;
  try {
    const exps = await getExpirations(underlying);
    const dates = exps.map((e) => e.date);
    expirationsCache.set(underlying, dates);
    return dates;
  } catch (e) {
    log.warn('expirations fetch failed', { underlying, error: (e as Error).message });
    return [];
  }
}

function nearestExpiration(target: string, list: string[]): string | null {
  if (list.length === 0) return null;
  const targetMs = new Date(target + 'T16:00:00').getTime();
  let best: { date: string; dist: number } | null = null;
  for (const d of list) {
    const dist = Math.abs(new Date(d + 'T16:00:00').getTime() - targetMs);
    if (best === null || dist < best.dist) best = { date: d, dist };
  }
  if (!best) return null;
  if (best.dist > SNAP_MAX_DAYS * 24 * 3600 * 1000) return null;
  return best.date === target ? null : best.date;
}

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
  expirationsCache.clear();
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
  let effectiveExpiration = leg.expiration;
  let rows = await loadTradierChain({ underlying: leg.underlying, expiration: effectiveExpiration });

  // Snap-to-nearest fallback: if Tradier said the expiration was valid in
  // getExpirations but the chain came back empty (Tradier data inconsistency
  // we've seen on sector ETFs), find the closest valid expiration that does
  // have a chain. Only allowed within SNAP_MAX_DAYS so we don't silently
  // change the trade's risk profile by weeks.
  if (rows && rows.length === 0) {
    const list = await listExpirations(leg.underlying);
    const snap = nearestExpiration(leg.expiration, list);
    if (snap) {
      log.warn('snapping leg expiration to nearest valid', {
        underlying: leg.underlying,
        requested: leg.expiration,
        snapped_to: snap,
      });
      effectiveExpiration = snap;
      rows = await loadTradierChain({ underlying: leg.underlying, expiration: snap });
      // Mutate the leg object so downstream code (OCC symbol builder, DB
      // persistence) uses the snapped date — otherwise we'd write an order
      // for a contract that doesn't exist.
      leg.expiration = snap;
    }
  }

  if (rows) {
    const sameRight = rows.filter((r) => r.right === leg.right);
    const match = sameRight.find((r) => Math.abs(r.strike - leg.strike) < 0.001);
    if (match && match.bid > 0 && match.ask > 0) {
      return {
        bid: match.bid,
        ask: match.ask,
        mid: (match.bid + match.ask) / 2,
        source: 'tradier',
      };
    }
    // Diagnostic: log what we *did* find so we can tell strike-rounding
    // mismatch ("$735 requested, $735.5 available") apart from a contract
    // that genuinely isn't on the chain.
    const nearest = sameRight
      .map((r) => ({ strike: r.strike, bid: r.bid, ask: r.ask, dist: Math.abs(r.strike - leg.strike) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4)
      .map((r) => `${r.strike}${r.bid > 0 && r.ask > 0 ? '' : '(no bid/ask)'}`);
    log.warn('tradier no match for leg', {
      underlying: leg.underlying,
      expiration: leg.expiration,
      requested_strike: leg.strike,
      requested_right: leg.right,
      tradier_chain_size: sameRight.length,
      nearest_strikes: nearest,
      had_match_zero_bidask: !!match,
    });
  }

  const occ = buildOccSymbol(leg);
  const alpaca = await alpacaQuote(occ);
  if (alpaca) {
    return { ...alpaca, source: 'alpaca' };
  }
  return null;
}
