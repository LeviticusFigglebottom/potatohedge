// ─── Core Market Types ─────────────────────────────────────────────

export interface Quote {
  symbol: string;
  last: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  prevClose: number;
  volume: number;
  avgVolume: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  timestamp: number;
}

export interface OHLCV {
  time: number; // unix timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Interval = '1min' | '5min' | '15min' | '1h' | '1D' | '1W' | '1M';

// ─── Options Types ─────────────────────────────────────────────────

export interface OptionContract {
  symbol: string;           // OCC symbol
  underlying: string;
  strike: number;
  expiration: string;       // YYYY-MM-DD
  type: 'call' | 'put';
  last: number;
  bid: number;
  ask: number;
  mid: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  // Greeks
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  // Derived
  dte: number;
  inTheMoney: boolean;
  intrinsicValue: number;
  extrinsicValue: number;
  bidAskSpread: number;
  volumeOiRatio: number;
}

export interface OptionsChain {
  underlying: string;
  underlyingPrice: number;
  expiration: string;
  calls: OptionContract[];
  puts: OptionContract[];
  timestamp: number;
}

export interface OptionExpiration {
  date: string;
  dte: number;
  strikes: number[];
}

// ─── Analytics Types ───────────────────────────────────────────────

export interface PutCallRatio {
  volumePCR: number;
  oiPCR: number;
  totalCallVolume: number;
  totalPutVolume: number;
  totalCallOI: number;
  totalPutOI: number;
  timestamp: number;
}

export interface MaxPain {
  strike: number;
  totalPain: number;
  distribution: { strike: number; callPain: number; putPain: number; totalPain: number }[];
}

export interface GEXProfile {
  totalGEX: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxGammaStrike: number;
  netGEXByStrike: { strike: number; callGEX: number; putGEX: number; netGEX: number }[];
  spotPrice: number;
  interpretation: string;
}

export interface DEXProfile {
  totalDEX: number;
  netDEXByStrike: { strike: number; callDEX: number; putDEX: number; netDEX: number }[];
  spotPrice: number;
}

export interface VannaProfile {
  totalVanna: number;
  vannaByStrike: { strike: number; callVanna: number; putVanna: number; netVanna: number }[];
  spotPrice: number;
}

export interface CharmProfile {
  totalCharm: number;
  charmByStrike: { strike: number; callCharm: number; putCharm: number; netCharm: number }[];
  spotPrice: number;
}

export interface IVAnalytics {
  currentIV: number;
  ivRank: number;        // 0-100, where current IV sits in 52-week range
  ivPercentile: number;  // 0-100, % of days IV was lower
  iv30d: number;
  iv60d: number;
  iv90d: number;
  hvRatio: number;       // IV / HV
  skew25d: number;       // 25-delta put IV - 25-delta call IV
  termStructure: { dte: number; iv: number }[];
}

export interface VolSurfacePoint {
  strike: number;
  dte: number;
  iv: number;
  delta: number;
  moneyness: number; // strike / spot
}

export interface FlowEntry {
  time: number;
  symbol: string;
  strike: number;
  expiration: string;
  type: 'call' | 'put';
  side: 'buy' | 'sell' | 'unknown';
  tradeType: 'sweep' | 'block' | 'split' | 'single';
  premium: number;
  size: number;
  price: number;
  openInterest: number;
  iv: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

export interface DashboardState {
  symbol: string;
  quote: Quote | null;
  chain: OptionsChain | null;
  selectedExpiration: string | null;
  expirations: OptionExpiration[];
  interval: Interval;
  loading: {
    quote: boolean;
    chain: boolean;
    history: boolean;
  };
  error: string | null;
}

// ─── Provider Interface ────────────────────────────────────────────

export interface MarketDataProvider {
  name: string;
  getQuote(symbol: string): Promise<Quote>;
  getHistory(symbol: string, interval: Interval, start?: string, end?: string): Promise<OHLCV[]>;
  getExpirations(symbol: string): Promise<OptionExpiration[]>;
  getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain>;
}
