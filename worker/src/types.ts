export type OptionRight = 'call' | 'put';
export type OptionSide = 'long' | 'short';
export type Direction = 'bullish' | 'bearish' | 'neutral';

// Normalized representation of a single option leg the worker can route
// to Alpaca. Multi-leg structures from the briefing get expanded into
// one of these per leg before sizing.
export interface NormalizedLeg {
  underlying: string;
  right: OptionRight;
  strike: number;
  expiration: string; // YYYY-MM-DD
  side: OptionSide;
  ratio: number; // legs per spread unit (usually 1)
}

export interface NormalizedTrade {
  // Stable hash of the trade's structural fields — used to dedupe against
  // anything we already opened from a prior briefing.
  key: string;
  underlying: string;
  direction: Direction;
  strategyLabel: string;
  legs: NormalizedLeg[];
  // Entry metadata
  estimatedDebitPerSpread: number; // positive = debit, negative = credit
  // Exit rules — preferred numeric form, with originals for audit.
  exitTargetPct?: number; // e.g. 0.5 = "50% of max credit"
  exitStopPct?: number;
  invalidation?: string;
  thesis?: string;
  rawIdea: unknown; // original AI idea object (stored in briefings.parsed)
}

export interface AlpacaPositionRow {
  symbol: string; // OCC option symbol
  qty: number; // signed: + long, - short
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
}

export interface AlpacaAccount {
  portfolioValue: number;
  buyingPower: number;
  cash: number;
}
