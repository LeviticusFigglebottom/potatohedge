/**
 * Flow aggregations behind the Flow Desk panels. Pure functions over OptionTrade[].
 *
 * Premium is aggressor-signed: buy = +price·size·100, sell = −…, unknown = 0
 * (unknown prints still count toward volume). "Call Premium" / "Put Premium"
 * columns are the signed sums for that right.
 *
 * Net conventions (configurable, defaults follow the friend's dashboard):
 *   Top Symbols / Recent Flow : Net = Call − Put
 *   By Expiration             : Net = Call + Put
 * Sentiment = sign of the table's Net.
 */

import { bullSign, classifySide, isDeepItm, premium, sideSign } from './classify';
import { isRTH } from '../time';
import type { FlowSettings, NetConvention, OptionTrade, Side } from '../types';

export interface EnrichedTrade extends OptionTrade {
  side: Side;
  sign: number;
  premium: number;
  signedPremium: number;
  deepItm: boolean;
  /** contributes to premium / sentiment aggregates */
  inSentiment: boolean;
}

export function enrich(trades: OptionTrade[], s: Pick<FlowSettings, 'excludeDeepItm' | 'deepItmDelta'>): EnrichedTrade[] {
  return trades.map((t) => {
    const side = classifySide(t.price, t.bid, t.ask);
    const sign = sideSign(side);
    const p = premium(t);
    const deepItm = isDeepItm(t, s.deepItmDelta);
    return { ...t, side, sign, premium: p, signedPremium: sign * p, deepItm, inSentiment: !(s.excludeDeepItm && deepItm) };
  });
}

export type Sentiment = 'Bullish' | 'Bearish' | 'Neutral';

export function sentimentOf(net: number): Sentiment {
  return net > 0 ? 'Bullish' : net < 0 ? 'Bearish' : 'Neutral';
}

export function combineNet(call: number, put: number, conv: NetConvention): number {
  return conv === 'call_minus_put' ? call - put : call + put;
}

// ─── Panel 1: intraday options flow ─────────────────────────

export interface FlowPoint {
  time: number; // unix seconds, minute start
  callFlow: number; // cumulative signed call premium
  putFlow: number; // cumulative signed put premium
  netFlow: number; // callFlow − putFlow
  volume: number; // contracts in the minute
  callVolume: number;
  putVolume: number;
  spot: number; // last underlying price seen in the minute
}

export function intradayFlow(trades: EnrichedTrade[], opts: { rthOnly: boolean }): FlowPoint[] {
  const sorted = trades.filter((t) => !opts.rthOnly || isRTH(t.time)).sort((a, b) => a.time - b.time);
  const out: FlowPoint[] = [];
  let call = 0;
  let put = 0;
  let cur: FlowPoint | null = null;
  for (const t of sorted) {
    const minute = Math.floor(t.time / 60000) * 60;
    if (!cur || cur.time !== minute) {
      cur = { time: minute, callFlow: call, putFlow: put, netFlow: call - put, volume: 0, callVolume: 0, putVolume: 0, spot: t.spot };
      out.push(cur);
    }
    if (t.inSentiment) {
      if (t.right === 'C') call += t.signedPremium;
      else put += t.signedPremium;
    }
    cur.callFlow = call;
    cur.putFlow = put;
    cur.netFlow = call - put;
    cur.volume += t.size;
    if (t.right === 'C') cur.callVolume += t.size;
    else cur.putVolume += t.size;
    cur.spot = t.spot;
  }
  return out;
}

// ─── Panels 2 & 4: by symbol ────────────────────────────────

export interface SymbolRow {
  symbol: string;
  netPremium: number;
  callPremium: number;
  putPremium: number;
  totalVolume: number;
  callVolume: number;
  putVolume: number;
  sentiment: Sentiment;
}

export function symbolTable(trades: EnrichedTrade[], conv: NetConvention): SymbolRow[] {
  const map = new Map<string, SymbolRow>();
  for (const t of trades) {
    let r = map.get(t.root);
    if (!r) {
      r = { symbol: t.root, netPremium: 0, callPremium: 0, putPremium: 0, totalVolume: 0, callVolume: 0, putVolume: 0, sentiment: 'Neutral' };
      map.set(t.root, r);
    }
    if (t.right === 'C') { r.callVolume += t.size; if (t.inSentiment) r.callPremium += t.signedPremium; }
    else { r.putVolume += t.size; if (t.inSentiment) r.putPremium += t.signedPremium; }
    r.totalVolume += t.size;
  }
  for (const r of map.values()) {
    r.netPremium = combineNet(r.callPremium, r.putPremium, conv);
    r.sentiment = sentimentOf(r.netPremium);
  }
  return [...map.values()].sort((a, b) => b.netPremium - a.netPremium);
}

export function recentTrades<T extends { time: number }>(trades: T[], nowMs: number, minutes: number): T[] {
  const from = nowMs - minutes * 60_000;
  return trades.filter((t) => t.time > from && t.time <= nowMs);
}

// ─── Panel 3: by expiration ─────────────────────────────────

export interface ExpirationRow {
  expiration: string;
  netPremium: number;
  callPremium: number;
  putPremium: number;
  totalVolume: number;
  callVolume: number;
  putVolume: number;
  /** call volume / put volume (Infinity when no put volume) */
  callPutRatio: number;
  sentiment: Sentiment;
}

export function expirationTable(trades: EnrichedTrade[], conv: NetConvention): ExpirationRow[] {
  const map = new Map<string, ExpirationRow>();
  for (const t of trades) {
    let r = map.get(t.expiry);
    if (!r) {
      r = { expiration: t.expiry, netPremium: 0, callPremium: 0, putPremium: 0, totalVolume: 0, callVolume: 0, putVolume: 0, callPutRatio: 0, sentiment: 'Neutral' };
      map.set(t.expiry, r);
    }
    if (t.right === 'C') { r.callVolume += t.size; if (t.inSentiment) r.callPremium += t.signedPremium; }
    else { r.putVolume += t.size; if (t.inSentiment) r.putPremium += t.signedPremium; }
    r.totalVolume += t.size;
  }
  for (const r of map.values()) {
    r.netPremium = combineNet(r.callPremium, r.putPremium, conv);
    r.callPutRatio = r.putVolume > 0 ? r.callVolume / r.putVolume : r.callVolume > 0 ? Infinity : 0;
    r.sentiment = sentimentOf(r.netPremium);
  }
  return [...map.values()].sort((a, b) => a.expiration.localeCompare(b.expiration));
}

// ─── Panel 5: strike × expiry heatmap ───────────────────────

export interface HeatCell {
  strike: number;
  expiry: string;
  buys: number;
  sells: number;
  unknown: number;
  callPremium: number; // signed
  putPremium: number; // signed
  callVolume: number;
  putVolume: number;
  /** bullish premium: call − put (signed) */
  bullPremium: number;
  /** buy count / sell count (Infinity when sells = 0 and buys > 0, 1 when both 0) */
  buySellRatio: number;
}

export function heatmapCells(trades: EnrichedTrade[]): HeatCell[] {
  const map = new Map<string, HeatCell>();
  for (const t of trades) {
    const key = `${t.expiry}|${t.strike}`;
    let c = map.get(key);
    if (!c) {
      c = { strike: t.strike, expiry: t.expiry, buys: 0, sells: 0, unknown: 0, callPremium: 0, putPremium: 0, callVolume: 0, putVolume: 0, bullPremium: 0, buySellRatio: 1 };
      map.set(key, c);
    }
    if (t.side === 'buy') c.buys++;
    else if (t.side === 'sell') c.sells++;
    else c.unknown++;
    if (t.right === 'C') { c.callVolume += t.size; if (t.inSentiment) c.callPremium += t.signedPremium; }
    else { c.putVolume += t.size; if (t.inSentiment) c.putPremium += t.signedPremium; }
  }
  for (const c of map.values()) {
    c.bullPremium = c.callPremium - c.putPremium;
    c.buySellRatio = c.sells > 0 ? c.buys / c.sells : c.buys > 0 ? Infinity : 1;
  }
  return [...map.values()];
}

// ─── Daily per-root summary (panel 10) ──────────────────────

export interface DailyRootSummary {
  root: string;
  date: string;
  total_net_premium: number;
  total_net_delta: number;
  total_net_vega: number;
}

/**
 * total_net_premium = Σ bullSign·premium (call buys and put sells positive) — i.e. Call − Put,
 * total_net_delta   = Σ sign·size·100·delta   (customer share-equivalent delta bought),
 * total_net_vega    = Σ sign·size·100·vega    (customer $ vega per vol point bought).
 * Deep-ITM prints follow the excludeDeepItm setting (already applied in `inSentiment`).
 */
export function dailyRootSummary(trades: EnrichedTrade[], date: string): DailyRootSummary[] {
  const map = new Map<string, DailyRootSummary>();
  for (const t of trades) {
    if (!t.inSentiment) continue;
    let r = map.get(t.root);
    if (!r) { r = { root: t.root, date, total_net_premium: 0, total_net_delta: 0, total_net_vega: 0 }; map.set(t.root, r); }
    r.total_net_premium += bullSign(t, t.side) * t.premium;
    r.total_net_delta += t.sign * t.size * 100 * (t.delta ?? 0);
    r.total_net_vega += t.sign * t.size * 100 * (t.vega ?? 0);
  }
  return [...map.values()].sort((a, b) => a.root.localeCompare(b.root));
}
