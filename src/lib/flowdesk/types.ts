/** Flow Desk shared types (server + client). */

import type { Bar } from './indicators/elmod';

export type Right = 'C' | 'P';
export type Side = 'buy' | 'sell' | 'unknown';
export type TradeKind = 'SWEEP' | 'BLOCK' | 'SPLIT' | 'SINGLE';

/** A single option print, with the NBBO in force at the time of the trade. */
export interface OptionTrade {
  id: string;
  /** epoch ms */
  time: number;
  root: string;
  expiry: string; // YYYY-MM-DD
  strike: number;
  right: Right;
  price: number;
  size: number; // contracts
  /** NBBO at trade time; null when the source does not provide it */
  bid: number | null;
  ask: number | null;
  /** underlying price at trade time */
  spot: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  kind: TradeKind;
  /** false when the quote is not the NBBO at trade time (e.g. a later snapshot) */
  nbboAtTrade?: boolean;
}

/** One contract of a chain snapshot (OI = prior trading day). */
export interface ChainContract {
  root: string;
  expiry: string;
  strike: number;
  right: Right;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  openInterest: number;
  iv: number;
  delta: number;
  gamma: number;
  vega: number;
}

export interface ChainSnapshot {
  root: string;
  spot: number;
  asOf: number; // epoch ms
  /** trading date the OI refers to (the prior session) */
  oiDate: string | null;
  contracts: ChainContract[];
}

export type DataMode = 'demo' | 'live';

export interface SourceStatus {
  /** booleans only — never key material */
  tradier: boolean;
  polygon: boolean;
  /** live trade-level prints with NBBO are available */
  tradePrints: boolean;
  demoForced: boolean;
}

export interface NoSource {
  noSource: true;
  reason: string;
  needs: string[];
}

export type Maybe<T> = T | NoSource;

export function isNoSource<T>(v: Maybe<T> | null | undefined): v is NoSource {
  return !!v && typeof v === 'object' && (v as NoSource).noSource === true;
}

export type { Bar };

// ─── Settings ───────────────────────────────────────────────

export type NetConvention = 'call_minus_put' | 'call_plus_put';

export interface FlowSettings {
  /** Top Symbols / Recent Flow table: friend's convention is Call − Put */
  symbolsNet: NetConvention;
  /** By-Expiration table: friend's convention is Call + Put */
  expirationNet: NetConvention;
  /** exclude |delta| > threshold prints from premium / sentiment aggregates */
  excludeDeepItm: boolean;
  deepItmDelta: number;
  rthOnly: boolean;
  recentWindowMin: number;
}

export const DEFAULT_FLOW_SETTINGS: FlowSettings = {
  symbolsNet: 'call_minus_put',
  expirationNet: 'call_plus_put',
  excludeDeepItm: true,
  deepItmDelta: 0.95,
  rthOnly: true,
  recentWindowMin: 30,
};
