/**
 * Entropy Paper Trading Engine — TypeScript Port
 *
 * Server-side only (Next.js API routes). Uses better-sqlite3 for DB,
 * reuses BSM math from @/lib/math/blackScholes.ts and Tradier APIs
 * from @/lib/providers/tradier.ts and tradierPaper.ts.
 *
 * Run via cron or API trigger at 3:50pm ET daily.
 */

import path from 'path';
import fs from 'fs';
import {
  bsCallPrice,
  bsPutPrice,
  gamma as bsGamma,
  delta as bsDelta,
  vega as bsVega,
} from '@/lib/math/blackScholes';
import { getQuote } from '@/lib/providers/tradier';
import {
  placeSingleOrder,
  getOptionQuote,
  getBalances,
  closePosition as tradierClosePosition,
} from '@/lib/providers/tradierPaper';
import { restoreFromRedis, persistToRedis } from '@/lib/entropy/persistence';

// ═══════════════════════════════════════════════════════════════════
//  CONFIG — matches T13 exactly
// ═══════════════════════════════════════════════════════════════════

const TICKER = 'SPY';
const LOOKBACK = 21;
const RISK_FREE = 0.05;
const MIN_DTE = 14;
const MAX_DTE = 45;
const TARGET_DTE = 28;
const CLOSE_DTE = 5;
const WARMUP_DAYS = 30;
const INITIAL_CASH = 100_000;
const SPREAD_FILTER = 0.15;

// Position sizing
const BASE_ALLOC = 0.06;
const MAX_ALLOC = 0.14;
const MAX_CONTRACTS = 20;
const MAX_POSITIONS = 8;
const MAX_PER_SIGNAL_TYPE = 3;
const MAX_LONG_CALLS = 2;

// Signal thresholds
const ENTROPY_PERCENTILE = 30;
const VOLCOLLAPSE_PERCENTILE = 85;
const PCR_PERCENTILE = 80;
const MIN_STRENGTH = 0.20;

// Exit rules
const PROFIT_TARGET_DEBIT = 0.80;
const PROFIT_TARGET_CREDIT = 0.50;
const STOP_LOSS_DEBIT = -0.60;
const STOP_LOSS_CREDIT = -1.50;

// Gallacher defense thresholds
const IV_STRESSED_PCT = 80;
const IV_EXTREME_PCT = 95;
const IV_STRESSED_FLOOR = 0.18;
const IV_EXTREME_FLOOR = 0.25;
const MAD_STRESSED_MULT = 1.5;
const MAD_EXTREME_MULT = 2.5;
const MAD_STRESSED_FLOOR = 0.008;
const MAD_EXTREME_FLOOR = 0.015;
const MAD_WINDOW = 10;
const MAD_BASELINE_LOOKBACK = 42;
const STRESSED_SIZE_MULT = 0.50;
const REGIME_COOLDOWN_DAYS = 5;

const TRADIER_BASE_URL = 'https://api.tradier.com/v1';
const FETCH_TIMEOUT = 12_000;

/**
 * Get today's date string in Eastern Time (matching Python's date.today() when run at 3:50pm ET).
 */
function todayET(): string {
  const now = new Date();
  // Use Intl to get ET date reliably (handles DST)
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${etDate.getFullYear()}-${String(etDate.getMonth() + 1).padStart(2, '0')}-${String(etDate.getDate()).padStart(2, '0')}`;
}

/** Check if a YYYY-MM-DD string is a US equity trading day. */
function isTradingDay(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;

  const mmdd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (['01-01', '06-19', '07-04', '12-25'].includes(mmdd)) return false;

  if (m === 1 && dow === 1 && d >= 15 && d <= 21) return false; // MLK
  if (m === 2 && dow === 1 && d >= 15 && d <= 21) return false; // Presidents
  if (m === 5 && dow === 1 && d >= 25) return false;            // Memorial
  if (m === 9 && dow === 1 && d <= 7) return false;             // Labor
  if (m === 11 && dow === 4 && d >= 22 && d <= 28) return false; // Thanksgiving

  // Good Friday: 2 days before Easter
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const dd = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const eMonth = Math.floor((h + l - 7 * mm + 114) / 31);
  const eDay = ((h + l - 7 * mm + 114) % 31) + 1;
  const gf = new Date(y, eMonth - 1, eDay);
  gf.setDate(gf.getDate() - 2);
  if (m === gf.getMonth() + 1 && d === gf.getDate()) return false;

  return true;
}

// ═══════════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════════

interface RawContract {
  symbol: string;
  strike: number;
  expiry: string;
  dte: number;
  is_call: boolean;
  bid: number;
  ask: number;
  mid: number;
  volume: number;
  open_interest: number;
}

interface EnrichedRecord {
  symbol: string;
  strike: number;
  expiry: string;
  dte: number;
  is_call: boolean;
  mid: number;
  bid: number;
  ask: number;
  spread: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  moneyness: number;
}

interface EntropyMetrics {
  H_vol_term_n: number | null;
  H_vol_k_n: number | null;
  H_prem_term_n: number | null;
  H_vegavol_n: number | null;
  H_dgamma_n: number | null;
  dgamma_conc5: number | null;
  H_gvx_n: number | null;
  H_dflow_n: number | null;
  H_spread_k_n: number | null;
  H_moneyness_n: number | null;
  H_charm_n: number | null;
  iv_mean: number | null;
  put_skew: number | null;
  pcr_dollar: number | null;
  pcr_vol: number | null;
  comp_volume: number | null;
  comp_greek: number | null;
  composite: number | null;
  _n_records: number;
  _chain: EnrichedRecord[];
  [key: string]: unknown;
}

interface Signal {
  fire: boolean;
  strength: number;
  direction: number;
  trade_type: string;
  rationale: string;
}

interface ContractSelection {
  type: 'single' | 'spread';
  contract?: EnrichedRecord;
  qty_sign?: number;
  long?: EnrichedRecord;
  short?: EnrichedRecord;
}

interface PositionRow {
  id: number;
  strategy: string;
  symbol: string;
  trade_type: string;
  qty: number;
  entry_price: number;
  entry_cost: number;
  entry_date: string;
  strike: number;
  expiry: string;
  is_credit: number;
  is_open: number;
  close_date: string | null;
  close_reason: string | null;
  close_pnl: number | null;
  fill_corrected: number;
}

export interface RunResult {
  success: boolean;
  date: string;
  status: 'already_ran' | 'september_skip' | 'warmup' | 'executed' | 'error' | 'skipped';
  message: string;
  metrics?: Record<string, number | null>;
  signalsFired?: string[];
  tradesExecuted?: string[];
  portfolioValue?: number;
  regime?: string;
}

// ═══════════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');

type BetterSqlite3Database = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
  close(): void;
};

function resolveDbPath(): string {
  if (process.env.ENGINE_DB_PATH) return process.env.ENGINE_DB_PATH;
  // Try cwd/data first (local dev), fall back to /tmp/entropy (serverless/containers)
  const cwdData = path.join(process.cwd(), 'data');
  try {
    if (!fs.existsSync(cwdData)) fs.mkdirSync(cwdData, { recursive: true });
    // Test writability
    const testFile = path.join(cwdData, '.write-test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
    return path.join(cwdData, 'entropy_engine.db');
  } catch {
    // cwd not writable (serverless) — use /tmp
    const tmpDir = path.join('/tmp', 'entropy-data');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    return path.join(tmpDir, 'entropy_engine.db');
  }
}

function getDb(): BetterSqlite3Database {
  const dbPath = resolveDbPath();
  return new Database(dbPath);
}

function initDb(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entropy_history (
      date TEXT PRIMARY KEY,
      spot REAL,
      metrics_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trade_type TEXT,
      qty INTEGER,
      entry_price REAL,
      entry_cost REAL,
      entry_date TEXT,
      strike REAL,
      expiry TEXT,
      is_credit INTEGER,
      is_open INTEGER DEFAULT 1,
      close_date TEXT,
      close_reason TEXT,
      close_pnl REAL,
      fill_corrected INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trades_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      strategy TEXT,
      action TEXT,
      symbol TEXT,
      qty INTEGER,
      price REAL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS equity_curve (
      date TEXT PRIMARY KEY,
      portfolio_value REAL,
      cash REAL,
      positions_value REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS signals_log (
      date TEXT,
      strategy TEXT,
      fired INTEGER,
      strength REAL,
      trade_type TEXT,
      rationale TEXT,
      executed INTEGER DEFAULT 0,
      PRIMARY KEY (date, strategy)
    );
    CREATE TABLE IF NOT EXISTS regime_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ═══════════════════════════════════════════════════════════════════
//  GALLACHER DEFENSE LAYER
// ═══════════════════════════════════════════════════════════════════

interface RegimeDetails {
  iv_check: string;
  mad_check: string;
  raw: string;
}

function assessRegime(
  ivMean: number,
  history: HistoryEntry[],
  spotHistory: number[],
  currentRegime: string,
  tradingDays: number,
  lastRegimeChangeDay: number,
): { regime: string; details: RegimeDetails } {
  let rawRegime = 'NORMAL';
  const details: RegimeDetails = { iv_check: 'N/A', mad_check: 'N/A', raw: 'NORMAL' };

  // IV check: percentile AND absolute floor
  if (history.length >= LOOKBACK) {
    const ivHist = history
      .slice(-LOOKBACK)
      .map((h) => h.iv_mean)
      .filter((v): v is number => v != null && typeof v === 'number');
    if (ivHist.length >= Math.floor(LOOKBACK / 2)) {
      const ivP80 = percentileValue(ivHist, IV_STRESSED_PCT);
      const ivP95 = percentileValue(ivHist, IV_EXTREME_PCT);
      if (ivMean > ivP95 && ivMean > IV_EXTREME_FLOOR) {
        rawRegime = 'EXTREME';
        details.iv_check = `EXTREME: iv=${ivMean.toFixed(3)} > p95=${ivP95.toFixed(3)} & floor=${IV_EXTREME_FLOOR}`;
      } else if (ivMean > ivP80 && ivMean > IV_STRESSED_FLOOR) {
        rawRegime = 'STRESSED';
        details.iv_check = `STRESSED: iv=${ivMean.toFixed(3)} > p80=${ivP80.toFixed(3)} & floor=${IV_STRESSED_FLOOR}`;
      } else {
        details.iv_check = `NORMAL: iv=${ivMean.toFixed(3)}`;
      }
    }
  }

  // MAD check: relative AND absolute floor
  const minCloses = MAD_WINDOW + MAD_BASELINE_LOOKBACK;
  if (spotHistory.length >= minCloses) {
    const returns: number[] = [];
    for (let i = 1; i < spotHistory.length; i++) {
      returns.push(Math.abs(spotHistory[i] / spotHistory[i - 1] - 1));
    }
    if (returns.length >= MAD_WINDOW) {
      const currentMad = returns.slice(-MAD_WINDOW).reduce((a, b) => a + b, 0) / MAD_WINDOW;
      const madHistory: number[] = [];
      for (let j = MAD_WINDOW; j < returns.length; j++) {
        madHistory.push(returns.slice(j - MAD_WINDOW, j).reduce((a, b) => a + b, 0) / MAD_WINDOW);
      }
      const baselineLen = Math.min(madHistory.length, MAD_BASELINE_LOOKBACK);
      if (baselineLen >= LOOKBACK) {
        const madSlice = madHistory.slice(-baselineLen).sort((a, b) => a - b);
        const mid = Math.floor(madSlice.length / 2);
        const madMedian =
          madSlice.length % 2 === 0 ? (madSlice[mid - 1] + madSlice[mid]) / 2 : madSlice[mid];
        if (madMedian > 0) {
          const madRatio = currentMad / madMedian;
          if (madRatio > MAD_EXTREME_MULT && currentMad > MAD_EXTREME_FLOOR) {
            rawRegime = 'EXTREME';
            details.mad_check = `EXTREME: mad=${currentMad.toFixed(4)} ratio=${madRatio.toFixed(1)}x`;
          } else if (
            madRatio > MAD_STRESSED_MULT &&
            currentMad > MAD_STRESSED_FLOOR &&
            rawRegime !== 'EXTREME'
          ) {
            rawRegime = 'STRESSED';
            details.mad_check = `STRESSED: mad=${currentMad.toFixed(4)} ratio=${madRatio.toFixed(1)}x`;
          } else {
            details.mad_check = `NORMAL: mad=${currentMad.toFixed(4)} ratio=${madRatio.toFixed(1)}x`;
          }
        }
      }
    }
  }

  details.raw = rawRegime;

  // Sticky decay: regime can only DOWNGRADE 1 level per cooldown period
  const levels: Record<string, number> = { NORMAL: 0, STRESSED: 1, EXTREME: 2 };
  const currentLevel = levels[currentRegime] ?? 0;
  const rawLevel = levels[rawRegime];

  if (rawLevel >= currentLevel) {
    return { regime: rawRegime, details };
  } else {
    const daysSince = tradingDays - lastRegimeChangeDay;
    if (daysSince >= REGIME_COOLDOWN_DAYS) {
      const newLevel = Math.max(rawLevel, currentLevel - 1);
      const levelNames: Record<number, string> = { 0: 'NORMAL', 1: 'STRESSED', 2: 'EXTREME' };
      return { regime: levelNames[newLevel], details };
    }
    return { regime: currentRegime, details };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  BSM IV SOLVER (Brent's method)
// ═══════════════════════════════════════════════════════════════════

function brentIV(
  price: number,
  S: number,
  K: number,
  T: number,
  r: number,
  isCall: boolean,
): number | null {
  if (T <= 1e-6 || price <= 0) return null;

  const disc = Math.exp(-r * T);
  const intrinsic = isCall ? Math.max(S - K * disc, 0) : Math.max(K * disc - S, 0);
  if (price < intrinsic * 0.90) return null;

  const priceFn = (sigma: number): number => {
    const params = { S, K, T, r, sigma };
    return (isCall ? bsCallPrice(params) : bsPutPrice(params)) - price;
  };

  let a = 0.01;
  let b = 5.0;
  const tol = 1e-5;
  const maxIter = 80;

  let fa = priceFn(a);
  let fb = priceFn(b);

  if (fa * fb > 0) return null;

  // Ensure |f(a)| >= |f(b)|
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }

  let c = a;
  let fc = fa;
  let mflag = true;
  let d = 0;
  let s: number;

  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(fb) < tol) return b;
    if (Math.abs(b - a) < tol) return b;

    if (fa !== fc && fb !== fc) {
      // Inverse quadratic interpolation
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      // Secant
      s = b - fb * (b - a) / (fb - fa);
    }

    const cond1 = s < (3 * a + b) / 4 || s > b;
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag && Math.abs(b - c) < tol;
    const cond5 = !mflag && Math.abs(c - d) < tol;

    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }

    const fs = priceFn(s);
    d = c;
    c = b;
    fc = fb;

    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }

    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }

  return Math.abs(fb) < 0.01 ? b : null;
}

// ═══════════════════════════════════════════════════════════════════
//  TRADIER — raw chain fetch (production API for market data)
// ═══════════════════════════════════════════════════════════════════

function tradierHeaders(): Record<string, string> {
  const token = process.env.TRADIER_API_KEY;
  if (!token) throw new Error('TRADIER_API_KEY not configured');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

async function fetchRawChain(): Promise<RawContract[]> {
  // Fetch expirations
  const expRes = await fetch(
    `${TRADIER_BASE_URL}/markets/options/expirations?symbol=${TICKER}&includeAllRoots=true`,
    { headers: tradierHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  if (!expRes.ok) {
    throw new Error(`Failed to get expirations: ${expRes.status}`);
  }
  const expData = await expRes.json();
  let exps: string[] = expData.expirations?.date ?? [];
  if (typeof exps === 'string') exps = [exps];

  const today = new Date();
  const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const validExps = exps.filter((expStr) => {
    const [y, m, d] = expStr.split('-').map(Number);
    const expDate = new Date(y, m - 1, d);
    const dte = Math.round((expDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));
    return dte >= MIN_DTE && dte <= MAX_DTE;
  });

  if (validExps.length === 0) return [];

  const allContracts: RawContract[] = [];

  for (const exp of validExps) {
    const chainRes = await fetch(
      `${TRADIER_BASE_URL}/markets/options/chains?symbol=${TICKER}&expiration=${exp}&greeks=false`,
      { headers: tradierHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT) },
    );
    if (!chainRes.ok) continue;

    const chainData = await chainRes.json();
    let options = chainData.options?.option;
    if (!options) continue;
    if (!Array.isArray(options)) options = [options];

    const [ey, em, ed] = exp.split('-').map(Number);
    const expDate = new Date(ey, em - 1, ed);
    const dte = Math.round((expDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));

    for (const o of options) {
      const bid = parseFloat(o.bid ?? 0) || 0;
      const ask = parseFloat(o.ask ?? 0) || 0;
      allContracts.push({
        symbol: o.symbol ?? '',
        strike: parseFloat(o.strike ?? 0),
        expiry: exp,
        dte,
        is_call: o.option_type === 'call',
        bid,
        ask,
        mid: (bid + ask) / 2,
        volume: parseInt(o.volume ?? 0, 10) || 0,
        open_interest: parseInt(o.open_interest ?? 0, 10) || 0,
      });
    }
  }

  return allContracts;
}

// ═══════════════════════════════════════════════════════════════════
//  ENTROPY COMPUTATION — identical to T13
// ═══════════════════════════════════════════════════════════════════

function hNorm(dist: number[]): number {
  const d = dist.filter((v) => v > 0);
  if (d.length <= 1) return 0.0;
  const sum = d.reduce((a, b) => a + b, 0);
  const normalized = d.map((v) => v / sum);
  const h = -normalized.reduce((acc, p) => acc + p * Math.log2(p), 0);
  return h / Math.log2(d.length);
}

function computeEntropy(
  contracts: RawContract[],
  spot: number,
): EntropyMetrics | null {
  if (spot <= 0) return null;

  const recs: EnrichedRecord[] = [];

  for (const c of contracts) {
    if (c.mid <= 0 || c.bid <= 0) continue;
    if (c.dte <= 0) continue;

    const K = c.strike;
    const T = c.dte / 365.0;
    const isCall = c.is_call;

    const iv = brentIV(c.mid, spot, K, T, RISK_FREE, isCall);
    if (iv === null) continue;

    const params = { S: spot, K, T, r: RISK_FREE, sigma: iv };
    const gVal = bsGamma(params);
    const dVal = bsDelta(params, isCall ? 'call' : 'put');
    const vVal = bsVega(params);
    // Theta computed inline (matching Python's formula)
    const d1 =
      (Math.log(spot / K) + (RISK_FREE + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
    const d2 = d1 - iv * Math.sqrt(T);
    const nd1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
    const expRT = Math.exp(-RISK_FREE * T);
    let thetaVal: number;
    if (isCall) {
      thetaVal =
        (-spot * nd1 * iv / (2 * Math.sqrt(T)) -
          RISK_FREE * K * expRT * normCDFInline(d2)) / 365;
    } else {
      thetaVal =
        (-spot * nd1 * iv / (2 * Math.sqrt(T)) +
          RISK_FREE * K * expRT * normCDFInline(-d2)) / 365;
    }

    recs.push({
      symbol: c.symbol,
      strike: K,
      expiry: c.expiry,
      dte: c.dte,
      is_call: isCall,
      mid: c.mid,
      bid: c.bid,
      ask: c.ask,
      spread: c.ask - c.bid,
      volume: c.volume,
      iv,
      delta: dVal,
      gamma: gVal,
      vega: vVal,
      theta: thetaVal,
      moneyness: K / spot,
    });
  }

  if (recs.length < 10) return null;

  const m: Record<string, number | null> = {};

  // Volume entropy by expiry
  const ev: Record<string, number> = {};
  for (const r of recs) ev[r.expiry] = (ev[r.expiry] ?? 0) + r.volume;
  const veVals = Object.values(ev);
  const veSum = veVals.reduce((a, b) => a + b, 0);
  m.H_vol_term_n = veSum > 0 ? hNorm(veVals) : null;

  // Volume by strike
  const sv: Record<number, number> = {};
  for (const r of recs) sv[r.strike] = (sv[r.strike] ?? 0) + r.volume;
  const vkVals = Object.values(sv);
  const vkSum = vkVals.reduce((a, b) => a + b, 0);
  m.H_vol_k_n = vkSum > 0 ? hNorm(vkVals) : null;

  // Premium by expiry
  const ep: Record<string, number> = {};
  for (const r of recs) {
    ep[r.expiry] = (ep[r.expiry] ?? 0) + r.mid * Math.max(r.volume, 1) * 100;
  }
  const peVals = Object.values(ep).map(Math.abs);
  const peSum = peVals.reduce((a, b) => a + b, 0);
  m.H_prem_term_n = peSum > 0 ? hNorm(peVals) : null;

  // Vega-weighted volume by strike
  const vv: Record<number, number> = {};
  for (const r of recs) {
    vv[r.strike] = (vv[r.strike] ?? 0) + Math.abs(r.vega) * r.volume;
  }
  const vvVals = Object.values(vv);
  const vvSum = vvVals.reduce((a, b) => a + b, 0);
  m.H_vegavol_n = vvSum > 0 ? hNorm(vvVals) : null;

  // Dollar gamma by strike
  const dg: Record<number, number> = {};
  for (const r of recs) {
    dg[r.strike] = (dg[r.strike] ?? 0) + Math.abs(r.gamma) * r.volume * spot * 100;
  }
  const daVals = Object.values(dg);
  const daSum = daVals.reduce((a, b) => a + b, 0);
  if (daSum > 0) {
    const sorted = [...daVals].sort((a, b) => b - a);
    m.dgamma_conc5 = sorted.slice(0, 5).reduce((a, b) => a + b, 0) / daSum;
    m.H_dgamma_n = hNorm(daVals);
  } else {
    m.dgamma_conc5 = null;
    m.H_dgamma_n = null;
  }

  // Gamma x volume by strike
  const gv: Record<number, number> = {};
  for (const r of recs) {
    gv[r.strike] = (gv[r.strike] ?? 0) + Math.abs(r.gamma) * r.volume;
  }
  const gvVals = Object.values(gv);
  const gvSum = gvVals.reduce((a, b) => a + b, 0);
  m.H_gvx_n = gvSum > 0 ? hNorm(gvVals) : null;

  // Delta-bucket flow
  const dflow = new Array(10).fill(0);
  for (const r of recs) {
    const ad = Math.abs(r.delta);
    for (let b = 0; b < 10; b++) {
      const lo = b * 0.1;
      const hi = (b + 1) * 0.1;
      if (ad >= lo && ad < hi) {
        dflow[b] += r.volume;
        break;
      }
    }
  }
  const dflowSum = dflow.reduce((a: number, b: number) => a + b, 0);
  m.H_dflow_n = dflowSum > 0 ? hNorm(dflow) : null;

  // Spread liquidity by strike (volume / spread)
  const sl: Record<number, number> = {};
  for (const r of recs) {
    if (r.spread > 0 && r.volume > 0) {
      sl[r.strike] = (sl[r.strike] ?? 0) + r.volume / r.spread;
    }
  }
  const slVals = Object.values(sl);
  const slSum = slVals.reduce((a, b) => a + b, 0);
  m.H_spread_k_n = slVals.length > 0 && slSum > 0 ? hNorm(slVals) : 0.5;

  // Moneyness buckets
  const mb = Array.from({ length: 16 }, (_, i) => 0.85 + i * 0.02);
  const mv = new Array(mb.length - 1).fill(0);
  for (const r of recs) {
    for (let b = 0; b < mb.length - 1; b++) {
      if (r.moneyness >= mb[b] && r.moneyness < mb[b + 1]) {
        mv[b] += r.volume;
        break;
      }
    }
  }
  const mvSum = mv.reduce((a: number, b: number) => a + b, 0);
  m.H_moneyness_n = mvSum > 0 ? hNorm(mv) : null;

  // Charm by DTE bucket (range(MIN_DTE, MAX_DTE+2, 5))
  const cb: number[] = [];
  for (let d = MIN_DTE; d < MAX_DTE + 2; d += 5) cb.push(d);
  const cvArr = new Array(cb.length - 1).fill(0);
  for (const r of recs) {
    const charmVal =
      r.iv > 0
        ? Math.abs(r.gamma * (RISK_FREE - (r.iv * r.iv) / 2) / r.iv)
        : 0;
    for (let b = 0; b < cb.length - 1; b++) {
      if (r.dte >= cb[b] && r.dte < cb[b + 1]) {
        cvArr[b] += Math.abs(charmVal);
        break;
      }
    }
  }
  const cvSum = cvArr.reduce((a: number, b: number) => a + b, 0);
  m.H_charm_n = cvSum > 0 ? hNorm(cvArr) : null;

  // IV mean (ATM near-term, fallback to all)
  const atmNear = recs.filter((r) => r.moneyness >= 0.97 && r.moneyness <= 1.03 && r.dte <= 30);
  if (atmNear.length > 0) {
    m.iv_mean = mean(atmNear.map((r) => r.iv));
  } else {
    m.iv_mean = mean(recs.map((r) => r.iv));
  }

  // Put skew
  const nearPuts = recs.filter((r) => !r.is_call && r.dte >= 14 && r.dte <= 45);
  const atmPutIvs = nearPuts
    .filter((r) => r.moneyness >= 0.98 && r.moneyness <= 1.02)
    .map((r) => r.iv);
  const otmPutIvs = nearPuts
    .filter((r) => r.moneyness >= 0.90 && r.moneyness <= 0.95)
    .map((r) => r.iv);
  const atmIv = atmPutIvs.length > 0 ? mean(atmPutIvs) : NaN;
  const otmIv = otmPutIvs.length > 0 ? mean(otmPutIvs) : NaN;
  m.put_skew = !isNaN(atmIv) && !isNaN(otmIv) ? otmIv - atmIv : null;

  // PCR
  const calls = recs.filter((r) => r.is_call);
  const puts = recs.filter((r) => !r.is_call);
  const cprem = calls.reduce((s, r) => s + r.mid * r.volume, 0);
  const pprem = puts.reduce((s, r) => s + r.mid * r.volume, 0);
  m.pcr_dollar = cprem > 0 ? pprem / cprem : null;
  const cvol = calls.reduce((s, r) => s + r.volume, 0);
  const pvol = puts.reduce((s, r) => s + r.volume, 0);
  m.pcr_vol = cvol > 0 ? pvol / cvol : null;

  // Composites
  const cvComps = [m.H_vol_term_n, m.H_vol_k_n, m.H_prem_term_n, m.H_dflow_n].filter(
    (v): v is number => v !== null,
  );
  m.comp_volume = cvComps.length > 0 ? mean(cvComps) : null;

  const cgComps = [
    m.H_vegavol_n,
    m.H_dgamma_n,
    m.H_gvx_n,
    m.H_spread_k_n,
    m.H_charm_n,
  ].filter((v): v is number => v !== null);
  m.comp_greek = cgComps.length > 0 ? mean(cgComps) : null;

  const allComps = [
    m.H_vol_term_n,
    m.H_vol_k_n,
    m.H_prem_term_n,
    m.H_vegavol_n,
    m.H_dgamma_n,
    m.H_gvx_n,
    m.H_dflow_n,
    m.H_spread_k_n,
    m.H_moneyness_n,
    m.H_charm_n,
  ].filter((v): v is number => v !== null);
  m.composite = allComps.length > 0 ? mean(allComps) : null;

  return {
    ...m,
    _n_records: recs.length,
    _chain: recs,
  } as EntropyMetrics;
}

// ═══════════════════════════════════════════════════════════════════
//  SIGNAL EVALUATION — identical to T13
// ═══════════════════════════════════════════════════════════════════

interface HistoryEntry {
  [key: string]: number | null | undefined;
}

function getHistory(db: BetterSqlite3Database, days: number = 60): HistoryEntry[] {
  const rows = db
    .prepare('SELECT date, metrics_json FROM entropy_history ORDER BY date DESC LIMIT ?')
    .all(days) as { date: string; metrics_json: string }[];
  return rows.reverse().map((r) => JSON.parse(r.metrics_json) as HistoryEntry);
}

function med(history: HistoryEntry[], key: string, lookback: number = LOOKBACK): number | null {
  const vals = history
    .slice(-lookback)
    .map((h) => h[key])
    .filter((v): v is number => v != null && typeof v === 'number');
  if (vals.length < Math.floor(lookback / 2)) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pct(history: HistoryEntry[], key: string, percentile: number): number | null {
  const vals = history
    .map((h) => h[key])
    .filter((v): v is number => v != null && typeof v === 'number')
    .sort((a, b) => a - b);
  if (vals.length < Math.floor(LOOKBACK / 2)) return null;
  const idx = (percentile / 100) * (vals.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return vals[lo];
  return vals[lo] + (vals[hi] - vals[lo]) * (idx - lo);
}

function diff(history: HistoryEntry[], key: string, lag: number = 1): number | null {
  const vals = history
    .map((h) => h[key])
    .filter((v): v is number => v != null && typeof v === 'number');
  if (vals.length >= lag + 1) {
    return vals[vals.length - 1] - vals[vals.length - 1 - lag];
  }
  return null;
}

function stdVal(history: HistoryEntry[], key: string): number {
  const vals = history
    .slice(-LOOKBACK)
    .map((h) => h[key])
    .filter((v): v is number => v != null && typeof v === 'number');
  if (vals.length <= 1) return 0.01;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / (vals.length - 1));
}

function zStrength(val: number, key: string, history: HistoryEntry[]): number {
  const m = med(history, key);
  const s = stdVal(history, key);
  if (m == null || s < 1e-8) return 0.0;
  return Math.max(0.0, Math.min(1.0, (m - val) / s / 3.0));
}

function evaluateSignals(
  metrics: EntropyMetrics,
  history: HistoryEntry[],
): Record<string, Signal> {
  const sigs: Record<string, Signal> = {};
  const ep = ENTROPY_PERCENTILE;

  const cv = metrics.comp_volume;
  const cg = metrics.comp_greek;
  const co = metrics.composite;
  const iv = metrics.iv_mean;
  const ps = metrics.put_skew;
  const pcr = metrics.pcr_vol;

  // Percentile thresholds
  const tCv = pct(history, 'comp_volume', ep);
  const tCg = pct(history, 'comp_greek', ep);
  const tCc = pct(history, 'composite', ep);
  const tIv = pct(history, 'iv_mean', ep);
  const psM = med(history, 'put_skew');
  const ivM = med(history, 'iv_mean');

  // S_LowVolEnt
  if (cv != null && tCv != null) {
    const fire = cv < tCv;
    const s = fire ? zStrength(cv, 'comp_volume', history) : 0;
    const tt = iv != null && ivM != null && iv < ivM ? 'buy_call' : 'sell_put';
    sigs.S_LowVolEnt = {
      fire: fire && s >= MIN_STRENGTH,
      strength: s,
      direction: 1,
      trade_type: tt,
      rationale: `cv=${cv.toFixed(4)} ${fire ? '<' : '>='} p${ep}=${tCv.toFixed(4)} s=${s.toFixed(2)}`,
    };
  }

  // S_VolCollapse — drop > 85th percentile of all historical drops
  if (history.length >= 2) {
    const histVals = history.map((h) => h.comp_volume).filter((v): v is number => v != null);
    const currCv = metrics.comp_volume;
    if (histVals.length >= 2 && currCv != null) {
      const prevCv = histVals[histVals.length - 1] as number;
      const drop = prevCv - currCv;
      const drops: number[] = [];
      for (let i = 1; i < histVals.length; i++) {
        const d = (histVals[i - 1] as number) - (histVals[i] as number);
        if (d > 0) drops.push(d);
      }
      if (drops.length > 0 && drop > 0) {
        const thresh = percentileValue(drops, VOLCOLLAPSE_PERCENTILE);
        const fire = drop > thresh;
        const s = fire ? Math.max(MIN_STRENGTH, Math.min(1.0, drop / (thresh + 1e-8) - 1.0)) : 0;
        sigs.S_VolCollapse = {
          fire: fire && s >= MIN_STRENGTH,
          strength: s,
          direction: 1,
          trade_type: 'bull_call_spread',
          rationale: `drop=${drop.toFixed(4)} ${fire ? '>' : '<='} p${VOLCOLLAPSE_PERCENTILE}=${thresh.toFixed(4)}`,
        };
      }
    }
  }

  // S_LowEntLowIV
  if (co != null && tCc != null && iv != null && tIv != null) {
    const fire = co < tCc && iv < tIv;
    const s = fire ? zStrength(co, 'composite', history) : 0;
    sigs.S_LowEntLowIV = {
      fire: fire && s >= MIN_STRENGTH,
      strength: s,
      direction: 1,
      trade_type: 'buy_call_longer',
      rationale: `co=${co.toFixed(4)} iv=${iv.toFixed(4)}`,
    };
  }

  // S_LowGreekEnt
  if (cg != null && tCg != null) {
    const fire = cg < tCg;
    const s = fire ? zStrength(cg, 'comp_greek', history) : 0;
    sigs.S_LowGreekEnt = {
      fire: fire && s >= MIN_STRENGTH,
      strength: s,
      direction: 1,
      trade_type: 'sell_put',
      rationale: `cg=${cg.toFixed(4)} ${fire ? '<' : '>='} p${ep}=${tCg.toFixed(4)} s=${s.toFixed(2)}`,
    };
  }

  // S_SkewFlow — requires comp_volume < 30th pct AND put_skew > median AND put_skew > 0.01
  if (cv != null && tCv != null && ps != null && psM != null) {
    const fire = cv < tCv && ps > psM && ps > 0.01;
    const s = fire ? zStrength(cv, 'comp_volume', history) : 0;
    sigs.S_SkewFlow = {
      fire: fire && s >= MIN_STRENGTH,
      strength: s,
      direction: 1,
      trade_type: 'sell_put_spread',
      rationale: `cv=${cv.toFixed(4)} sk=${ps.toFixed(4)} ${psM && ps > psM ? '>' : '<='} med=${psM.toFixed(4)}`,
    };
  }

  // S_PCRContrarian — uses pcr_vol > 80th percentile
  if (pcr != null) {
    const pcrP80 = pct(history, 'pcr_vol', PCR_PERCENTILE);
    if (pcrP80 != null) {
      const fire = pcr > pcrP80;
      const pcrStd = stdVal(history, 'pcr_vol');
      const s = fire ? Math.min(1.0, (pcr - pcrP80) / (pcrStd + 1e-8)) : 0;
      sigs.S_PCRContrarian = {
        fire: fire && s >= MIN_STRENGTH,
        strength: s,
        direction: 1,
        trade_type: 'sell_put',
        rationale: `pcr_vol=${pcr.toFixed(4)} ${fire ? '>' : '<='} p${PCR_PERCENTILE}=${pcrP80.toFixed(4)}`,
      };
    }
  }

  return sigs;
}

// ═══════════════════════════════════════════════════════════════════
//  CONTRACT SELECTION — identical to T13
// ═══════════════════════════════════════════════════════════════════

function selectContract(
  recs: EnrichedRecord[],
  spot: number,
  tt: string,
  usedSymbols: Set<string>,
): ContractSelection | null {
  const avail = recs.filter((r) => !usedSymbols.has(r.symbol));
  const elig = avail.filter((r) => r.dte >= MIN_DTE && r.dte <= MAX_DTE);
  if (elig.length === 0) return null;

  elig.sort((a, b) => Math.abs(a.dte - TARGET_DTE) - Math.abs(b.dte - TARGET_DTE));
  const bestExp = elig[0].expiry;
  const ae = elig.filter((r) => r.expiry === bestExp);
  const ca = ae.filter((r) => r.is_call).sort((a, b) => a.strike - b.strike);
  const pa = ae.filter((r) => !r.is_call).sort((a, b) => a.strike - b.strike);
  const atmK = ae.reduce((best, r) =>
    Math.abs(r.moneyness - 1.0) < Math.abs(best.moneyness - 1.0) ? r : best,
  ).strike;

  if (tt === 'buy_call') {
    let cs = ca.filter((r) => r.moneyness >= 0.99 && r.moneyness <= 1.01 && r.mid > 0.10);
    if (cs.length === 0) {
      cs = ca.filter((r) => Math.abs(r.strike - atmK) <= 2 && r.mid > 0);
    }
    if (cs.length > 0) {
      const c = cs.reduce((best, r) =>
        Math.abs(r.moneyness - 1.0) < Math.abs(best.moneyness - 1.0) ? r : best,
      );
      if (c.spread < c.mid * SPREAD_FILTER) {
        return { type: 'single', contract: c, qty_sign: 1 };
      }
    }
  } else if (tt === 'buy_call_longer') {
    const lo = avail.filter(
      (r) =>
        r.is_call &&
        r.dte >= 25 &&
        r.dte <= 45 &&
        r.moneyness >= 0.99 &&
        r.moneyness <= 1.01 &&
        r.mid > 0.10 &&
        !usedSymbols.has(r.symbol),
    );
    if (lo.length > 0) {
      const c = lo.reduce((best, r) =>
        Math.abs(r.dte - 35) < Math.abs(best.dte - 35) ? r : best,
      );
      if (c.spread < c.mid * SPREAD_FILTER) {
        return { type: 'single', contract: c, qty_sign: 1 };
      }
    }
  } else if (tt === 'sell_put') {
    const ot = pa.filter(
      (r) => r.moneyness >= 0.96 && r.moneyness <= 0.98 && r.mid > 0.10,
    );
    if (ot.length > 0) {
      const c = ot.reduce((best, r) =>
        Math.abs(r.dte - TARGET_DTE) < Math.abs(best.dte - TARGET_DTE) ? r : best,
      );
      if (c.spread < c.mid * SPREAD_FILTER) {
        return { type: 'single', contract: c, qty_sign: -1 };
      }
    }
  } else if (tt === 'bull_call_spread') {
    const lc = ca.filter((r) => r.moneyness >= 0.99 && r.moneyness <= 1.01 && r.mid > 0);
    const sc = ca.filter((r) => r.moneyness >= 1.02 && r.moneyness <= 1.04 && r.mid > 0);
    if (lc.length > 0 && sc.length > 0) {
      const l = lc.reduce((best, r) =>
        Math.abs(r.moneyness - 1.0) < Math.abs(best.moneyness - 1.0) ? r : best,
      );
      const s = sc.reduce((best, r) =>
        Math.abs(r.moneyness - 1.03) < Math.abs(best.moneyness - 1.03) ? r : best,
      );
      if (l.expiry === s.expiry && l.mid > s.mid) {
        return { type: 'spread', long: l, short: s };
      }
    }
  } else if (tt === 'sell_put_spread') {
    const spList = pa.filter(
      (r) => r.moneyness >= 0.97 && r.moneyness <= 0.99 && r.mid > 0.10,
    );
    const lp = pa.filter(
      (r) => r.moneyness >= 0.94 && r.moneyness <= 0.96 && r.mid > 0.05,
    );
    if (spList.length > 0 && lp.length > 0) {
      const s = spList.reduce((best, r) =>
        Math.abs(r.moneyness - 0.98) < Math.abs(best.moneyness - 0.98) ? r : best,
      );
      const l = lp.reduce((best, r) =>
        Math.abs(r.moneyness - 0.95) < Math.abs(best.moneyness - 0.95) ? r : best,
      );
      if (s.expiry === l.expiry && s.strike > l.strike && s.mid > l.mid) {
        return { type: 'spread', short: s, long: l };
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  POSITION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

async function managePositions(
  db: BetterSqlite3Database,
  todayStr: string,
): Promise<void> {
  const positions = db
    .prepare('SELECT * FROM positions WHERE is_open = 1')
    .all() as PositionRow[];

  const [ty, tm, td] = todayStr.split('-').map(Number);
  const todayDate = new Date(ty, tm - 1, td);

  for (const pos of positions) {
    const [ey, em, ed] = pos.expiry.split('-').map(Number);
    const expiryDate = new Date(ey, em - 1, ed);
    const dte = Math.round(
      (expiryDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    // DTE close
    if (dte <= CLOSE_DTE) {
      await closePositionDb(db, pos, todayStr, 'DTE', 0);
      continue;
    }

    // Get current price
    const quote = await getOptionQuote(pos.symbol);
    if (!quote) continue;

    const currentMid = (quote.bid + quote.ask) / 2;
    if (currentMid <= 0 && quote.bid <= 0) continue;

    const entryCost = pos.entry_cost;
    const currentValue = currentMid * 100 * Math.abs(pos.qty);
    const pnl = pos.qty > 0 ? currentValue - entryCost : entryCost - currentValue;

    if (pos.is_credit) {
      const credit = Math.abs(entryCost);
      if (credit > 0) {
        if (pnl >= credit * PROFIT_TARGET_CREDIT) {
          await closePositionDb(db, pos, todayStr, 'TP', pnl);
          continue;
        }
        if (pnl < credit * STOP_LOSS_CREDIT) {
          await closePositionDb(db, pos, todayStr, 'SL', pnl);
          continue;
        }
      }
    } else {
      const debit = Math.abs(entryCost);
      if (debit > 0) {
        if (pnl >= debit * PROFIT_TARGET_DEBIT) {
          await closePositionDb(db, pos, todayStr, 'TP', pnl);
          continue;
        }
        if (pnl < debit * STOP_LOSS_DEBIT) {
          await closePositionDb(db, pos, todayStr, 'SL', pnl);
          continue;
        }
      }
    }
  }
}

async function closePositionDb(
  db: BetterSqlite3Database,
  pos: PositionRow,
  dateStr: string,
  reason: string,
  pnl: number = 0,
): Promise<void> {
  // Place close order via paper trading
  try {
    await tradierClosePosition(TICKER, pos.symbol, pos.qty);
  } catch (err) {
    console.error(`[entropy] Failed to close position ${pos.symbol}:`, err);
  }

  db.prepare(
    `UPDATE positions SET is_open = 0, close_date = ?, close_reason = ?, close_pnl = ?
     WHERE id = ?`,
  ).run(dateStr, reason, pnl, pos.id);

  db.prepare(
    `INSERT INTO trades_log (date, strategy, action, symbol, qty, price, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    dateStr,
    pos.strategy,
    `CLOSE_${reason}`,
    pos.symbol,
    pos.qty,
    pnl,
    `entry_cost=${pos.entry_cost.toFixed(2)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN ENGINE
// ═══════════════════════════════════════════════════════════════════

export async function runEntropyEngine(): Promise<RunResult> {
  const todayStr = todayET();

  // Guard: don't record data on non-trading days (weekends + holidays)
  if (!isTradingDay(todayStr)) {
    return {
      success: true,
      date: todayStr,
      status: 'skipped',
      message: `Not a trading day (${todayStr}), skipping`,
    };
  }

  // Guard: only run after market close (>= 3:55pm ET) to ensure EOD data consistency.
  // All snapshots should reflect settled closing values, not partial intraday data.
  const now = new Date();
  const etTimeStr = now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const [etHour, etMin] = etTimeStr.split(':').map(Number);
  const etMinutes = etHour * 60 + etMin; // minutes since midnight ET
  if (etMinutes < 15 * 60 + 55) { // before 3:55pm ET
    return {
      success: true,
      date: todayStr,
      status: 'skipped',
      message: `Market still open (${etHour}:${String(etMin).padStart(2, '0')} ET). Engine runs after 3:55pm ET for EOD data consistency.`,
    };
  }

  // Determine month from ET date for September skip
  const etMonth = parseInt(todayStr.split('-')[1], 10); // 1-indexed

  let db: BetterSqlite3Database | null = null;

  try {
    db = getDb();
    initDb(db);

    // Restore data from Redis (handles serverless cold starts)
    await restoreFromRedis(db);

    // Check if already ran today
    const existing = db
      .prepare('SELECT 1 FROM entropy_history WHERE date = ?')
      .get(todayStr);
    if (existing) {
      db.close();
      return {
        success: true,
        date: todayStr,
        status: 'already_ran',
        message: 'Already ran today, skipping',
      };
    }

    // September skip — still manage existing positions
    if (etMonth === 9) {
      await managePositions(db, todayStr);
      await persistToRedis(db);
      db.close();
      return {
        success: true,
        date: todayStr,
        status: 'september_skip',
        message: 'September skip — no new entries, managed existing positions',
      };
    }

    // 1. Get market data
    const quote = await getQuote(TICKER);
    const spot = quote.last;
    if (!spot || spot <= 0) {
      db.close();
      return {
        success: false,
        date: todayStr,
        status: 'error',
        message: 'Failed to get spot price',
      };
    }

    const contracts = await fetchRawChain();
    if (contracts.length === 0) {
      db.close();
      return {
        success: false,
        date: todayStr,
        status: 'error',
        message: 'Failed to get option chain',
      };
    }

    // 2. Compute entropy
    const metrics = computeEntropy(contracts, spot);
    if (!metrics) {
      db.close();
      return {
        success: false,
        date: todayStr,
        status: 'error',
        message: 'Entropy computation failed — insufficient valid contracts',
      };
    }

    // Store (without _chain and _n_records for DB)
    const store: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(metrics)) {
      if (!k.startsWith('_')) store[k] = v;
    }
    db.prepare(
      'INSERT OR REPLACE INTO entropy_history (date, spot, metrics_json) VALUES (?, ?, ?)',
    ).run(todayStr, spot, JSON.stringify(store));

    // 3. Load history
    const history = getHistory(db);
    if (history.length < WARMUP_DAYS) {
      // Persist to Redis so data survives redeployments
      await persistToRedis(db);
      db.close();
      return {
        success: true,
        date: todayStr,
        status: 'warmup',
        message: `Warming up: ${history.length}/${WARMUP_DAYS} days`,
        metrics: store as Record<string, number | null>,
      };
    }

    // 4. Manage existing positions
    await managePositions(db, todayStr);

    // 5. Evaluate signals
    const signals = evaluateSignals(metrics, history);
    const signalsFired: string[] = [];

    // Log all signals
    for (const [sn, sig] of Object.entries(signals)) {
      db.prepare(
        `INSERT OR REPLACE INTO signals_log (date, strategy, fired, strength, trade_type, rationale)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(todayStr, sn, sig.fire ? 1 : 0, sig.strength, sig.trade_type, sig.rationale);
      if (sig.fire) signalsFired.push(sn);
    }

    const firing: Record<string, Signal> = {};
    for (const [k, v] of Object.entries(signals)) {
      if (v.fire) firing[k] = v;
    }

    // 5b. Gallacher defense — assess vol regime
    const getRegimeState = (k: string, def: string): string => {
      const row = db.prepare('SELECT value FROM regime_state WHERE key = ?').get(k) as
        | { value: string }
        | undefined;
      return row?.value ?? def;
    };

    const prevRegime = getRegimeState('current_regime', 'NORMAL');
    const tradingDays = parseInt(getRegimeState('trading_days', '0'), 10) + 1;
    const lastRegimeChangeDay = parseInt(getRegimeState('last_regime_change_day', '0'), 10);

    // Build spot history from entropy_history
    const spotRows = db
      .prepare(
        'SELECT spot FROM entropy_history ORDER BY date DESC LIMIT ?',
      )
      .all(MAD_WINDOW + MAD_BASELINE_LOOKBACK + 5) as { spot: number }[];
    const spotHistory = spotRows.filter((r) => r.spot).map((r) => r.spot).reverse();

    const ivMeanVal = metrics.iv_mean;
    let regime = prevRegime;
    let regimeDetails: RegimeDetails = { iv_check: 'N/A', mad_check: 'N/A', raw: 'NORMAL' };
    if (ivMeanVal != null) {
      const result = assessRegime(
        ivMeanVal, history, spotHistory, prevRegime,
        tradingDays, lastRegimeChangeDay,
      );
      regime = result.regime;
      regimeDetails = result.details;
    }

    // Persist regime state
    const setRegimeState = (k: string, v: string) => {
      db.prepare('INSERT OR REPLACE INTO regime_state (key, value) VALUES (?, ?)').run(k, v);
    };
    setRegimeState('current_regime', regime);
    setRegimeState('trading_days', String(tradingDays));
    setRegimeState(
      'last_regime_change_day',
      regime !== prevRegime ? String(tradingDays) : String(lastRegimeChangeDay),
    );

    // Store regime in metrics for API/UI
    (store as Record<string, unknown>).regime = regime;
    (store as Record<string, unknown>).regime_details = JSON.stringify(regimeDetails);
    db.prepare('UPDATE entropy_history SET metrics_json = ? WHERE date = ?').run(
      JSON.stringify(store),
      todayStr,
    );

    const isCredit = (tt: string) => tt === 'sell_put' || tt === 'sell_put_spread';

    // 6. Get active strategies
    const activeStrats = new Set<string>();
    const openPositions = db
      .prepare('SELECT DISTINCT strategy FROM positions WHERE is_open = 1')
      .all() as { strategy: string }[];
    for (const row of openPositions) activeStrats.add(row.strategy);

    const usedSymbols = new Set<string>();
    const openSyms = db
      .prepare('SELECT symbol FROM positions WHERE is_open = 1')
      .all() as { symbol: string }[];
    for (const row of openSyms) usedSymbols.add(row.symbol);

    // Count active long calls
    const longCallTypes = ['buy_call', 'buy_call_longer', 'bull_call_spread'];
    const activeLc = db
      .prepare(
        'SELECT strategy FROM positions WHERE is_open = 1 AND trade_type IN (?, ?, ?)',
      )
      .all('buy_call', 'buy_call_longer', 'bull_call_spread') as { strategy: string }[];
    const activeLcStrats = new Set(activeLc.map((r) => r.strategy));

    // 7. Execute actionable signals — strength-based allocation (v2)
    const tradesExecuted: string[] = [];
    const actionable = Object.keys(firing).filter((sn) => !activeStrats.has(sn));

    if (actionable.length > 0) {
      let pv: number;
      try {
        const bal = await getBalances();
        pv = bal.total_equity || INITIAL_CASH;
      } catch {
        pv = INITIAL_CASH;
      }

      const recs = metrics._chain;
      const sorted = [...actionable].sort(
        (a, b) => firing[b].strength - firing[a].strength,
      );

      for (const sn of sorted) {
        const sig = firing[sn];

        // Position limit checks
        if (activeStrats.size >= MAX_POSITIONS) break;

        // Per-signal-type limit
        const sameSignal = db
          .prepare('SELECT COUNT(*) as cnt FROM positions WHERE is_open = 1 AND strategy = ?')
          .get(sn) as { cnt: number } | undefined;
        if (sameSignal && sameSignal.cnt >= MAX_PER_SIGNAL_TYPE) continue;

        // Long-call cap
        if (longCallTypes.includes(sig.trade_type)) {
          if (activeLcStrats.size >= MAX_LONG_CALLS) continue;
        }

        const selection = selectContract(recs, spot, sig.trade_type, usedSymbols);
        if (!selection) continue;

        if (selection.type === 'single' && selection.contract && selection.qty_sign != null) {
          const c = selection.contract;
          const qs = selection.qty_sign;
          // Strength-based allocation: alloc = BASE + (MAX - BASE) × strength
          const allocPct = BASE_ALLOC + (MAX_ALLOC - BASE_ALLOC) * sig.strength;
          const budget = pv * allocPct;
          const netCost = c.mid * qs * 100;
          if (netCost === 0) continue;
          let n: number;
          if (netCost > 0) {
            n = Math.floor(budget / netCost);
          } else {
            const marginPer = Math.abs(netCost) * 2;
            n = marginPer > 0 ? Math.floor(budget / marginPer) : 0;
          }
          n = Math.max(1, Math.min(n, MAX_CONTRACTS));

          // [GALLACHER] Regime filter on credit trades
          if (isCredit(sig.trade_type)) {
            if (regime === 'EXTREME') {
              console.log(`[entropy] ✗ ${sn}: EXTREME regime — credit entry blocked`);
              continue;
            } else if (regime === 'STRESSED') {
              const origN = n;
              n = Math.max(1, Math.floor(n * STRESSED_SIZE_MULT));
              if (n < origN) {
                console.log(`[entropy] ⚠ ${sn}: STRESSED regime — credit reduced ${origN}→${n}`);
              }
            }
          }

          const qty = n * qs;
          const side: 'buy_to_open' | 'sell_to_open' =
            qs < 0 ? 'sell_to_open' : 'buy_to_open';

          try {
            await placeSingleOrder({
              symbol: TICKER,
              optionSymbol: c.symbol,
              side,
              quantity: Math.abs(qty),
              type: 'market',
            });
          } catch (err) {
            console.error(`[entropy] Order failed for ${sn}:`, err);
            continue;
          }

          db.prepare(
            `INSERT INTO positions (strategy, symbol, trade_type, qty, entry_price,
              entry_cost, entry_date, strike, expiry, is_credit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            sn,
            c.symbol,
            sig.trade_type,
            qty,
            c.mid,
            c.mid * 100 * Math.abs(qty),
            todayStr,
            c.strike,
            c.expiry,
            qs < 0 ? 1 : 0,
          );

          db.prepare(
            'UPDATE signals_log SET executed = 1 WHERE date = ? AND strategy = ?',
          ).run(todayStr, sn);

          usedSymbols.add(c.symbol);
          if (longCallTypes.includes(sig.trade_type)) {
            activeLcStrats.add(sn);
          }

          const sideStr = qs < 0 ? 'SELL' : 'BUY';
          const kind = c.is_call ? 'C' : 'P';
          tradesExecuted.push(
            `${sn}: ${sideStr} ${Math.abs(qty)}x ${kind} K=${c.strike} exp=${c.expiry} mid=$${c.mid.toFixed(2)}`,
          );
        } else if (selection.type === 'spread') {
          // Spread execution — log for paper trading
          tradesExecuted.push(`${sn}: spread execution (simplified for paper)`);
        }
      }
    }

    // 8. Record equity
    let portfolioValue: number;
    try {
      const bal = await getBalances();
      portfolioValue = bal.total_equity || INITIAL_CASH;
    } catch {
      portfolioValue = INITIAL_CASH;
    }

    db.prepare(
      `INSERT OR REPLACE INTO equity_curve (date, portfolio_value, cash, positions_value)
       VALUES (?, ?, ?, ?)`,
    ).run(todayStr, portfolioValue, portfolioValue, 0);

    // Persist all data to Redis for cross-deployment survival
    await persistToRedis(db);

    db.close();

    return {
      success: true,
      date: todayStr,
      status: 'executed',
      message: `Daily complete: ${signalsFired.length} signals fired, ${tradesExecuted.length} trades executed [${regime}]`,
      metrics: store as Record<string, number | null>,
      signalsFired,
      tradesExecuted,
      portfolioValue,
      regime,
    };
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close error
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      date: todayStr,
      status: 'error',
      message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  ENGINE STATUS (dashboard data)
// ═══════════════════════════════════════════════════════════════════

export async function getEngineStatus(): Promise<Record<string, unknown>> {
  let db: BetterSqlite3Database;
  try {
    db = getDb();
  } catch {
    return {
      status: 'no_db',
      message: 'Entropy engine database not found. Run the engine to initialize.',
      warmup: { current: 0, required: WARMUP_DAYS },
    };
  }

  // Initialize schema and restore from Redis on cold starts
  initDb(db);
  await restoreFromRedis(db);

  try {
    // Latest entropy metrics
    const latest = db
      .prepare(
        'SELECT date, spot, metrics_json FROM entropy_history ORDER BY date DESC LIMIT 1',
      )
      .get() as { date: string; spot: number; metrics_json: string } | undefined;

    const metrics = latest ? JSON.parse(latest.metrics_json) : null;

    // History count
    const countRow = db
      .prepare('SELECT COUNT(*) as cnt FROM entropy_history')
      .get() as { cnt: number };
    const historyCount = countRow.cnt;

    // Open positions
    const openPositions = db
      .prepare('SELECT * FROM positions WHERE is_open = 1 ORDER BY entry_date DESC')
      .all();

    // Today's signals
    const todayStr = new Date().toISOString().slice(0, 10);
    let signalDate = todayStr;
    let signals = db
      .prepare('SELECT * FROM signals_log WHERE date = ? ORDER BY strategy')
      .all(todayStr);

    if (signals.length === 0) {
      const latestSignalRow = db
        .prepare('SELECT DISTINCT date FROM signals_log ORDER BY date DESC LIMIT 1')
        .get() as { date: string } | undefined;
      if (latestSignalRow) {
        signalDate = latestSignalRow.date;
        signals = db
          .prepare('SELECT * FROM signals_log WHERE date = ? ORDER BY strategy')
          .all(signalDate);
      }
    }

    // Recent trades
    const recentTrades = db
      .prepare('SELECT * FROM trades_log ORDER BY date DESC, id DESC LIMIT 20')
      .all();

    // Equity curve
    const equity = db
      .prepare(
        'SELECT date, portfolio_value, cash, positions_value FROM equity_curve ORDER BY date DESC LIMIT 90',
      )
      .all() as { date: string; portfolio_value: number; cash: number; positions_value: number }[];

    // Stats
    const totalTrades = db
      .prepare('SELECT COUNT(*) as cnt FROM positions WHERE is_open = 0')
      .get() as { cnt: number };
    const wins = db
      .prepare('SELECT COUNT(*) as cnt FROM positions WHERE is_open = 0 AND close_pnl > 0')
      .get() as { cnt: number };
    const totalPnl = db
      .prepare('SELECT COALESCE(SUM(close_pnl), 0) as total FROM positions WHERE is_open = 0')
      .get() as { total: number };

    // 21-day medians
    const recentHistory = db
      .prepare('SELECT metrics_json FROM entropy_history ORDER BY date DESC LIMIT 21')
      .all() as { metrics_json: string }[];

    const medians: Record<string, number | null> = {};
    if (recentHistory.length >= 10) {
      const keys = [
        'comp_volume',
        'comp_greek',
        'composite',
        'iv_mean',
        'put_skew',
        'pcr_dollar',
      ];
      for (const key of keys) {
        const vals = recentHistory
          .map((r) => JSON.parse(r.metrics_json)[key])
          .filter((v: unknown): v is number => v != null && typeof v === 'number')
          .sort((a: number, b: number) => a - b);
        medians[key] = vals.length > 0 ? vals[Math.floor(vals.length / 2)] : null;
      }
    }

    db.close();

    return {
      status: historyCount >= WARMUP_DAYS ? 'active' : 'warmup',
      warmup: { current: historyCount, required: WARMUP_DAYS },
      date: latest?.date || null,
      spot: latest?.spot || null,
      metrics,
      medians,
      signals: { date: signalDate, items: signals },
      openPositions,
      recentTrades,
      equity: equity.reverse(),
      stats: {
        totalTrades: totalTrades.cnt,
        wins: wins.cnt,
        winRate:
          totalTrades.cnt > 0 ? Math.round((wins.cnt / totalTrades.cnt) * 100) : 0,
        totalPnl: totalPnl.total,
        openCount: (openPositions as unknown[]).length,
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentileValue(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Inline normCDF for theta computation (matches Python's sp_norm.cdf) */
function normCDFInline(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp((-absX * absX) / 2));

  return 0.5 * (1.0 + sign * y);
}
