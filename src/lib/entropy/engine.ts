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
  charm as bsCharm,
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
const MIN_DTE = 7;
const MAX_DTE = 45;
const TARGET_DTE = 28;
const MAX_ALLOC = 0.12;
const MAX_CONTRACTS = 25;
const CLOSE_DTE = 5;
const PROFIT_PCT = 0.50;
const STOP_MULT = 2.0;
const WARMUP_DAYS = 30;
const MAX_LONG_CALLS = 2;
const SPREAD_FILTER = 0.15;
const INITIAL_CASH = 100_000;

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
  charm: number;
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
  composite_v2: number | null;
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

/** Current data schema version written into entropy_history.schema_version. */
const SCHEMA_VERSION = 'parity-v1';

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
  `);

  // Idempotent column additions for post-parity schema.
  const addColumn = (sql: string) => {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column')) throw err;
    }
  };
  addColumn(`ALTER TABLE entropy_history ADD COLUMN schema_version TEXT`);
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

async function fetchRawChain(spot: number): Promise<RawContract[]> {
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
      const strike = parseFloat(o.strike ?? 0);
      // QC set_filter(strikes(-30, 30)): keep strikes within ±30 of spot
      if (!Number.isFinite(strike) || Math.abs(strike - spot) > 30) continue;
      const bid = parseFloat(o.bid ?? 0) || 0;
      const ask = parseFloat(o.ask ?? 0) || 0;
      allContracts.push({
        symbol: o.symbol ?? '',
        strike,
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
    if (c.ask <= 0 || c.ask < c.bid) continue;
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

    const charmVal = bsCharm(params, isCall ? 'call' : 'put');

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
      charm: charmVal,
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

  // Premium by expiry — QC: weight = mid * volume * 100, no floor on volume
  const ep: Record<string, number> = {};
  for (const r of recs) {
    ep[r.expiry] = (ep[r.expiry] ?? 0) + r.mid * r.volume * 100;
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

  // Dollar gamma by strike — QC: weight = |gamma * volume * spot * 100|
  const dg: Record<number, number> = {};
  for (const r of recs) {
    dg[r.strike] = (dg[r.strike] ?? 0) + Math.abs(r.gamma * r.volume * spot * 100);
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

  // Liquidity concentration by strike — QC H_sk:
  // per-strike weight = Σ volume / relative_spread, where relative_spread = (ask-bid)/mid.
  // Skip contracts with relative_spread <= 0 or volume <= 0.
  const sl: Record<number, number> = {};
  for (const r of recs) {
    if (r.mid <= 0 || r.volume <= 0) continue;
    const relSpread = (r.ask - r.bid) / r.mid;
    if (relSpread <= 0) continue;
    sl[r.strike] = (sl[r.strike] ?? 0) + r.volume / relSpread;
  }
  const slVals = Object.values(sl);
  const slSum = slVals.reduce((a, b) => a + b, 0);
  m.H_spread_k_n = slSum > 0 ? hNorm(slVals) : null;

  // Moneyness buckets — QC: 15 uniform bins width 0.02 on [0.85, 1.15].
  // Edges: [0.85, 0.87, 0.89, ..., 1.13, 1.15] (16 edges → 15 bins).
  // Matches numpy np.digitize on an in-range point; out-of-range points are
  // dropped (QC's _bkt inner loop breaks only on a matching bin, skipping
  // moneyness < 0.85 or >= 1.15).
  const mb = [
    0.85, 0.87, 0.89, 0.91, 0.93, 0.95, 0.97, 0.99,
    1.01, 1.03, 1.05, 1.07, 1.09, 1.11, 1.13, 1.15,
  ];
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

  // Charm by DTE bucket — QC H_ch: weight = |charm| (standard BS charm,
  // not the previous inline proxy), bucket edges parameterized by
  // MIN_DTE/MAX_DTE as range(MIN_DTE, MAX_DTE+2, 5), matching QC's
  // list(range(min_dte, max_dte + 2, 5)).
  // Note: QC weights by |charm| alone (no volume multiplication); the
  // user's spec for 2e requested |charm*volume|, but the QC helper does
  // not include volume — QC CODE WINS per the spec's precedence rule.
  const cb: number[] = [];
  for (let edge = MIN_DTE; edge < MAX_DTE + 2; edge += 5) cb.push(edge);
  const cvArr = new Array(Math.max(0, cb.length - 1)).fill(0);
  for (const r of recs) {
    for (let b = 0; b < cb.length - 1; b++) {
      if (r.dte >= cb[b] && r.dte < cb[b + 1]) {
        cvArr[b] += Math.abs(r.charm);
        break;
      }
    }
  }
  const cvSum = cvArr.reduce((a: number, b: number) => a + b, 0);
  m.H_charm_n = cvSum > 0 ? hNorm(cvArr) : null;

  // IV mean (near-term ATM)
  const nearRecs = recs.filter((r) => r.dte >= 7 && r.dte <= 45);
  const ivs = nearRecs.filter((r) => r.iv > 0).map((r) => r.iv);
  m.iv_mean = ivs.length > 5 ? mean(ivs) : null;

  // Put skew
  const nearPuts = recs.filter((r) => !r.is_call && r.dte >= 14 && r.dte <= 45);
  const atmPutIvs = nearPuts
    .filter((r) => r.moneyness >= 0.98 && r.moneyness <= 1.02)
    .map((r) => r.iv);
  const otmPutIvs = nearPuts
    .filter((r) => r.moneyness >= 0.90 && r.moneyness < 0.97)
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

  // Composites — QC parity. Null dims substitute 0.5 (QC has_vol=False branch).
  const neutral = (v: number | null) => (v == null ? 0.5 : v);

  // comp_volume = mean([H_vt, H_vk, H_pt, H_df])
  m.comp_volume = mean([
    neutral(m.H_vol_term_n),
    neutral(m.H_vol_k_n),
    neutral(m.H_prem_term_n),
    neutral(m.H_dflow_n),
  ]);

  // comp_greek = mean([H_vv, H_dg, H_gv, H_sk, H_ch])
  m.comp_greek = mean([
    neutral(m.H_vegavol_n),
    neutral(m.H_dgamma_n),
    neutral(m.H_gvx_n),
    neutral(m.H_spread_k_n),
    neutral(m.H_charm_n),
  ]);

  // composite = mean of all 10 dims
  m.composite = mean([
    neutral(m.H_vol_term_n),
    neutral(m.H_vol_k_n),
    neutral(m.H_prem_term_n),
    neutral(m.H_vegavol_n),
    neutral(m.H_dgamma_n),
    neutral(m.H_gvx_n),
    neutral(m.H_dflow_n),
    neutral(m.H_spread_k_n),
    neutral(m.H_moneyness_n),
    neutral(m.H_charm_n),
  ]);

  // composite_v2 = mean([H_vt, H_pt, H_mn, H_ch])
  m.composite_v2 = mean([
    neutral(m.H_vol_term_n),
    neutral(m.H_prem_term_n),
    neutral(m.H_moneyness_n),
    neutral(m.H_charm_n),
  ]);

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

function pct(
  history: HistoryEntry[],
  key: string,
  percentile: number,
  lookback: number | null = null,
): number | null {
  const windowed = lookback != null ? history.slice(-lookback) : history;
  const vals = windowed
    .map((h) => h[key])
    .filter((v): v is number => v != null && typeof v === 'number')
    .sort((a, b) => a - b);
  const minRequired = Math.floor((lookback ?? LOOKBACK) / 2);
  if (vals.length < minRequired) return null;
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

function evaluateSignals(
  metrics: EntropyMetrics,
  history: HistoryEntry[],
): Record<string, Signal> {
  const sigs: Record<string, Signal> = {};

  const cv = metrics.comp_volume;
  const cvM = med(history, 'comp_volume');
  const cg = metrics.comp_greek;
  const cgM = med(history, 'comp_greek');
  const co = metrics.composite;
  const coM = med(history, 'composite');
  const iv = metrics.iv_mean;
  const ivM = med(history, 'iv_mean');
  const ps = metrics.put_skew;
  const psM = med(history, 'put_skew');
  const pcrVol = metrics.pcr_vol;
  const d1cv = diff(history, 'comp_volume', 1);

  // Compute d1cv percentile
  const allD1cv: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].comp_volume;
    const curr = history[i].comp_volume;
    if (prev != null && curr != null) {
      allD1cv.push((curr as number) - (prev as number));
    }
  }
  const p20D1cv =
    allD1cv.length >= Math.floor(LOOKBACK / 2)
      ? percentileValue(allD1cv, 20)
      : null;

  const strength = (a: number, b: number): number => {
    if (!b || b === 0) return 0;
    return Math.max(0, Math.min((b - a) / Math.abs(b), 1));
  };

  // S_LowVolEnt
  if (cv != null && cvM != null) {
    const fire = cv < cvM;
    const tt = iv != null && ivM != null && iv < ivM ? 'buy_call' : 'sell_put';
    sigs.S_LowVolEnt = {
      fire,
      strength: fire ? strength(cv, cvM) : 0,
      direction: 1,
      trade_type: tt,
      rationale: `cv=${cv.toFixed(4)} ${fire ? '<' : '>='} ${cvM.toFixed(4)}`,
    };
  }

  // S_VolCollapse
  if (d1cv != null && p20D1cv != null) {
    const fire = d1cv < p20D1cv;
    const s =
      p20D1cv !== 0 && fire ? Math.max(0, Math.min(Math.abs(d1cv / p20D1cv) - 1, 1)) : 0;
    sigs.S_VolCollapse = {
      fire,
      strength: s,
      direction: 1,
      trade_type: 'bull_call_spread',
      rationale: `d1cv=${d1cv.toFixed(4)} ${fire ? '<' : '>='} p20=${p20D1cv.toFixed(4)}`,
    };
  }

  // S_LowEntLowIV
  if (co != null && coM != null && iv != null && ivM != null) {
    const fire = co < coM && iv < ivM;
    const s = fire ? (strength(co, coM) + strength(iv, ivM)) / 2 : 0;
    sigs.S_LowEntLowIV = {
      fire,
      strength: s,
      direction: 1,
      trade_type: 'buy_call_longer',
      rationale: `co=${co.toFixed(4)} iv=${iv.toFixed(4)}`,
    };
  }

  // S_LowGreekEnt
  if (cg != null && cgM != null) {
    const fire = cg < cgM;
    sigs.S_LowGreekEnt = {
      fire,
      strength: fire ? strength(cg, cgM) : 0,
      direction: 1,
      trade_type: 'sell_put',
      rationale: `cg=${cg.toFixed(4)} ${fire ? '<' : '>='} ${cgM.toFixed(4)}`,
    };
  }

  // S_SkewFlow
  if (cv != null && cvM != null && ps != null && psM != null) {
    const fire = cv < cvM && ps > psM && ps > 0.01;
    const s1 = cv < cvM ? strength(cv, cvM) : 0;
    const s2 =
      psM !== 0 && ps > psM ? Math.max(0, Math.min((ps - psM) / Math.abs(psM), 1)) : 0;
    sigs.S_SkewFlow = {
      fire,
      strength: fire ? Math.min((s1 + s2) / 2, 1) : 0,
      direction: 1,
      trade_type: 'sell_put_spread',
      rationale: `cv=${cv.toFixed(4)} sk=${ps.toFixed(4)} ${ps > psM ? '>' : '<='} med=${psM.toFixed(4)}`,
    };
  }

  // S_PCRContrarian
  if (pcrVol != null) {
    const pcrP80 = pct(history, 'pcr_vol', 80, LOOKBACK);
    if (pcrP80 != null) {
      const fire = pcrVol > pcrP80;
      const s =
        pcrP80 > 0 && fire ? Math.max(0, Math.min((pcrVol - pcrP80) / pcrP80, 1)) : 0;
      sigs.S_PCRContrarian = {
        fire,
        strength: s,
        direction: 1,
        trade_type: 'sell_put',
        rationale: `pcr_vol=${pcrVol.toFixed(4)} ${fire ? '>' : '<='} p80=${pcrP80.toFixed(4)}`,
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
    const cs = ca.filter((r) => Math.abs(r.strike - atmK) <= 2 && r.mid > 0);
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
        Math.abs(r.moneyness - 1.0) < 0.02 &&
        r.mid > 0 &&
        !usedSymbols.has(r.symbol),
    );
    if (lo.length > 0) {
      const c = lo.reduce((best, r) =>
        Math.abs(r.moneyness - 1.0) < Math.abs(best.moneyness - 1.0) ? r : best,
      );
      if (c.spread < c.mid * SPREAD_FILTER) {
        return { type: 'single', contract: c, qty_sign: 1 };
      }
    }
  } else if (tt === 'sell_put') {
    const ot = pa.filter(
      (r) => r.moneyness > 0.955 && r.moneyness < 0.995 && r.mid > 0.10,
    );
    if (ot.length > 0) {
      const c = ot.reduce((best, r) =>
        Math.abs(r.moneyness - 0.97) < Math.abs(best.moneyness - 0.97) ? r : best,
      );
      if (c.spread < c.mid * SPREAD_FILTER) {
        return { type: 'single', contract: c, qty_sign: -1 };
      }
    }
  } else if (tt === 'bull_call_spread') {
    const lc = ca.filter((r) => Math.abs(r.moneyness - 1.0) < 0.02 && r.mid > 0);
    const sc = ca.filter((r) => r.moneyness > 1.02 && r.moneyness < 1.05 && r.mid > 0);
    if (lc.length > 0 && sc.length > 0) {
      const l = lc.reduce((best, r) =>
        Math.abs(r.moneyness - 1.0) < Math.abs(best.moneyness - 1.0) ? r : best,
      );
      const s = sc.reduce((best, r) =>
        Math.abs(r.moneyness - 1.03) < Math.abs(best.moneyness - 1.03) ? r : best,
      );
      if (l.mid > s.mid) {
        return { type: 'spread', long: l, short: s };
      }
    }
  } else if (tt === 'sell_put_spread') {
    const spList = pa.filter(
      (r) => r.moneyness > 0.96 && r.moneyness < 0.995 && r.mid > 0.10,
    );
    const lp = pa.filter(
      (r) => r.moneyness > 0.935 && r.moneyness < 0.975 && r.mid > 0.05,
    );
    if (spList.length > 0 && lp.length > 0) {
      const s = spList.reduce((best, r) =>
        Math.abs(r.moneyness - 0.98) < Math.abs(best.moneyness - 0.98) ? r : best,
      );
      const l = lp.reduce((best, r) =>
        Math.abs(r.moneyness - 0.95) < Math.abs(best.moneyness - 0.95) ? r : best,
      );
      if (s.strike > l.strike && s.mid > l.mid) {
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
        if (pnl >= credit * PROFIT_PCT) {
          await closePositionDb(db, pos, todayStr, 'TP', pnl);
          continue;
        }
        if (pnl < -credit * STOP_MULT) {
          await closePositionDb(db, pos, todayStr, 'SL', pnl);
          continue;
        }
      }
    } else {
      const debit = Math.abs(entryCost);
      if (debit > 0) {
        if (pnl < -debit * (STOP_MULT - 1)) {
          await closePositionDb(db, pos, todayStr, 'SL', pnl);
          continue;
        }
        if (pnl >= debit * 1.0) {
          await closePositionDb(db, pos, todayStr, 'TP', pnl);
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

    const contracts = await fetchRawChain(spot);
    if (contracts.length < 10) {
      db.close();
      return {
        success: false,
        date: todayStr,
        status: 'error',
        message: `Insufficient raw chain contracts (${contracts.length} < 10)`,
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
      'INSERT OR REPLACE INTO entropy_history (date, spot, metrics_json, schema_version) VALUES (?, ?, ?, ?)',
    ).run(todayStr, spot, JSON.stringify(store), SCHEMA_VERSION);

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

    // 7. Execute actionable signals
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
      const avail = pv * 0.95;
      const alloc = Math.min(avail / actionable.length, pv * MAX_ALLOC);
      const maxContracts = Math.min(Math.max(8, Math.floor(pv / 12500)), MAX_CONTRACTS);

      const recs = metrics._chain;
      const sorted = [...actionable].sort(
        (a, b) => firing[b].strength - firing[a].strength,
      );

      for (const sn of sorted) {
        const sig = firing[sn];

        // Long-call cap
        if (longCallTypes.includes(sig.trade_type)) {
          if (activeLcStrats.size >= MAX_LONG_CALLS) continue;
        }

        const selection = selectContract(recs, spot, sig.trade_type, usedSymbols);
        if (!selection) continue;

        if (selection.type === 'single' && selection.contract && selection.qty_sign != null) {
          const c = selection.contract;
          const qs = selection.qty_sign;
          const prem = c.mid * 100;
          let n: number;
          if (qs > 0) {
            n = Math.max(1, Math.floor(alloc / prem));
          } else {
            const margin = Math.max(prem * 3, c.strike * 100 * 0.15);
            n = Math.max(1, Math.floor(alloc / margin));
          }
          n = Math.min(n, maxContracts);

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
      message: `Daily complete: ${signalsFired.length} signals fired, ${tradesExecuted.length} trades executed`,
      metrics: store as Record<string, number | null>,
      signalsFired,
      tradesExecuted,
      portfolioValue,
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
