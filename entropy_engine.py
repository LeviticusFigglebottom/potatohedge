#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
  ENTROPY PAPER TRADING ENGINE — T13 LOGIC, LIVE DATA
═══════════════════════════════════════════════════════════════════════
  Run via cron at 3:50pm ET daily:
    50 15 * * 1-5 cd /path/to/potatohedge && python3 entropy_engine.py

  Requires:
    pip install requests numpy scipy

  Environment variables:
    TRADIER_TOKEN=your_paper_token
    TRADIER_ACCOUNT=your_paper_account_id
    TRADIER_BASE_URL=https://sandbox.tradier.com  (paper)
    ENGINE_DB_PATH=./entropy_engine.db
═══════════════════════════════════════════════════════════════════════
"""

import os
import json
import sqlite3
import logging
import requests
import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm as sp_norm
from datetime import datetime, timedelta, date
from typing import Optional, Dict, List, Any

# ═══════════════════════════════════════════════════════════════════
#  CONFIG — matches T13 exactly
# ═══════════════════════════════════════════════════════════════════

TICKER        = "SPY"
LOOKBACK      = 21
RISK_FREE     = 0.05
MIN_DTE       = 14
MAX_DTE       = 45
TARGET_DTE    = 28
CLOSE_DTE     = 5
WARMUP_DAYS   = 30
INITIAL_CASH  = 100_000
SPREAD_FILTER = 0.15

# Position sizing
BASE_ALLOC    = 0.06
MAX_ALLOC     = 0.14
MAX_CONTRACTS = 20
MAX_POSITIONS = 8
MAX_PER_SIGNAL_TYPE = 3
MAX_LONG_CALLS = 2

# Signal thresholds
ENTROPY_PERCENTILE = 30
VOLCOLLAPSE_PERCENTILE = 85
PCR_PERCENTILE = 80
MIN_STRENGTH   = 0.20

# Exit rules
PROFIT_TARGET_DEBIT  = 0.80
PROFIT_TARGET_CREDIT = 0.50
STOP_LOSS_DEBIT      = -0.60
STOP_LOSS_CREDIT     = -1.50

TRADIER_TOKEN    = os.environ.get("TRADIER_TOKEN", "")
TRADIER_ACCOUNT  = os.environ.get("TRADIER_ACCOUNT", "")
TRADIER_BASE     = os.environ.get("TRADIER_BASE_URL", "https://sandbox.tradier.com")
DB_PATH          = os.environ.get("ENGINE_DB_PATH", "./entropy_engine.db")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("entropy_engine.log"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger("entropy")


# ═══════════════════════════════════════════════════════════════════
#  DATABASE
# ═══════════════════════════════════════════════════════════════════

def init_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
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
    """)
    conn.commit()
    return conn


# ═══════════════════════════════════════════════════════════════════
#  TRADIER API
# ═══════════════════════════════════════════════════════════════════

def tradier_headers():
    return {
        "Authorization": f"Bearer {TRADIER_TOKEN}",
        "Accept": "application/json"
    }

def get_spot_price() -> Optional[float]:
    """Get current SPY price."""
    url = f"{TRADIER_BASE}/v1/markets/quotes"
    r = requests.get(url, params={"symbols": TICKER}, headers=tradier_headers())
    if r.status_code == 200:
        data = r.json()
        quote = data.get("quotes", {}).get("quote", {})
        return float(quote.get("last", 0))
    log.error(f"Failed to get spot: {r.status_code} {r.text}")
    return None

def get_option_chain() -> List[Dict]:
    """Fetch full SPY option chain from Tradier."""
    # First get available expirations
    url = f"{TRADIER_BASE}/v1/markets/options/expirations"
    r = requests.get(url, params={"symbol": TICKER, "includeAllRoots": "true"},
                     headers=tradier_headers())
    if r.status_code != 200:
        log.error(f"Failed to get expirations: {r.status_code}")
        return []

    exps = r.json().get("expirations", {}).get("date", [])
    if isinstance(exps, str):
        exps = [exps]

    today = date.today()
    # Filter to MIN_DTE..MAX_DTE range
    valid_exps = []
    for exp_str in exps:
        exp_date = datetime.strptime(exp_str, "%Y-%m-%d").date()
        dte = (exp_date - today).days
        if MIN_DTE <= dte <= MAX_DTE:
            valid_exps.append(exp_str)

    if not valid_exps:
        log.warning("No expirations in DTE range")
        return []

    # Fetch chains for each expiration
    all_contracts = []
    for exp in valid_exps:
        url = f"{TRADIER_BASE}/v1/markets/options/chains"
        r = requests.get(url, params={
            "symbol": TICKER,
            "expiration": exp,
            "greeks": "false"  # We compute our own
        }, headers=tradier_headers())

        if r.status_code == 200:
            options = r.json().get("options", {}).get("option", [])
            if isinstance(options, dict):
                options = [options]
            for o in options:
                all_contracts.append({
                    "symbol": o.get("symbol", ""),
                    "strike": float(o.get("strike", 0)),
                    "expiry": exp,
                    "dte": (datetime.strptime(exp, "%Y-%m-%d").date() - today).days,
                    "is_call": o.get("option_type") == "call",
                    "bid": float(o.get("bid", 0) or 0),
                    "ask": float(o.get("ask", 0) or 0),
                    "mid": (float(o.get("bid", 0) or 0) + float(o.get("ask", 0) or 0)) / 2,
                    "volume": int(o.get("volume", 0) or 0),
                    "open_interest": int(o.get("open_interest", 0) or 0),
                })

    log.info(f"Fetched {len(all_contracts)} contracts across {len(valid_exps)} expirations")
    return all_contracts

def get_paper_account_value() -> float:
    """Get paper account total equity."""
    url = f"{TRADIER_BASE}/v1/accounts/{TRADIER_ACCOUNT}/balances"
    r = requests.get(url, headers=tradier_headers())
    if r.status_code == 200:
        bal = r.json().get("balances", {})
        return float(bal.get("total_equity", INITIAL_CASH))
    return INITIAL_CASH

def get_option_quote(symbol: str) -> Optional[float]:
    """Get current mid price for an option symbol."""
    url = f"{TRADIER_BASE}/v1/markets/quotes"
    r = requests.get(url, params={"symbols": symbol}, headers=tradier_headers())
    if r.status_code == 200:
        quote = r.json().get("quotes", {}).get("quote", {})
        bid = float(quote.get("bid", 0) or 0)
        ask = float(quote.get("ask", 0) or 0)
        return (bid + ask) / 2 if bid > 0 else None
    return None

def place_paper_order(symbol: str, qty: int, side: str = "buy_to_open") -> Optional[Dict]:
    """Place a paper order via Tradier sandbox."""
    url = f"{TRADIER_BASE}/v1/accounts/{TRADIER_ACCOUNT}/orders"
    payload = {
        "class": "option",
        "symbol": TICKER,
        "option_symbol": symbol,
        "side": side,
        "quantity": abs(qty),
        "type": "market",
        "duration": "day"
    }
    r = requests.post(url, data=payload, headers=tradier_headers())
    if r.status_code == 200:
        order = r.json().get("order", {})
        log.info(f"Paper order placed: {side} {abs(qty)}x {symbol} → order_id={order.get('id')}")
        return order
    else:
        log.error(f"Order failed: {r.status_code} {r.text}")
        return None


# ═══════════════════════════════════════════════════════════════════
#  BSM — identical to T13
# ═══════════════════════════════════════════════════════════════════

def bsm_price(S, K, T, r, sig, is_call):
    if T <= 0 or sig <= 0 or S <= 0 or K <= 0:
        return 0.0
    d1 = (np.log(S/K) + (r + 0.5*sig**2)*T) / (sig*np.sqrt(T))
    d2 = d1 - sig*np.sqrt(T)
    if is_call:
        return float(S*sp_norm.cdf(d1) - K*np.exp(-r*T)*sp_norm.cdf(d2))
    return float(K*np.exp(-r*T)*sp_norm.cdf(-d2) - S*sp_norm.cdf(-d1))

def bsm_iv(price, S, K, T, r, is_call):
    if T <= 1e-6 or price <= 0:
        return None
    intr = max(S - K*np.exp(-r*T), 0) if is_call else max(K*np.exp(-r*T) - S, 0)
    if price < intr * 0.90:
        return None
    try:
        return brentq(lambda s: bsm_price(S, K, T, r, s, is_call) - price,
                      0.01, 5.0, xtol=1e-5, maxiter=80)
    except:
        return None

def bsm_greeks(S, K, T, r, sig, is_call):
    if T <= 0 or sig <= 0:
        return {"delta": 0, "gamma": 0, "vega": 0, "theta": 0}
    d1 = (np.log(S/K) + (r + 0.5*sig**2)*T) / (sig*np.sqrt(T))
    d2 = d1 - sig*np.sqrt(T)
    nd1 = sp_norm.pdf(d1)
    gamma = float(nd1 / (S * sig * np.sqrt(T)))
    vega = float(S * nd1 * np.sqrt(T) / 100)
    if is_call:
        delta = float(sp_norm.cdf(d1))
        theta = float((-S*nd1*sig/(2*np.sqrt(T)) - r*K*np.exp(-r*T)*sp_norm.cdf(d2))/365)
    else:
        delta = float(sp_norm.cdf(d1) - 1)
        theta = float((-S*nd1*sig/(2*np.sqrt(T)) + r*K*np.exp(-r*T)*sp_norm.cdf(-d2))/365)
    return {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta}


# ═══════════════════════════════════════════════════════════════════
#  ENTROPY — identical to T13
# ═══════════════════════════════════════════════════════════════════

def h_norm(dist):
    d = np.asarray(dist, dtype=float)
    d = d[d > 0]
    if len(d) <= 1:
        return 0.0
    d = d / d.sum()
    h = float(-np.sum(d * np.log2(d)))
    return h / np.log2(len(d))

def compute_entropy(contracts: List[Dict], spot: float) -> Optional[Dict]:
    """Compute all 12 entropy dimensions + composites.
    IDENTICAL logic to T13 ComputeEntropy."""
    if spot <= 0:
        return None

    recs = []
    for c in contracts:
        bid, ask = c["bid"], c["ask"]
        mid = c["mid"]
        if mid <= 0 or bid <= 0:
            continue
        K = c["strike"]
        dte = c["dte"]
        if dte <= 0:
            continue
        T = dte / 365.0
        is_call = c["is_call"]

        iv = bsm_iv(mid, spot, K, T, RISK_FREE, is_call)
        if iv is None:
            continue

        gr = bsm_greeks(spot, K, T, RISK_FREE, iv, is_call)
        vol = c["volume"]

        recs.append({
            "symbol": c["symbol"], "strike": K, "expiry": c["expiry"],
            "dte": dte, "is_call": is_call, "mid": mid, "bid": bid,
            "ask": ask, "spread": ask - bid, "volume": vol, "iv": iv,
            "delta": gr["delta"], "gamma": gr["gamma"],
            "vega": gr["vega"], "theta": gr["theta"],
            "moneyness": K / spot,
        })

    if len(recs) < 10:
        log.warning(f"Only {len(recs)} valid contracts, need 10+")
        return None

    m = {}

    # Volume entropy by expiry
    ev = {}
    for r in recs:
        ev[r["expiry"]] = ev.get(r["expiry"], 0) + r["volume"]
    ve = np.array(list(ev.values()))
    m["H_vol_term_n"] = h_norm(ve) if ve.sum() > 0 else None

    # Volume by strike
    sv = {}
    for r in recs:
        sv[r["strike"]] = sv.get(r["strike"], 0) + r["volume"]
    vk = np.array(list(sv.values()))
    m["H_vol_k_n"] = h_norm(vk) if vk.sum() > 0 else None

    # Premium by expiry
    ep = {}
    for r in recs:
        ep[r["expiry"]] = ep.get(r["expiry"], 0) + r["mid"] * max(r["volume"], 1) * 100
    pe = np.abs(np.array(list(ep.values())))
    m["H_prem_term_n"] = h_norm(pe) if pe.sum() > 0 else None

    # Vega-weighted volume by strike
    vv = {}
    for r in recs:
        vv[r["strike"]] = vv.get(r["strike"], 0) + abs(r["vega"]) * r["volume"]
    vvs = np.array(list(vv.values()))
    m["H_vegavol_n"] = h_norm(vvs) if vvs.sum() > 0 else None

    # Dollar gamma by strike
    dg = {}
    for r in recs:
        dg[r["strike"]] = dg.get(r["strike"], 0) + abs(r["gamma"]) * r["volume"] * spot * 100
    da = np.array(list(dg.values()))
    if da.sum() > 0:
        sd = np.sort(da)[::-1]
        m["dgamma_conc5"] = float(sum(sd[:5]) / da.sum())
        m["H_dgamma_n"] = h_norm(da)
    else:
        m["dgamma_conc5"] = m["H_dgamma_n"] = None

    # Gamma × volume by strike
    gv = {}
    for r in recs:
        gv[r["strike"]] = gv.get(r["strike"], 0) + abs(r["gamma"]) * r["volume"]
    gvs = np.array(list(gv.values()))
    m["H_gvx_n"] = h_norm(gvs) if gvs.sum() > 0 else None

    # Delta-bucket flow
    db = np.linspace(0, 1, 11)
    dflow = np.zeros(10)
    for r in recs:
        ad = abs(r["delta"])
        for b in range(10):
            if db[b] <= ad < db[b + 1]:
                dflow[b] += r["volume"]
                break
    m["H_dflow_n"] = h_norm(dflow) if dflow.sum() > 0 else None

    # Spread liquidity by strike (volume / spread)
    sl = {}
    for r in recs:
        if r["spread"] > 0 and r["volume"] > 0:
            sl[r["strike"]] = sl.get(r["strike"], 0) + r["volume"] / r["spread"]
    sps = np.array(list(sl.values())) if sl else np.array([])
    m["H_spread_k_n"] = h_norm(sps) if len(sps) > 0 and sps.sum() > 0 else 0.5

    # Moneyness buckets
    mb = [0.85 + i * 0.02 for i in range(16)]
    mv = np.zeros(len(mb) - 1)
    for r in recs:
        for b in range(len(mb) - 1):
            if mb[b] <= r["moneyness"] < mb[b + 1]:
                mv[b] += r["volume"]
                break
    m["H_moneyness_n"] = h_norm(mv) if mv.sum() > 0 else None

    # Charm by DTE bucket (range(MIN_DTE, MAX_DTE+2, 5))
    cb = list(range(MIN_DTE, MAX_DTE + 2, 5))
    cv_arr = np.zeros(len(cb) - 1)
    for r in recs:
        charm = abs(r["gamma"] * (RISK_FREE - r["iv"] ** 2 / 2) / r["iv"]) if r["iv"] > 0 else 0
        for b in range(len(cb) - 1):
            if cb[b] <= r["dte"] < cb[b + 1]:
                cv_arr[b] += abs(charm)
                break
    m["H_charm_n"] = h_norm(cv_arr) if cv_arr.sum() > 0 else None

    # IV mean (ATM near-term, fallback to all)
    atm_near = [r for r in recs if 0.97 <= r["moneyness"] <= 1.03 and r["dte"] <= 30]
    if atm_near:
        m["iv_mean"] = float(np.mean([r["iv"] for r in atm_near]))
    else:
        m["iv_mean"] = float(np.mean([r["iv"] for r in recs]))

    # Put skew
    near_puts = [r for r in recs if not r["is_call"] and 14 <= r["dte"] <= 45]
    atm_iv = np.mean([r["iv"] for r in near_puts if 0.98 <= r["moneyness"] <= 1.02])
    otm_iv = np.mean([r["iv"] for r in near_puts if 0.90 <= r["moneyness"] <= 0.95])
    m["put_skew"] = float(otm_iv - atm_iv) if not (np.isnan(atm_iv) or np.isnan(otm_iv)) else None

    # PCR
    calls = [r for r in recs if r["is_call"]]
    puts = [r for r in recs if not r["is_call"]]
    cprem = sum(r["mid"] * r["volume"] for r in calls)
    pprem = sum(r["mid"] * r["volume"] for r in puts)
    m["pcr_dollar"] = float(pprem / cprem) if cprem > 0 else None
    cvol = sum(r["volume"] for r in calls)
    pvol = sum(r["volume"] for r in puts)
    m["pcr_vol"] = float(pvol / cvol) if cvol > 0 else None

    # Composites
    cv_vals = [v for v in [m.get("H_vol_term_n"), m.get("H_vol_k_n"),
                            m.get("H_prem_term_n"), m.get("H_dflow_n")] if v is not None]
    m["comp_volume"] = float(np.mean(cv_vals)) if cv_vals else None

    cg_vals = [v for v in [m.get("H_vegavol_n"), m.get("H_dgamma_n"), m.get("H_gvx_n"),
                            m.get("H_spread_k_n"), m.get("H_charm_n")] if v is not None]
    m["comp_greek"] = float(np.mean(cg_vals)) if cg_vals else None

    all_vals = [v for v in [m.get("H_vol_term_n"), m.get("H_vol_k_n"),
                             m.get("H_prem_term_n"), m.get("H_vegavol_n"),
                             m.get("H_dgamma_n"), m.get("H_gvx_n"),
                             m.get("H_dflow_n"), m.get("H_spread_k_n"),
                             m.get("H_moneyness_n"), m.get("H_charm_n")] if v is not None]
    m["composite"] = float(np.mean(all_vals)) if all_vals else None

    m["_n_records"] = len(recs)
    m["_chain"] = recs  # Keep for contract selection
    return m


# ═══════════════════════════════════════════════════════════════════
#  SIGNALS — identical to T13
# ═══════════════════════════════════════════════════════════════════

def get_history(conn: sqlite3.Connection, days: int = 60) -> List[Dict]:
    """Load entropy history from DB."""
    rows = conn.execute(
        "SELECT date, metrics_json FROM entropy_history ORDER BY date DESC LIMIT ?",
        (days,)
    ).fetchall()
    return [json.loads(r["metrics_json"]) for r in reversed(rows)]

def med(history: List[Dict], key: str, lookback: int = LOOKBACK) -> Optional[float]:
    vals = [h[key] for h in history[-lookback:] if h.get(key) is not None]
    return float(np.median(vals)) if len(vals) >= lookback // 2 else None

def pct(history: List[Dict], key: str, percentile: int) -> Optional[float]:
    vals = [h[key] for h in history if h.get(key) is not None]
    return float(np.percentile(vals, percentile)) if len(vals) >= LOOKBACK // 2 else None

def diff(history: List[Dict], key: str, lag: int = 1) -> Optional[float]:
    vals = [h.get(key) for h in history if h.get(key) is not None]
    if len(vals) >= lag + 1:
        return vals[-1] - vals[-1 - lag]
    return None

def std_val(history: List[Dict], key: str) -> float:
    """Standard deviation of a metric over history."""
    vals = [h[key] for h in history[-LOOKBACK:] if h.get(key) is not None]
    return float(np.std(vals)) if len(vals) > 1 else 0.01

def zstrength(val: float, key: str, history: List[Dict]) -> float:
    """Z-score based strength: (median - val) / std / 3.0, clamped [0, 1]."""
    m = med(history, key)
    s = std_val(history, key)
    if m is None or s < 1e-8:
        return 0.0
    return max(0.0, min(1.0, (m - val) / s / 3.0))

def evaluate_signals(metrics: Dict, history: List[Dict]) -> Dict[str, Dict]:
    """Evaluate all 6 strategies — v2 logic with percentile thresholds + Z-score strength."""
    sigs = {}
    ep = ENTROPY_PERCENTILE

    cv = metrics.get("comp_volume")
    cg = metrics.get("comp_greek")
    co = metrics.get("composite")
    iv = metrics.get("iv_mean")
    ps = metrics.get("put_skew")
    pcr = metrics.get("pcr_vol")

    # Percentile thresholds
    t_cv = pct(history, "comp_volume", ep)
    t_cg = pct(history, "comp_greek", ep)
    t_cc = pct(history, "composite", ep)
    t_iv = pct(history, "iv_mean", ep)
    ps_m = med(history, "put_skew")
    iv_m = med(history, "iv_mean")

    # S_LowVolEnt
    if cv is not None and t_cv is not None:
        fire = cv < t_cv
        s = zstrength(cv, "comp_volume", history) if fire else 0
        tt = "buy_call" if (iv and iv_m and iv < iv_m) else "sell_put"
        sigs["S_LowVolEnt"] = {
            "fire": fire and s >= MIN_STRENGTH, "strength": s,
            "direction": 1, "trade_type": tt,
            "rationale": f"cv={cv:.4f} {'<' if fire else '>='} p{ep}={t_cv:.4f} s={s:.2f}"
        }

    # S_VolCollapse — drop > 85th percentile of all historical drops
    if len(history) >= 2:
        prev_cv = None
        for h in reversed(history):
            v = h.get("comp_volume")
            if v is not None:
                if prev_cv is None:
                    prev_cv = v
                else:
                    prev_cv = v
                    break
        curr_cv = metrics.get("comp_volume")
        if prev_cv is not None and curr_cv is not None:
            drop = prev_cv - curr_cv
            drops = []
            hist_vals = [h.get("comp_volume") for h in history]
            for i in range(1, len(hist_vals)):
                if hist_vals[i-1] is not None and hist_vals[i] is not None:
                    d = hist_vals[i-1] - hist_vals[i]
                    if d > 0:
                        drops.append(d)
            if drops and drop > 0:
                thresh = float(np.percentile(drops, VOLCOLLAPSE_PERCENTILE))
                fire = drop > thresh
                s = max(MIN_STRENGTH, min(1.0, drop / (thresh + 1e-8) - 1.0)) if fire else 0
                sigs["S_VolCollapse"] = {
                    "fire": fire and s >= MIN_STRENGTH, "strength": s,
                    "direction": 1, "trade_type": "bull_call_spread",
                    "rationale": f"drop={drop:.4f} {'>' if fire else '<='} p{VOLCOLLAPSE_PERCENTILE}={thresh:.4f}"
                }

    # S_LowEntLowIV
    if co is not None and t_cc is not None and iv is not None and t_iv is not None:
        fire = co < t_cc and iv < t_iv
        s = zstrength(co, "composite", history) if fire else 0
        sigs["S_LowEntLowIV"] = {
            "fire": fire and s >= MIN_STRENGTH, "strength": s,
            "direction": 1, "trade_type": "buy_call_longer",
            "rationale": f"co={co:.4f} iv={iv:.4f}"
        }

    # S_LowGreekEnt
    if cg is not None and t_cg is not None:
        fire = cg < t_cg
        s = zstrength(cg, "comp_greek", history) if fire else 0
        sigs["S_LowGreekEnt"] = {
            "fire": fire and s >= MIN_STRENGTH, "strength": s,
            "direction": 1, "trade_type": "sell_put",
            "rationale": f"cg={cg:.4f} {'<' if fire else '>='} p{ep}={t_cg:.4f} s={s:.2f}"
        }

    # S_SkewFlow — requires comp_volume < 30th pct AND put_skew > median AND put_skew > 0.01
    if cv is not None and t_cv is not None and ps is not None and ps_m is not None:
        fire = cv < t_cv and ps > ps_m and ps > 0.01
        s = zstrength(cv, "comp_volume", history) if fire else 0
        sigs["S_SkewFlow"] = {
            "fire": fire and s >= MIN_STRENGTH, "strength": s,
            "direction": 1, "trade_type": "sell_put_spread",
            "rationale": f"cv={cv:.4f} sk={ps:.4f} {'>' if (ps_m and ps > ps_m) else '<='} med={ps_m:.4f}"
        }

    # S_PCRContrarian — uses pcr_vol > 80th percentile
    if pcr is not None:
        pcr_p80 = pct(history, "pcr_vol", PCR_PERCENTILE)
        if pcr_p80 is not None:
            fire = pcr > pcr_p80
            pcr_std = std_val(history, "pcr_vol")
            s = min(1.0, (pcr - pcr_p80) / (pcr_std + 1e-8)) if fire else 0
            sigs["S_PCRContrarian"] = {
                "fire": fire and s >= MIN_STRENGTH, "strength": s,
                "direction": 1, "trade_type": "sell_put",
                "rationale": f"pcr_vol={pcr:.4f} {'>' if fire else '<='} p{PCR_PERCENTILE}={pcr_p80:.4f}"
            }

    return sigs


# ═══════════════════════════════════════════════════════════════════
#  CONTRACT SELECTION — identical to T13
# ═══════════════════════════════════════════════════════════════════

def select_contract(recs: List[Dict], spot: float, tt: str,
                    used_symbols: set) -> Optional[Dict]:
    """Select the best contract for a given trade type."""
    avail = [r for r in recs if r["symbol"] not in used_symbols]
    elig = [r for r in avail if MIN_DTE <= r["dte"] <= MAX_DTE]
    if not elig:
        return None

    elig.sort(key=lambda r: abs(r["dte"] - TARGET_DTE))
    best_exp = elig[0]["expiry"]
    ae = [r for r in elig if r["expiry"] == best_exp]
    ca = sorted([r for r in ae if r["is_call"]], key=lambda r: r["strike"])
    pa = sorted([r for r in ae if not r["is_call"]], key=lambda r: r["strike"])
    atm_k = min(ae, key=lambda r: abs(r["moneyness"] - 1.0))["strike"]

    if tt == "buy_call":
        cs = [r for r in ca if abs(r["strike"] - atm_k) <= 2 and r["mid"] > 0]
        if cs:
            c = min(cs, key=lambda r: abs(r["moneyness"] - 1.0))
            if c["spread"] < c["mid"] * SPREAD_FILTER:
                return {"type": "single", "contract": c, "qty_sign": 1}

    elif tt == "buy_call_longer":
        lo = [r for r in avail if r["is_call"] and 25 <= r["dte"] <= 45
              and abs(r["moneyness"] - 1.0) < 0.02 and r["mid"] > 0
              and r["symbol"] not in used_symbols]
        if lo:
            c = min(lo, key=lambda r: abs(r["moneyness"] - 1.0))
            if c["spread"] < c["mid"] * SPREAD_FILTER:
                return {"type": "single", "contract": c, "qty_sign": 1}

    elif tt == "sell_put":
        ot = [r for r in pa if 0.955 < r["moneyness"] < 0.995 and r["mid"] > 0.10]
        if ot:
            c = min(ot, key=lambda r: abs(r["moneyness"] - 0.97))
            if c["spread"] < c["mid"] * SPREAD_FILTER:
                return {"type": "single", "contract": c, "qty_sign": -1}

    elif tt == "bull_call_spread":
        lc = [r for r in ca if abs(r["moneyness"] - 1.0) < 0.02 and r["mid"] > 0]
        sc = [r for r in ca if 1.02 < r["moneyness"] < 1.05 and r["mid"] > 0]
        if lc and sc:
            l = min(lc, key=lambda r: abs(r["moneyness"] - 1.0))
            s = min(sc, key=lambda r: abs(r["moneyness"] - 1.03))
            if l["mid"] > s["mid"]:
                return {"type": "spread", "long": l, "short": s}

    elif tt == "sell_put_spread":
        sp_list = [r for r in pa if 0.96 < r["moneyness"] < 0.995 and r["mid"] > 0.10]
        lp = [r for r in pa if 0.935 < r["moneyness"] < 0.975 and r["mid"] > 0.05]
        if sp_list and lp:
            s = min(sp_list, key=lambda r: abs(r["moneyness"] - 0.98))
            l = min(lp, key=lambda r: abs(r["moneyness"] - 0.95))
            if s["strike"] > l["strike"] and s["mid"] > l["mid"]:
                return {"type": "spread", "short": s, "long": l}

    return None


# ═══════════════════════════════════════════════════════════════════
#  POSITION MANAGEMENT
# ═══════════════════════════════════════════════════════════════════

def manage_positions(conn: sqlite3.Connection, today_str: str):
    """Check all open positions for TP/SL/DTE exits."""
    positions = conn.execute(
        "SELECT * FROM positions WHERE is_open = 1"
    ).fetchall()

    today = datetime.strptime(today_str, "%Y-%m-%d").date()

    for pos in positions:
        expiry = datetime.strptime(pos["expiry"], "%Y-%m-%d").date()
        dte = (expiry - today).days

        # DTE close
        if dte <= CLOSE_DTE:
            close_position(conn, pos, today_str, "DTE")
            continue

        # Get current price
        current_mid = get_option_quote(pos["symbol"])
        if current_mid is None:
            continue

        entry_cost = pos["entry_cost"]
        current_value = current_mid * 100 * abs(pos["qty"])
        pnl = (current_value - entry_cost) if pos["qty"] > 0 else (entry_cost - current_value)

        if pos["is_credit"]:
            credit = abs(entry_cost)
            if credit > 0:
                if pnl >= credit * PROFIT_TARGET_CREDIT:
                    close_position(conn, pos, today_str, "TP", pnl)
                    continue
                if pnl < credit * STOP_LOSS_CREDIT:
                    close_position(conn, pos, today_str, "SL", pnl)
                    continue
        else:
            debit = abs(entry_cost)
            if debit > 0:
                if pnl >= debit * PROFIT_TARGET_DEBIT:
                    close_position(conn, pos, today_str, "TP", pnl)
                    continue
                if pnl < debit * STOP_LOSS_DEBIT:
                    close_position(conn, pos, today_str, "SL", pnl)
                    continue

def close_position(conn: sqlite3.Connection, pos, date_str: str,
                   reason: str, pnl: float = 0):
    """Close a position and log it."""
    side = "sell_to_close" if pos["qty"] > 0 else "buy_to_close"
    place_paper_order(pos["symbol"], pos["qty"], side)

    conn.execute("""
        UPDATE positions SET is_open = 0, close_date = ?, close_reason = ?, close_pnl = ?
        WHERE id = ?
    """, (date_str, reason, pnl, pos["id"]))
    conn.commit()

    log.info(f"{'+ ' if pnl >= 0 else '- '}CLOSE {pos['strategy']} ({reason}): "
             f"pnl=${pnl:+,.2f} {pos['symbol']}")

    conn.execute("""
        INSERT INTO trades_log (date, strategy, action, symbol, qty, price, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (date_str, pos["strategy"], f"CLOSE_{reason}", pos["symbol"],
          pos["qty"], pnl, f"entry_cost={pos['entry_cost']:.2f}"))
    conn.commit()


# ═══════════════════════════════════════════════════════════════════
#  MAIN ENGINE LOOP
# ═══════════════════════════════════════════════════════════════════

def run_daily():
    """Main daily execution — call at 3:50pm ET."""
    today_str = date.today().strftime("%Y-%m-%d")
    today_date = date.today()
    log.info(f"{'='*60}")
    log.info(f"ENTROPY ENGINE — {today_str}")
    log.info(f"{'='*60}")

    conn = init_db(DB_PATH)

    # Check if already ran today
    existing = conn.execute(
        "SELECT 1 FROM entropy_history WHERE date = ?", (today_str,)
    ).fetchone()
    if existing:
        log.info("Already ran today, skipping")
        conn.close()
        return

    # September skip
    if today_date.month == 9:
        log.info("September skip — no new entries")
        # Still manage existing positions
        manage_positions(conn, today_str)
        conn.close()
        return

    # 1. Get market data
    spot = get_spot_price()
    if spot is None or spot <= 0:
        log.error("Failed to get spot price")
        conn.close()
        return

    contracts = get_option_chain()
    if not contracts:
        log.error("Failed to get option chain")
        conn.close()
        return

    # 2. Compute entropy
    metrics = compute_entropy(contracts, spot)
    if metrics is None:
        log.error("Entropy computation failed")
        conn.close()
        return

    # Store (without _chain for DB)
    store = {k: v for k, v in metrics.items() if not k.startswith("_")}
    conn.execute(
        "INSERT OR REPLACE INTO entropy_history (date, spot, metrics_json) VALUES (?, ?, ?)",
        (today_str, spot, json.dumps(store))
    )
    conn.commit()
    log.info(f"Entropy computed: comp_vol={store.get('comp_volume', 'N/A'):.4f} "
             f"comp_greek={store.get('comp_greek', 'N/A'):.4f} "
             f"iv_mean={store.get('iv_mean', 'N/A'):.4f}")

    # 3. Load history
    history = get_history(conn)
    if len(history) < WARMUP_DAYS:
        log.info(f"Warming up: {len(history)}/{WARMUP_DAYS} days")
        conn.close()
        return

    # 4. Manage existing positions
    manage_positions(conn, today_str)

    # 5. Evaluate signals
    signals = evaluate_signals(metrics, history)

    # Log all signals
    for sn, sig in signals.items():
        conn.execute("""
            INSERT OR REPLACE INTO signals_log (date, strategy, fired, strength, trade_type, rationale)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (today_str, sn, 1 if sig["fire"] else 0, sig["strength"],
              sig["trade_type"], sig["rationale"]))

    firing = {k: v for k, v in signals.items() if v["fire"]}
    log.info(f"Signals: {len(firing)}/{len(signals)} firing")
    for sn, sig in signals.items():
        status = "★ FIRE" if sig["fire"] else "  skip"
        log.info(f"  {status} {sn}: {sig['rationale']} → {sig['trade_type']}")

    # 6. Get active strategies (open positions)
    active_strats = set()
    open_positions = conn.execute("SELECT DISTINCT strategy FROM positions WHERE is_open = 1").fetchall()
    for row in open_positions:
        active_strats.add(row["strategy"])

    used_symbols = set()
    open_syms = conn.execute("SELECT symbol FROM positions WHERE is_open = 1").fetchall()
    for row in open_syms:
        used_symbols.add(row["symbol"])

    # Count active long calls
    long_call_count = 0
    long_call_types = ("buy_call", "buy_call_longer", "bull_call_spread")
    active_lc = conn.execute(
        "SELECT strategy FROM positions WHERE is_open = 1 AND trade_type IN (?, ?, ?)",
        long_call_types
    ).fetchall()
    active_lc_strats = set(r["strategy"] for r in active_lc)

    # 7. Execute actionable signals
    actionable = [sn for sn in firing if sn not in active_strats]
    if actionable:
        pv = get_paper_account_value()
        avail = pv * 0.95  # Keep 5% buffer
        alloc = min(avail / len(actionable), pv * MAX_ALLOC)
        max_contracts = min(max(8, int(pv / 12500)), MAX_CONTRACTS)

        log.info(f"PV=${pv:,.0f} alloc=${alloc:,.0f}/strat max_contracts={max_contracts}")

        recs = metrics.get("_chain", [])
        for sn in sorted(actionable, key=lambda x: firing[x]["strength"], reverse=True):
            sig = firing[sn]

            # Long-call cap
            if sig["trade_type"] in long_call_types:
                if len(active_lc_strats) >= MAX_LONG_CALLS:
                    log.info(f"  ✗ {sn}: long-call cap ({len(active_lc_strats)}/{MAX_LONG_CALLS})")
                    continue

            selection = select_contract(recs, spot, sig["trade_type"], used_symbols)
            if selection is None:
                log.info(f"  ✗ {sn}: no valid contract for {sig['trade_type']}")
                continue

            if selection["type"] == "single":
                c = selection["contract"]
                qs = selection["qty_sign"]
                prem = c["mid"] * 100
                if qs > 0:
                    n = max(1, int(alloc / prem))
                else:
                    margin = max(prem * 3, c["strike"] * 100 * 0.15)
                    n = max(1, int(alloc / margin))
                n = min(n, max_contracts)

                qty = n * qs
                side = "sell_to_open" if qs < 0 else "buy_to_open"
                order = place_paper_order(c["symbol"], qty, side)

                conn.execute("""
                    INSERT INTO positions (strategy, symbol, trade_type, qty, entry_price,
                        entry_cost, entry_date, strike, expiry, is_credit)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (sn, c["symbol"], sig["trade_type"], qty, c["mid"],
                      c["mid"] * 100 * abs(qty), today_str, c["strike"],
                      c["expiry"], 1 if qs < 0 else 0))

                conn.execute("""
                    UPDATE signals_log SET executed = 1 WHERE date = ? AND strategy = ?
                """, (today_str, sn))

                used_symbols.add(c["symbol"])
                if sig["trade_type"] in long_call_types:
                    active_lc_strats.add(sn)

                side_str = "SELL" if qs < 0 else "BUY"
                kind = "C" if c["is_call"] else "P"
                log.info(f"  ★ {sn}: {side_str} {abs(qty)}x {kind} "
                         f"K={c['strike']} exp={c['expiry']} mid=${c['mid']:.2f}")

            elif selection["type"] == "spread":
                log.info(f"  ★ {sn}: spread execution (simplified for paper)")
                # For paper trading, log the spread but execute legs separately
                # Full spread execution would mirror T13's spread logic

    conn.commit()

    # 8. Record equity
    pv = get_paper_account_value()
    conn.execute("""
        INSERT OR REPLACE INTO equity_curve (date, portfolio_value, cash, positions_value)
        VALUES (?, ?, ?, ?)
    """, (today_str, pv, pv, 0))
    conn.commit()

    log.info(f"Daily complete: PV=${pv:,.0f}")
    conn.close()


if __name__ == "__main__":
    run_daily()