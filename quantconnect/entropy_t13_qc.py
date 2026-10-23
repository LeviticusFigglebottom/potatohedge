# region imports
from AlgorithmImports import *
# endregion
"""
Entropy — QuantConnect (LEAN) backtest. Defaults to QC v2 + Gallacher.

Runs on QuantConnect's historical SPY option data (daily bars with
per-contract volume). No parameters are needed: the default reproduces the
QC v2 + Gallacher algorithm as closely as it can be recovered.

Parameter `variant` (Project → Parameters):
  "v2"       (default) QC v2 + Gallacher defense, ported from entropy_engine.py
             on branch claude/sync-qc-framework-LWVUy (synced line-by-line to
             the QC v2 source in March 2026, never merged):
               - P30 entropy thresholds, z-score strength, MIN_STRENGTH 0.20
               - pcr_vol contrarian, VolCollapse = drop > P85 of daily drops
               - metric definitions of v2 (relative spreads, BSM charm, ...)
               - sizing 6% + 8% x strength, max 20 contracts, credit margin 2x
               - exits: debit TP +80% / SL -60%, credit TP +50% / SL -150%, 5 DTE
               - Gallacher: IV percentile/floor + SPY MAD regime; STRESSED halves
                 credit size, EXTREME blocks credit entries; sticky decay
             RECONSTRUCTED where the port was incomplete:
               - spreads are executed (the port only logged them), sized like singles
               - positions stack up to 3 per signal / 8 total (v2's caps); set
                 parameter one_per_signal=true for the port's 1-per-strategy gate
               - September stores metrics and manages positions, no new entries
  "spec"     The superseded T13 spec (EntropyIntegration/New Text Document.txt).
  "website"  What potatohedge's live TypeScript engine did before the Oct-2026
             fixes (T13 port with its own metric quirks, the erf-instead-of-CDF
             bug, no spreads, 0.95*pv sizing).

Other parameters: start (YYYY-MM-DD, default 2026-04-17), end (default
2026-10-22), strike_levels (default 150 strike levels each side of ATM).

Timing: metrics come from each day's closing chain; orders are sent the next
morning. On daily data LEAN converts them to market-on-close, so fills land at
the next day's close.

Results: logged at the end and saved to the Object Store as
entropy_t13_<variant>_trades.csv and entropy_t13_<variant>_metrics.csv.
"""

import math
from collections import deque
from datetime import datetime, timedelta

import numpy as np
from scipy.optimize import brentq

# ═══════════════════════════════════════════════════════════════════
#  CONSTANTS (spec Section 1)
# ═══════════════════════════════════════════════════════════════════

TICKER = "SPY"
LOOKBACK = 21
RISK_FREE = 0.05
MIN_DTE = 14
MAX_DTE = 45
TARGET_DTE = 28
MAX_ALLOC = 0.12
MAX_CONTRACTS = 25
CLOSE_DTE = 5
PROFIT_PCT = 0.50
STOP_MULT = 2.0
WARMUP_DAYS = 30
MAX_LONG_CALLS = 2
SPREAD_FILTER = 0.15
INITIAL_CASH = 100_000
HISTORY_DAYS = 60

LONG_CALL_TYPES = ("buy_call", "buy_call_longer", "bull_call_spread")

ENTROPY_KEYS = [
    "H_vol_term_n", "H_vol_k_n", "H_prem_term_n", "H_vegavol_n", "H_dgamma_n",
    "H_gvx_n", "H_dflow_n", "H_spread_k_n", "H_moneyness_n", "H_charm_n",
]
METRIC_COLUMNS = ENTROPY_KEYS + [
    "dgamma_conc5", "iv_mean", "put_skew", "pcr_dollar", "pcr_vol",
    "comp_volume", "comp_greek", "composite",
]

# ═══════════════════════════════════════════════════════════════════
#  BSM (spec Sections 3-5)
# ═══════════════════════════════════════════════════════════════════

SQRT2 = math.sqrt(2.0)
INV_SQRT_2PI = 1.0 / math.sqrt(2.0 * math.pi)


def ncdf(x):
    """Exact standard normal CDF (same values as scipy.stats.norm.cdf)."""
    return 0.5 * math.erfc(-x / SQRT2)


def ncdf_website_bug(x):
    """The website's pre-fix normCDF: A&S erf approximation applied to x
    without the 1/sqrt(2) scaling (understates IV, e.g. 15% solves to ~11.7%)."""
    a1, a2, a3, a4, a5, p = (0.254829592, -0.284496736, 1.421413741,
                             -1.453152027, 1.061405429, 0.3275911)
    sign = -1.0 if x < 0 else 1.0
    ax = abs(x)
    t = 1.0 / (1.0 + p * ax)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-ax * ax / 2)
    return 0.5 * (1.0 + sign * y)


def npdf(x):
    return INV_SQRT_2PI * math.exp(-0.5 * x * x)


def bsm_price(S, K, T, r, sig, is_call, cdf=ncdf):
    if T <= 0 or sig <= 0 or S <= 0 or K <= 0:
        return 0.0
    sq = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * sq)
    d2 = d1 - sig * sq
    if is_call:
        return S * cdf(d1) - K * math.exp(-r * T) * cdf(d2)
    return K * math.exp(-r * T) * cdf(-d2) - S * cdf(-d1)


def bsm_iv(price, S, K, T, r, is_call, cdf=ncdf):
    if T <= 1e-6 or price <= 0 or S <= 0 or K <= 0:
        return None
    disc = math.exp(-r * T)
    intr = max(S - K * disc, 0) if is_call else max(K * disc - S, 0)
    if price < intr * 0.90:
        return None
    try:
        return brentq(lambda s: bsm_price(S, K, T, r, s, is_call, cdf) - price,
                      0.01, 5.0, xtol=1e-5, maxiter=80)
    except Exception:
        return None


def bsm_greeks(S, K, T, r, sig, is_call, cdf=ncdf):
    if T <= 0 or sig <= 0:
        return {"delta": 0.0, "gamma": 0.0, "vega": 0.0, "theta": 0.0}
    sq = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * sq)
    d2 = d1 - sig * sq
    pdf = npdf(d1)
    gamma = pdf / (S * sig * sq)
    vega = S * pdf * sq / 100
    if is_call:
        delta = cdf(d1)
        theta = (-(S * pdf * sig) / (2 * sq) - r * K * math.exp(-r * T) * cdf(d2)) / 365
    else:
        delta = cdf(d1) - 1
        theta = (-(S * pdf * sig) / (2 * sq) + r * K * math.exp(-r * T) * cdf(-d2)) / 365
    return {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta}


# ═══════════════════════════════════════════════════════════════════
#  ENTROPY (spec Sections 6-7)
# ═══════════════════════════════════════════════════════════════════

def h_norm(dist):
    d = np.asarray(dist, dtype=float)
    d = d[d > 0]
    if len(d) <= 1:
        return 0.0
    d = d / d.sum()
    h = float(-np.sum(d * np.log2(d)))
    return h / np.log2(len(d))


def _mean_or_none(vals, min_len=1):
    return float(np.mean(vals)) if len(vals) >= min_len else None


def build_records(contracts, spot, cdf):
    """contracts: dicts with symbol, strike, expiry, dte, is_call, bid, ask, mid, volume."""
    recs = []
    for c in contracts:
        if c["mid"] <= 0 or c["bid"] <= 0 or c["dte"] <= 0:
            continue
        K = c["strike"]
        T = c["dte"] / 365.0
        iv = bsm_iv(c["mid"], spot, K, T, RISK_FREE, c["is_call"], cdf)
        if iv is None:
            continue
        g = bsm_greeks(spot, K, T, RISK_FREE, iv, c["is_call"], cdf)
        recs.append({
            "symbol": c["symbol"], "strike": K, "expiry": c["expiry"], "dte": c["dte"],
            "is_call": c["is_call"], "mid": c["mid"], "bid": c["bid"], "ask": c["ask"],
            "spread": c["ask"] - c["bid"], "volume": c["volume"], "iv": iv,
            "delta": g["delta"], "gamma": g["gamma"], "vega": g["vega"], "theta": g["theta"],
            "moneyness": K / spot,
        })
    return recs


def _by_key(recs, key, value_fn, skip_nonpositive=False):
    out = {}
    for r in recs:
        v = value_fn(r)
        if skip_nonpositive and not v > 0:
            continue
        out[r[key]] = out.get(r[key], 0.0) + v
    return np.array(list(out.values()), dtype=float) if out else np.array([])


def compute_entropy_spec(recs, spot):
    m = {}
    ve = _by_key(recs, "expiry", lambda r: r["volume"])
    m["H_vol_term_n"] = h_norm(ve) if ve.sum() > 0 else None
    vk = _by_key(recs, "strike", lambda r: r["volume"])
    m["H_vol_k_n"] = h_norm(vk) if vk.sum() > 0 else None
    pe = np.abs(_by_key(recs, "expiry", lambda r: r["mid"] * r["volume"] * 100))
    m["H_prem_term_n"] = h_norm(pe) if pe.sum() > 0 else None

    va = _by_key(recs, "strike", lambda r: abs(r["vega"]) * r["volume"], True)
    m["H_vegavol_n"] = h_norm(va) if len(va) > 3 and va.sum() > 0 else None

    da = _by_key(recs, "strike",
                 lambda r: abs(r["gamma"] * r["mid"] * r["volume"] * spot ** 2 * 0.01), True)
    if len(da) > 3 and da.sum() > 0:
        m["H_dgamma_n"] = h_norm(da)
        m["dgamma_conc5"] = float(sum(sorted(da, reverse=True)[:5]) / da.sum())
    else:
        m["H_dgamma_n"] = None
        m["dgamma_conc5"] = None

    ga = _by_key(recs, "strike", lambda r: abs(r["gamma"] * r["volume"] * 100), True)
    m["H_gvx_n"] = h_norm(ga) if len(ga) > 3 and ga.sum() > 0 else None

    bv = np.zeros(10)
    for r in recs:
        ad = abs(r["delta"])
        for b in range(10):
            if b * 0.1 <= ad < (b + 1) * 0.1:
                bv[b] += r["volume"]
                break
    m["H_dflow_n"] = h_norm(bv) if bv.sum() > 0 else None

    ssp, ssc = {}, {}
    for r in recs:
        if r["spread"] > 0:
            ssp[r["strike"]] = ssp.get(r["strike"], 0.0) + r["spread"]
            ssc[r["strike"]] = ssc.get(r["strike"], 0) + 1
    sk = np.array([ssp[k] / ssc[k] for k in ssp]) if ssp else np.array([])
    m["H_spread_k_n"] = h_norm(sk) if len(sk) > 3 else None

    mb = [0, 0.90, 0.95, 0.97, 0.99, 1.01, 1.03, 1.05, 1.10, 2.0]
    mv = np.zeros(len(mb) - 1)
    for r in recs:
        if r["volume"] > 0:
            for b in range(len(mb) - 1):
                if mb[b] <= r["moneyness"] < mb[b + 1]:
                    mv[b] += r["volume"]
                    break
    m["H_moneyness_n"] = h_norm(mv) if mv.sum() > 0 else None

    db = [0, 5, 10, 15, 20, 30, 45]
    cv = np.zeros(len(db) - 1)
    for r in recs:
        if abs(r["delta"]) > 0 and r["dte"] > 0:
            gv = r["gamma"] * r["volume"] / max(r["dte"], 1)
            for b in range(len(db) - 1):
                if db[b] < r["dte"] <= db[b + 1]:
                    cv[b] += abs(gv)
                    break
    m["H_charm_n"] = h_norm(cv) if cv.sum() > 0 else None

    calls = [r for r in recs if r["is_call"]]
    puts = [r for r in recs if not r["is_call"]]
    cvol = sum(r["volume"] for r in calls)
    pvol = sum(r["volume"] for r in puts)
    m["pcr_vol"] = pvol / cvol if cvol > 0 else None
    cdv = sum(r["mid"] * r["volume"] for r in calls)
    pdv = sum(r["mid"] * r["volume"] for r in puts)
    m["pcr_dollar"] = pdv / cdv if cdv > 0 else None

    near = [r for r in recs if 7 <= r["dte"] <= 45]
    ivs = [r["iv"] for r in near if r["iv"] > 0]
    m["iv_mean"] = float(np.mean(ivs)) if len(ivs) > 5 else None

    atm = [r for r in near if 0.98 <= r["moneyness"] <= 1.02]
    otp = [r for r in near if not r["is_call"] and r["moneyness"] < 0.97]
    atm_ivs = [r["iv"] for r in atm if r["iv"] > 0]
    atm_iv = float(np.mean(atm_ivs)) if atm_ivs else None
    ov = [r["iv"] for r in otp if r["iv"] > 0]
    m["put_skew"] = float(np.mean(ov)) - atm_iv if (otp and atm_iv is not None and ov) else None

    _composites(m)
    return m


def compute_entropy_website(recs, spot):
    """Port of computeEntropy() in src/lib/entropy/engine.ts (pre-fix)."""
    m = {}
    ve = _by_key(recs, "expiry", lambda r: r["volume"])
    m["H_vol_term_n"] = h_norm(ve) if ve.sum() > 0 else None
    vk = _by_key(recs, "strike", lambda r: r["volume"])
    m["H_vol_k_n"] = h_norm(vk) if vk.sum() > 0 else None
    pe = np.abs(_by_key(recs, "expiry", lambda r: r["mid"] * max(r["volume"], 1) * 100))
    m["H_prem_term_n"] = h_norm(pe) if pe.sum() > 0 else None
    vv = _by_key(recs, "strike", lambda r: abs(r["vega"]) * r["volume"])
    m["H_vegavol_n"] = h_norm(vv) if vv.sum() > 0 else None

    dg = _by_key(recs, "strike", lambda r: abs(r["gamma"]) * spot * spot * 0.01)
    if dg.sum() > 0:
        m["dgamma_conc5"] = float(sum(sorted(dg, reverse=True)[:5]) / dg.sum())
        m["H_dgamma_n"] = h_norm(dg)
    else:
        m["dgamma_conc5"] = None
        m["H_dgamma_n"] = None

    gv = _by_key(recs, "strike", lambda r: abs(r["gamma"]) * r["volume"])
    m["H_gvx_n"] = h_norm(gv) if gv.sum() > 0 else None

    bv = np.zeros(10)
    for r in recs:
        ad = abs(r["delta"])
        for b in range(10):
            if b * 0.1 <= ad < (b + 1) * 0.1:
                bv[b] += r["volume"]
                break
    m["H_dflow_n"] = h_norm(bv) if bv.sum() > 0 else None

    sp = np.abs(_by_key(recs, "strike", lambda r: r["spread"]))
    m["H_spread_k_n"] = h_norm(sp) if sp.sum() > 0 else None

    mb = [0.85, 0.90, 0.95, 0.97, 1.0, 1.03, 1.05, 1.10, 1.15]
    mv = np.zeros(len(mb) - 1)
    for r in recs:
        for b in range(len(mb) - 1):
            if mb[b] <= r["moneyness"] < mb[b + 1]:
                mv[b] += r["volume"]
                break
    m["H_moneyness_n"] = h_norm(mv) if mv.sum() > 0 else None

    cb = [0, 7, 14, 21, 28, 35, 45]
    cv = np.zeros(len(cb) - 1)
    for r in recs:
        charm = abs(r["gamma"] * (RISK_FREE - r["iv"] ** 2 / 2) / r["iv"]) if r["iv"] > 0 else 0.0
        for b in range(len(cb) - 1):
            if cb[b] < r["dte"] <= cb[b + 1]:
                cv[b] += charm
                break
    m["H_charm_n"] = h_norm(cv) if cv.sum() > 0 else None

    near = [r for r in recs if 7 <= r["dte"] <= 45]
    ivs = [r["iv"] for r in near if r["iv"] > 0]
    m["iv_mean"] = float(np.mean(ivs)) if len(ivs) > 5 else None

    near_puts = [r for r in recs if not r["is_call"] and 14 <= r["dte"] <= 45]
    atm = [r["iv"] for r in near_puts if 0.98 <= r["moneyness"] <= 1.02]
    otm = [r["iv"] for r in near_puts if 0.90 <= r["moneyness"] < 0.97]
    m["put_skew"] = float(np.mean(otm)) - float(np.mean(atm)) if atm and otm else None

    calls = [r for r in recs if r["is_call"]]
    puts = [r for r in recs if not r["is_call"]]
    cprem = sum(r["mid"] * r["volume"] for r in calls)
    pprem = sum(r["mid"] * r["volume"] for r in puts)
    m["pcr_dollar"] = pprem / cprem if cprem > 0 else None
    cvol = sum(r["volume"] for r in calls)
    pvol = sum(r["volume"] for r in puts)
    m["pcr_vol"] = pvol / cvol if cvol > 0 else None

    _composites(m)
    return m


def _composites(m):
    cv_vals = [m[k] for k in ("H_vol_term_n", "H_prem_term_n", "H_vol_k_n", "H_vegavol_n")
               if m.get(k) is not None]
    m["comp_volume"] = _mean_or_none(cv_vals)
    gk_vals = [m[k] for k in ("H_gvx_n", "H_dflow_n", "H_vegavol_n", "H_dgamma_n", "H_charm_n")
               if m.get(k) is not None]
    m["comp_greek"] = _mean_or_none(gk_vals)
    all_v = [m[k] for k in ENTROPY_KEYS if m.get(k) is not None]
    m["composite"] = _mean_or_none(all_v)


# ═══════════════════════════════════════════════════════════════════
#  ROLLING STATS + SIGNALS (spec Sections 8-9)
# ═══════════════════════════════════════════════════════════════════

def med(history, key, lookback=LOOKBACK):
    vals = [h[key] for h in list(history)[-lookback:] if h.get(key) is not None]
    return float(np.median(vals)) if len(vals) >= lookback // 2 else None


def pct(history, key, percentile):
    vals = [h[key] for h in history if h.get(key) is not None]
    return float(np.percentile(vals, percentile)) if len(vals) >= LOOKBACK // 2 else None


def strength(a, b):
    return max(0.0, min((b - a) / abs(b), 1.0)) if b else 0.0


def d1cv_and_p20(history, variant):
    """Returns (d1cv, p20). Spec stores _d1cv on the newest row and takes the
    percentile of stored values; the website recomputed consecutive diffs."""
    h = list(history)
    if variant == "spec":
        d1cv = None
        if len(h) >= 2:
            curr, prev = h[-1].get("comp_volume"), h[-2].get("comp_volume")
            if curr is not None and prev is not None:
                d1cv = curr - prev
        if d1cv is not None:
            h[-1]["_d1cv"] = d1cv
        return d1cv, pct(h, "_d1cv", 20)
    vals = [x["comp_volume"] for x in h if x.get("comp_volume") is not None]
    d1cv = vals[-1] - vals[-2] if len(vals) >= 2 else None
    diffs = [h[i]["comp_volume"] - h[i - 1]["comp_volume"] for i in range(1, len(h))
             if h[i].get("comp_volume") is not None and h[i - 1].get("comp_volume") is not None]
    p20 = float(np.percentile(diffs, 20)) if len(diffs) >= LOOKBACK // 2 else None
    return d1cv, p20


def evaluate_signals(m, history, variant):
    sigs = {}
    cv, cv_m = m.get("comp_volume"), med(history, "comp_volume")
    cg, cg_m = m.get("comp_greek"), med(history, "comp_greek")
    co, co_m = m.get("composite"), med(history, "composite")
    iv, iv_m = m.get("iv_mean"), med(history, "iv_mean")
    ps, ps_m = m.get("put_skew"), med(history, "put_skew")
    pcr = m.get("pcr_dollar")
    d1cv, p20 = d1cv_and_p20(history, variant)

    def sig(fire, s, tt, why):
        return {"fire": bool(fire), "strength": float(s) if fire else 0.0,
                "trade_type": tt, "rationale": why}

    if cv is not None and cv_m is not None:
        fire = cv < cv_m
        tt = "buy_call" if (iv is not None and iv_m is not None and iv < iv_m) else "sell_put"
        sigs["S_LowVolEnt"] = sig(fire, strength(cv, cv_m), tt, f"cv={cv:.4f} med={cv_m:.4f}")

    if d1cv is not None and p20 is not None:
        fire = d1cv < p20
        s = max(0.0, min(abs(d1cv / p20) - 1, 1.0)) if p20 != 0 else 0.0
        sigs["S_VolCollapse"] = sig(fire, s, "bull_call_spread", f"d1cv={d1cv:.4f} p20={p20:.4f}")

    if None not in (co, co_m, iv, iv_m):
        fire = co < co_m and iv < iv_m
        s = (strength(co, co_m) + strength(iv, iv_m)) / 2
        sigs["S_LowEntLowIV"] = sig(fire, s, "buy_call_longer", f"co={co:.4f} iv={iv:.4f}")

    if cg is not None and cg_m is not None:
        fire = cg < cg_m
        sigs["S_LowGreekEnt"] = sig(fire, strength(cg, cg_m), "sell_put", f"cg={cg:.4f} med={cg_m:.4f}")

    if None not in (cv, cv_m, ps, ps_m):
        fire = cv < cv_m and ps > ps_m
        s1 = strength(cv, cv_m) if cv < cv_m else 0.0
        s2 = max(0.0, min((ps - ps_m) / abs(ps_m), 1.0)) if ps_m and ps > ps_m else 0.0
        sigs["S_SkewFlow"] = sig(fire, min((s1 + s2) / 2, 1.0), "sell_put_spread",
                                 f"cv={cv:.4f} sk={ps:.4f} med={ps_m:.4f}")

    if pcr is not None:
        p80 = pct(history, "pcr_dollar", 80)
        if p80 is not None:
            fire = pcr > p80
            s = max(0.0, min((pcr - p80) / p80, 1.0)) if p80 > 0 else 0.0
            sigs["S_PCRContrarian"] = sig(fire, s, "sell_put", f"pcr={pcr:.4f} p80={p80:.4f}")
    return sigs


# ═══════════════════════════════════════════════════════════════════
#  CONTRACT SELECTION (spec Section 10)
# ═══════════════════════════════════════════════════════════════════

def select_contract(recs, tt, used):
    avail = [r for r in recs if r["symbol"] not in used]
    elig = [r for r in avail if MIN_DTE <= r["dte"] <= MAX_DTE]
    if not elig:
        return None
    elig.sort(key=lambda r: abs(r["dte"] - TARGET_DTE))
    best_exp = elig[0]["expiry"]
    ae = [r for r in elig if r["expiry"] == best_exp]
    calls = sorted([r for r in ae if r["is_call"]], key=lambda r: r["strike"])
    puts = sorted([r for r in ae if not r["is_call"]], key=lambda r: r["strike"])
    atm_k = min(ae, key=lambda r: abs(r["moneyness"] - 1.0))["strike"]

    def closest(rows, target):
        return min(rows, key=lambda r: abs(r["moneyness"] - target)) if rows else None

    if tt == "buy_call":
        c = closest([r for r in calls if abs(r["strike"] - atm_k) <= 2 and r["mid"] > 0], 1.0)
        if c and c["spread"] < c["mid"] * SPREAD_FILTER:
            return {"type": "single", "contract": c, "qty_sign": 1}
    elif tt == "buy_call_longer":
        c = closest([r for r in avail if r["is_call"] and 25 <= r["dte"] <= 45
                     and abs(r["moneyness"] - 1.0) < 0.02 and r["mid"] > 0], 1.0)
        if c and c["spread"] < c["mid"] * SPREAD_FILTER:
            return {"type": "single", "contract": c, "qty_sign": 1}
    elif tt == "sell_put":
        c = closest([r for r in puts if 0.955 < r["moneyness"] < 0.995 and r["mid"] > 0.10], 0.97)
        if c and c["spread"] < c["mid"] * SPREAD_FILTER:
            return {"type": "single", "contract": c, "qty_sign": -1}
    elif tt == "bull_call_spread":
        lng = closest([r for r in calls if abs(r["moneyness"] - 1.0) < 0.02 and r["mid"] > 0], 1.0)
        sht = closest([r for r in calls if 1.02 < r["moneyness"] < 1.05 and r["mid"] > 0], 1.03)
        if lng and sht and lng["mid"] > sht["mid"]:
            return {"type": "spread", "long": lng, "short": sht}
    elif tt == "sell_put_spread":
        sht = closest([r for r in puts if 0.96 < r["moneyness"] < 0.995 and r["mid"] > 0.10], 0.98)
        lng = closest([r for r in puts if 0.935 < r["moneyness"] < 0.975 and r["mid"] > 0.05], 0.95)
        if sht and lng and sht["strike"] > lng["strike"] and sht["mid"] > lng["mid"]:
            return {"type": "spread", "short": sht, "long": lng}
    return None


def compute_contracts(alloc, mid, strike, qty_sign, pv):
    prem = mid * 100
    if qty_sign > 0:
        n = max(1, int(alloc / prem))
    else:
        margin = max(prem * 3, strike * 100 * 0.15)
        n = max(1, int(alloc / margin))
    max_c = max(8, min(int(pv / 12500), MAX_CONTRACTS))
    return min(n, max_c)


# ═══════════════════════════════════════════════════════════════════
#  QC v2 + GALLACHER (default variant)
#  Source: entropy_engine.py on branch claude/sync-qc-framework-LWVUy,
#  which a March-2026 session synced line-by-line to the QC v2 algorithm
#  (commits 8c4246a, 5bc3594, 5f66247). Reconstructions where that port was
#  incomplete are marked "RECONSTRUCTED".
# ═══════════════════════════════════════════════════════════════════

V2_BASE_ALLOC = 0.06
V2_MAX_ALLOC = 0.14
V2_MAX_CONTRACTS = 20
V2_MAX_POSITIONS = 8
V2_MAX_PER_SIGNAL_TYPE = 3
V2_ENTROPY_PERCENTILE = 30
V2_VOLCOLLAPSE_PERCENTILE = 85
V2_PCR_PERCENTILE = 80
V2_MIN_STRENGTH = 0.20
V2_TP_DEBIT, V2_TP_CREDIT = 0.80, 0.50
V2_SL_DEBIT, V2_SL_CREDIT = -0.60, -1.50

# Gallacher defense
IV_STRESSED_PCT, IV_EXTREME_PCT = 80, 95
IV_STRESSED_FLOOR, IV_EXTREME_FLOOR = 0.18, 0.25
MAD_STRESSED_MULT, MAD_EXTREME_MULT = 1.5, 2.5
MAD_STRESSED_FLOOR, MAD_EXTREME_FLOOR = 0.008, 0.015
MAD_WINDOW = 10
MAD_BASELINE_LOOKBACK = 42
STRESSED_SIZE_MULT = 0.50
REGIME_COOLDOWN_DAYS = 5
REGIME_LEVELS = {"NORMAL": 0, "STRESSED": 1, "EXTREME": 2}
CREDIT_TYPES = ("sell_put", "sell_put_spread")


def build_records_v2(contracts, spot):
    recs = []
    for c in contracts:
        mid, bid = c["mid"], c["bid"]
        if mid <= 0 or bid <= 0 or c["dte"] <= 0:
            continue
        K, T, is_call = c["strike"], c["dte"] / 365.0, c["is_call"]
        iv = bsm_iv(mid, spot, K, T, RISK_FREE, is_call)
        if iv is None:
            continue
        g = bsm_greeks(spot, K, T, RISK_FREE, iv, is_call)
        sq = math.sqrt(T)
        d1 = (math.log(spot / K) + (RISK_FREE + 0.5 * iv * iv) * T) / (iv * sq)
        d2 = d1 - iv * sq
        charm = -npdf(d1) * (2 * RISK_FREE * T - d2 * iv * sq) / (2 * T * iv * sq)
        recs.append({
            "symbol": c["symbol"], "strike": K, "expiry": c["expiry"], "dte": c["dte"],
            "is_call": is_call, "mid": mid, "bid": bid, "ask": c["ask"],
            "spread": (c["ask"] - bid) / mid,   # relative spread in v2
            "volume": c["volume"], "iv": iv, "delta": g["delta"], "gamma": g["gamma"],
            "vega": g["vega"], "theta": g["theta"], "charm": charm, "moneyness": K / spot,
        })
    return recs


def compute_entropy_v2(recs, spot):
    m = {}
    ve = _by_key(recs, "expiry", lambda r: r["volume"])
    m["H_vol_term_n"] = h_norm(ve) if ve.sum() > 0 else None
    vk = _by_key(recs, "strike", lambda r: r["volume"])
    m["H_vol_k_n"] = h_norm(vk) if vk.sum() > 0 else None
    pe = np.abs(_by_key(recs, "expiry", lambda r: r["mid"] * r["volume"] * 100))
    m["H_prem_term_n"] = h_norm(pe) if pe.sum() > 0 else None
    vv = _by_key(recs, "strike", lambda r: abs(r["vega"]) * r["volume"])
    m["H_vegavol_n"] = h_norm(vv) if vv.sum() > 0 else None

    da = _by_key(recs, "strike", lambda r: abs(r["gamma"]) * r["volume"] * spot * 100)
    if da.sum() > 0:
        m["dgamma_conc5"] = float(sum(np.sort(da)[::-1][:5]) / da.sum())
        m["H_dgamma_n"] = h_norm(da)
    else:
        m["dgamma_conc5"] = m["H_dgamma_n"] = None

    gv = _by_key(recs, "strike", lambda r: abs(r["gamma"]) * r["volume"])
    m["H_gvx_n"] = h_norm(gv) if gv.sum() > 0 else None

    edges = np.linspace(0, 1, 11)
    dflow = np.zeros(10)
    for r in recs:
        ad = abs(r["delta"])
        for b in range(10):
            if edges[b] <= ad < edges[b + 1]:
                dflow[b] += r["volume"]
                break
    m["H_dflow_n"] = h_norm(dflow) if dflow.sum() > 0 else None

    sl = {}
    for r in recs:
        if r["spread"] > 0 and r["volume"] > 0:
            sl[r["strike"]] = sl.get(r["strike"], 0.0) + r["volume"] / r["spread"]
    sps = np.array(list(sl.values())) if sl else np.array([])
    m["H_spread_k_n"] = h_norm(sps) if len(sps) > 0 and sps.sum() > 0 else 0.5

    mb = [0.85 + i * 0.02 for i in range(16)]
    mv = np.zeros(len(mb) - 1)
    for r in recs:
        for b in range(len(mb) - 1):
            if mb[b] <= r["moneyness"] < mb[b + 1]:
                mv[b] += r["volume"]
                break
    m["H_moneyness_n"] = h_norm(mv) if mv.sum() > 0 else None

    cb = list(range(MIN_DTE, MAX_DTE + 2, 5))
    cv = np.zeros(len(cb) - 1)
    for r in recs:
        for b in range(len(cb) - 1):
            if cb[b] <= r["dte"] < cb[b + 1]:
                cv[b] += abs(r["charm"])
                break
    m["H_charm_n"] = h_norm(cv) if cv.sum() > 0 else None

    atm_near = [r for r in recs if 0.97 <= r["moneyness"] <= 1.03 and r["dte"] <= 30]
    m["iv_mean"] = float(np.mean([r["iv"] for r in (atm_near or recs)]))

    near_puts = [r for r in recs if not r["is_call"] and 14 <= r["dte"] <= 45]
    atm = [r["iv"] for r in near_puts if 0.98 <= r["moneyness"] <= 1.02]
    otm = [r["iv"] for r in near_puts if 0.90 <= r["moneyness"] <= 0.95]
    m["put_skew"] = float(np.mean(otm) - np.mean(atm)) if atm and otm else None

    calls = [r for r in recs if r["is_call"]]
    puts = [r for r in recs if not r["is_call"]]
    cprem = sum(r["mid"] * r["volume"] for r in calls)
    pprem = sum(r["mid"] * r["volume"] for r in puts)
    m["pcr_dollar"] = float(pprem / cprem) if cprem > 0 else None
    cvol = sum(r["volume"] for r in calls)
    pvol = sum(r["volume"] for r in puts)
    m["pcr_vol"] = float(pvol / cvol) if cvol > 0 else None

    cv_vals = [m[k] for k in ("H_vol_term_n", "H_vol_k_n", "H_prem_term_n", "H_dflow_n")
               if m.get(k) is not None]
    m["comp_volume"] = _mean_or_none(cv_vals)
    cg_vals = [m[k] for k in ("H_vegavol_n", "H_dgamma_n", "H_gvx_n", "H_spread_k_n", "H_charm_n")
               if m.get(k) is not None]
    m["comp_greek"] = _mean_or_none(cg_vals)
    all_v = [m[k] for k in ENTROPY_KEYS if m.get(k) is not None]
    m["composite"] = _mean_or_none(all_v)
    return m


def _std(history, key):
    vals = [h[key] for h in list(history)[-LOOKBACK:] if h.get(key) is not None]
    return float(np.std(vals)) if len(vals) > 1 else 0.01


def _zstrength(val, key, history):
    m, s = med(history, key), _std(history, key)
    if m is None or s < 1e-8:
        return 0.0
    return max(0.0, min(1.0, (m - val) / s / 3.0))


def evaluate_signals_v2(metrics, history):
    sigs = {}
    ep = V2_ENTROPY_PERCENTILE
    cv, cg, co = metrics.get("comp_volume"), metrics.get("comp_greek"), metrics.get("composite")
    iv, ps, pcr = metrics.get("iv_mean"), metrics.get("put_skew"), metrics.get("pcr_vol")
    t_cv, t_cg = pct(history, "comp_volume", ep), pct(history, "comp_greek", ep)
    t_cc, t_iv = pct(history, "composite", ep), pct(history, "iv_mean", ep)
    ps_m, iv_m = med(history, "put_skew"), med(history, "iv_mean")

    def sig(fire, s, tt, why):
        return {"fire": bool(fire and s >= V2_MIN_STRENGTH), "strength": float(s),
                "trade_type": tt, "rationale": why}

    if cv is not None and t_cv is not None:
        fire = cv < t_cv
        s = _zstrength(cv, "comp_volume", history) if fire else 0.0
        tt = "buy_call" if (iv and iv_m and iv < iv_m) else "sell_put"
        sigs["S_LowVolEnt"] = sig(fire, s, tt, f"cv={cv:.4f} p{ep}={t_cv:.4f}")

    h = list(history)
    if len(h) >= 2:
        vals = [x.get("comp_volume") for x in h if x.get("comp_volume") is not None]
        curr = metrics.get("comp_volume")
        prev = vals[-2] if len(vals) >= 2 else None   # history includes today
        if prev is not None and curr is not None:
            drop = prev - curr
            hv = [x.get("comp_volume") for x in h]
            drops = [hv[i - 1] - hv[i] for i in range(1, len(hv))
                     if hv[i - 1] is not None and hv[i] is not None]
            if drops and drop > 0:
                thresh = float(np.percentile(drops, V2_VOLCOLLAPSE_PERCENTILE))
                fire = drop > thresh
                s = max(V2_MIN_STRENGTH, min(1.0, drop / (thresh + 1e-8) - 1.0)) if fire else 0.0
                sigs["S_VolCollapse"] = sig(fire, s, "bull_call_spread",
                                            f"drop={drop:.4f} p85={thresh:.4f}")

    if None not in (co, t_cc, iv, t_iv):
        fire = co < t_cc and iv < t_iv
        s = _zstrength(co, "composite", history) if fire else 0.0
        sigs["S_LowEntLowIV"] = sig(fire, s, "buy_call_longer", f"co={co:.4f} iv={iv:.4f}")

    if cg is not None and t_cg is not None:
        fire = cg < t_cg
        s = _zstrength(cg, "comp_greek", history) if fire else 0.0
        sigs["S_LowGreekEnt"] = sig(fire, s, "sell_put", f"cg={cg:.4f} p{ep}={t_cg:.4f}")

    if None not in (cv, t_cv, ps, ps_m):
        fire = cv < t_cv and ps > ps_m and ps > 0.01
        s = _zstrength(cv, "comp_volume", history) if fire else 0.0
        sigs["S_SkewFlow"] = sig(fire, s, "sell_put_spread", f"cv={cv:.4f} sk={ps:.4f}")

    if pcr is not None:
        p80 = pct(history, "pcr_vol", V2_PCR_PERCENTILE)
        if p80 is not None:
            fire = pcr > p80
            s = min(1.0, (pcr - p80) / (_std(history, "pcr_vol") + 1e-8)) if fire else 0.0
            sigs["S_PCRContrarian"] = sig(fire, s, "sell_put", f"pcr_vol={pcr:.4f} p80={p80:.4f}")
    return sigs


def select_contract_v2(recs, tt, used):
    avail = [r for r in recs if r["symbol"] not in used]
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
        cs = [r for r in ca if 0.99 <= r["moneyness"] <= 1.01 and r["mid"] > 0.10]
        if not cs:
            cs = [r for r in ca if abs(r["strike"] - atm_k) <= 2 and r["mid"] > 0]
        if cs:
            c = min(cs, key=lambda r: abs(r["moneyness"] - 1.0))
            if c["spread"] < SPREAD_FILTER:
                return {"type": "single", "contract": c, "qty_sign": 1}
    elif tt == "buy_call_longer":
        lo = [r for r in avail if r["is_call"] and 25 <= r["dte"] <= 45
              and 0.99 <= r["moneyness"] <= 1.01 and r["mid"] > 0.10]
        if lo:
            # v2 picks DTE closest to 35; ties broken by moneyness (chain order is arbitrary in LEAN)
            c = min(lo, key=lambda r: (abs(r["dte"] - 35), abs(r["moneyness"] - 1.0)))
            if c["spread"] < SPREAD_FILTER:
                return {"type": "single", "contract": c, "qty_sign": 1}
    elif tt == "sell_put":
        ot = [r for r in pa if 0.96 <= r["moneyness"] <= 0.98 and r["mid"] > 0.10]
        if ot:
            # v2 takes min(|dte-28|) within one expiry, i.e. the first (lowest-strike) candidate
            c = min(ot, key=lambda r: abs(r["dte"] - TARGET_DTE))
            if c["spread"] < SPREAD_FILTER:
                return {"type": "single", "contract": c, "qty_sign": -1}
    elif tt == "bull_call_spread":
        lc = [r for r in ca if 0.99 <= r["moneyness"] <= 1.01 and r["mid"] > 0]
        sc = [r for r in ca if 1.02 <= r["moneyness"] <= 1.04 and r["mid"] > 0]
        if lc and sc:
            l = min(lc, key=lambda r: abs(r["moneyness"] - 1.0))
            s = min(sc, key=lambda r: abs(r["moneyness"] - 1.03))
            if l["expiry"] == s["expiry"] and l["mid"] > s["mid"]:
                return {"type": "spread", "long": l, "short": s}
    elif tt == "sell_put_spread":
        spl = [r for r in pa if 0.97 <= r["moneyness"] <= 0.99 and r["mid"] > 0.10]
        lp = [r for r in pa if 0.94 <= r["moneyness"] <= 0.96 and r["mid"] > 0.05]
        if spl and lp:
            s = min(spl, key=lambda r: abs(r["moneyness"] - 0.98))
            l = min(lp, key=lambda r: abs(r["moneyness"] - 0.95))
            if s["expiry"] == l["expiry"] and s["strike"] > l["strike"] and s["mid"] > l["mid"]:
                return {"type": "spread", "short": s, "long": l}
    return None


def assess_regime(iv_mean, history, closes, current, trading_days, last_change_day):
    """Gallacher defense: IV percentile + absolute floor, SPY mean-absolute-return
    vs its baseline, with sticky one-level-per-cooldown decay."""
    raw = "NORMAL"
    h = list(history)
    if len(h) >= LOOKBACK:
        iv_hist = [x.get("iv_mean") for x in h[-LOOKBACK:] if x.get("iv_mean") is not None]
        if len(iv_hist) >= LOOKBACK // 2:
            p80 = float(np.percentile(iv_hist, IV_STRESSED_PCT))
            p95 = float(np.percentile(iv_hist, IV_EXTREME_PCT))
            if iv_mean > p95 and iv_mean > IV_EXTREME_FLOOR:
                raw = "EXTREME"
            elif iv_mean > p80 and iv_mean > IV_STRESSED_FLOOR:
                raw = "STRESSED"

    closes = list(closes)
    if len(closes) >= MAD_WINDOW + MAD_BASELINE_LOOKBACK:
        rets = [abs(closes[i] / closes[i - 1] - 1) for i in range(1, len(closes))]
        cur_mad = float(np.mean(rets[-MAD_WINDOW:]))
        mad_hist = [float(np.mean(rets[j - MAD_WINDOW:j])) for j in range(MAD_WINDOW, len(rets))]
        base_len = min(len(mad_hist), MAD_BASELINE_LOOKBACK)
        if base_len >= LOOKBACK:
            mad_med = float(np.median(mad_hist[-base_len:]))
            if mad_med > 0:
                ratio = cur_mad / mad_med
                if ratio > MAD_EXTREME_MULT and cur_mad > MAD_EXTREME_FLOOR:
                    raw = "EXTREME"
                elif ratio > MAD_STRESSED_MULT and cur_mad > MAD_STRESSED_FLOOR and raw != "EXTREME":
                    raw = "STRESSED"

    cur_lvl, raw_lvl = REGIME_LEVELS.get(current, 0), REGIME_LEVELS[raw]
    if raw_lvl >= cur_lvl:
        return raw
    if trading_days - last_change_day >= REGIME_COOLDOWN_DAYS:
        lvl = max(raw_lvl, cur_lvl - 1)
        return {0: "NORMAL", 1: "STRESSED", 2: "EXTREME"}[lvl]
    return current


# ═══════════════════════════════════════════════════════════════════
#  ALGORITHM
# ═══════════════════════════════════════════════════════════════════

class EntropyT13(QCAlgorithm):

    def initialize(self):
        self.variant = (self.get_parameter("variant") or "v2").strip().lower()
        if self.variant not in ("v2", "spec", "website"):
            raise ValueError("variant must be 'v2', 'spec' or 'website'")
        # v2 only: "true" restores the website port's one-open-position-per-strategy gate
        self.one_per_signal = (self.get_parameter("one_per_signal") or "false").strip().lower() == "true"
        start = datetime.strptime(self.get_parameter("start") or "2026-04-17", "%Y-%m-%d")
        end = datetime.strptime(self.get_parameter("end") or "2026-10-22", "%Y-%m-%d")
        strike_levels = int(self.get_parameter("strike_levels") or 150)

        self.set_start_date(start.year, start.month, start.day)
        self.set_end_date(end.year, end.month, end.day)
        self.set_cash(INITIAL_CASH)

        self.spy = self.add_equity(TICKER, Resolution.DAILY).symbol
        option = self.add_option(TICKER, Resolution.DAILY)
        option.set_filter(lambda u: u.include_weeklys()
                          .strikes(-strike_levels, strike_levels)
                          .expiration(MIN_DTE, MAX_DTE))
        self.option_symbol = option.symbol

        self.cdf = ncdf_website_bug if self.variant == "website" else ncdf
        if self.variant == "v2":
            self.tp_debit, self.sl_debit = V2_TP_DEBIT, V2_SL_DEBIT
            self.tp_credit, self.sl_credit = V2_TP_CREDIT, V2_SL_CREDIT
        else:
            self.tp_debit, self.sl_debit = 1.0, -(STOP_MULT - 1)
            self.tp_credit, self.sl_credit = PROFIT_PCT, -STOP_MULT

        # Gallacher state (v2). SPY closes seeded from history so the MAD
        # check (needs 52 closes) is live from the first trading day.
        self.closes = deque(maxlen=MAD_WINDOW + MAD_BASELINE_LOOKBACK + 5)
        try:
            seed = self.history(self.spy, MAD_WINDOW + MAD_BASELINE_LOOKBACK + 5, Resolution.DAILY)
            for close in seed["close"].values:
                self.closes.append(float(close))
        except Exception as err:
            self.debug(f"close-history seed failed: {err}")
        self.regime = "NORMAL"
        self.trading_days = 0
        self.last_regime_change_day = 0
        self.regime_days = {}
        self.history = deque(maxlen=HISTORY_DAYS)
        self.positions = []          # strategy book (spec Section 15 "positions")
        self.next_id = 1
        self.pending = []            # orders to send at the next open
        self.last_data_date = None
        self.metric_rows = []
        self.signal_counts = {}

        self.schedule.on(self.date_rules.every_day(self.spy),
                         self.time_rules.after_market_open(self.spy, 1),
                         self.send_pending_orders)

    # ── daily cycle ────────────────────────────────────────────────

    def on_data(self, data: Slice):
        chain = data.option_chains.get(self.option_symbol)
        if chain is None or not data.bars.contains_key(self.spy):
            return
        bar = data.bars[self.spy]
        day = bar.time.date()
        if day == self.last_data_date:
            return
        self.last_data_date = day
        spot = float(bar.close)
        self.closes.append(spot)

        contracts = []
        for c in chain:
            bid, ask = float(c.bid_price), float(c.ask_price)
            contracts.append({
                "symbol": c.symbol, "strike": float(c.strike), "expiry": c.expiry.date(),
                "dte": (c.expiry.date() - day).days,
                "is_call": c.right == OptionRight.CALL,
                "bid": bid, "ask": ask, "mid": (bid + ask) / 2, "volume": float(c.volume or 0),
            })
        contracts = [c for c in contracts if MIN_DTE <= c["dte"] <= MAX_DTE]

        september = day.month == 9
        if september and self.variant == "website":
            # Website returned before fetching/storing metrics in September
            self.manage_positions(day, spot)
            return

        if self.variant == "v2":
            recs = build_records_v2(contracts, spot)
        else:
            recs = build_records(contracts, spot, self.cdf)
        if len(recs) < 10:
            self.debug(f"{day}: only {len(recs)} valid records, skipping")
            return
        compute = {"v2": compute_entropy_v2, "spec": compute_entropy_spec,
                   "website": compute_entropy_website}[self.variant]
        m = compute(recs, spot)
        self.history.append(dict(m))
        self.metric_rows.append((day, spot, len(recs), m))

        if len(self.history) < WARMUP_DAYS:
            return

        self.manage_positions(day, spot)
        if september:
            return

        if self.variant == "v2":
            sigs = evaluate_signals_v2(m, self.history)
        else:
            sigs = evaluate_signals(m, self.history, self.variant)
        for name, s in sigs.items():
            if s["fire"]:
                self.signal_counts[name] = self.signal_counts.get(name, 0) + 1
        firing = {k: v for k, v in sigs.items() if v["fire"]}

        if self.variant == "v2":
            self.trading_days += 1
            if m.get("iv_mean") is not None:
                new = assess_regime(m["iv_mean"], self.history, self.closes, self.regime,
                                    self.trading_days, self.last_regime_change_day)
                if new != self.regime:
                    self.last_regime_change_day = self.trading_days
                    self.debug(f"{day}: regime {self.regime} -> {new}")
                    self.regime = new
            self.regime_days[self.regime] = self.regime_days.get(self.regime, 0) + 1
            self.enter_positions_v2(day, recs, firing)
        else:
            self.enter_positions(day, recs, firing)

    # ── position book helpers ──────────────────────────────────────

    def mark(self, pos):
        """Dollars to close all legs at current mid (+ proceeds, − cost)."""
        total = 0.0
        for sym, qty in pos["legs"]:
            sec = self.securities[sym]
            bid, ask = float(sec.bid_price), float(sec.ask_price)
            mid = (bid + ask) / 2
            if mid <= 0:
                return None
            total += qty * mid * 100
        return total

    def open_cashflow(self, pos):
        if pos["open_filled"]:
            return pos["cash_open"]
        return pos["entry_cost"] if pos["is_credit"] else -pos["entry_cost"]

    def committed(self):
        total = 0.0
        for p in self.positions:
            if not p["open"] or p["closing"]:
                continue
            if not p["is_credit"]:
                total += p["entry_cost"]
            elif p["width"]:
                total += p["width"] * 100 * abs(p["legs"][0][1])
            else:
                total += p["strike"] * 100 * 0.15 * abs(p["legs"][0][1])
        return total

    def manage_positions(self, day, spot):
        for pos in [p for p in self.positions if p["open"] and not p["closing"]]:
            dte = (pos["expiry"] - day).days
            if dte <= CLOSE_DTE:
                self.close(pos, day, "DTE")
                continue
            mk = self.mark(pos)
            if mk is None:
                continue
            pnl = self.open_cashflow(pos) + mk
            basis = abs(pos["entry_cost"])
            if basis <= 0:
                continue
            if pos["is_credit"]:
                if pnl >= basis * self.tp_credit:
                    self.close(pos, day, "TP")
                elif pnl < basis * self.sl_credit:
                    self.close(pos, day, "SL")
            else:
                if pnl >= basis * self.tp_debit:
                    self.close(pos, day, "TP")
                elif pnl < basis * self.sl_debit:
                    self.close(pos, day, "SL")

    def close(self, pos, day, reason):
        pos["closing"] = True
        pos["close_date"] = day
        pos["close_reason"] = reason
        for sym, qty in pos["legs"]:
            self.pending.append((sym, -qty, f"{pos['id']}:close"))

    def enter_positions(self, day, recs, firing):
        if not firing:
            return
        active = [p for p in self.positions if p["open"] and not p["closing"]]
        blocked = {p["strategy"] for p in active}
        if self.variant == "spec":
            blocked |= {p["strategy"] for p in self.positions
                        if p["entry_date"] == day or p.get("close_date") == day}
        actionable = [k for k in firing if k not in blocked]
        if not actionable:
            return

        pv = float(self.portfolio.total_portfolio_value)
        max_c = max(8, min(int(pv / 12500), MAX_CONTRACTS))
        if self.variant == "spec":
            committed = self.committed()
            avail = max(pv * 0.85 - committed, 0)
            free_margin = max(pv - committed, 0)
        else:
            avail = pv * 0.95
            free_margin = float("inf")
        alloc = min(avail / max(len(actionable), 1), pv * MAX_ALLOC)
        if alloc <= 0:
            return

        used = {sym for p in active for sym, _ in p["legs"]}
        active_lc = {p["strategy"] for p in active if p["trade_type"] in LONG_CALL_TYPES}

        for name in sorted(actionable, key=lambda k: firing[k]["strength"], reverse=True):
            sig = firing[name]
            tt = sig["trade_type"]
            if tt in LONG_CALL_TYPES and len(active_lc) >= MAX_LONG_CALLS:
                continue
            sel = select_contract(recs, tt, used)
            if sel is None:
                continue

            if sel["type"] == "single":
                c, qs = sel["contract"], sel["qty_sign"]
                n = compute_contracts(alloc, c["mid"], c["strike"], qs, pv)
                if qs < 0 and self.variant == "spec":
                    if n * c["strike"] * 100 * 0.15 > free_margin * 0.80:
                        n = max(1, int(free_margin * 0.60 / (c["strike"] * 100 * 0.15)))
                legs = [(c["symbol"], n * qs)]
                entry_price = c["mid"]
                is_credit = qs < 0
                strike, expiry, width = c["strike"], c["expiry"], 0.0
                free_margin -= c["strike"] * 100 * 0.15 * n if qs < 0 else c["mid"] * 100 * n
            else:
                if self.variant == "website":
                    continue  # website logged spreads but never placed them
                lng, sht = sel["long"], sel["short"]
                n = min(compute_contracts(alloc, lng["mid"], lng["strike"], 1, pv),
                        compute_contracts(alloc, sht["mid"], sht["strike"], -1, pv))
                width = abs(lng["strike"] - sht["strike"])
                if width * 100 * n > free_margin * 0.70:
                    n = min(max(1, int(free_margin * 0.50 / (width * 100))), max_c)
                is_credit = tt == "sell_put_spread"
                primary, secondary = (sht, lng) if is_credit else (lng, sht)
                pq = -n if is_credit else n
                legs = [(primary["symbol"], pq), (secondary["symbol"], -pq)]
                entry_price = (sht["mid"] - lng["mid"]) if is_credit else (lng["mid"] - sht["mid"])
                strike, expiry = primary["strike"], primary["expiry"]
                free_margin -= width * 100 * n if is_credit else entry_price * 100 * n

            pos = {
                "id": self.next_id, "strategy": name, "trade_type": tt, "legs": legs,
                "strike": strike, "expiry": expiry, "width": width, "is_credit": is_credit,
                "entry_date": day, "entry_price": entry_price,
                "entry_cost": entry_price * 100 * abs(legs[0][1]),
                "open": True, "closing": False, "close_date": None, "close_reason": None,
                "cash_open": 0.0, "cash_close": 0.0, "open_filled": False,
                "open_fills": 0, "close_fills": 0,
            }
            self.next_id += 1
            self.positions.append(pos)
            for sym, qty in legs:
                self.pending.append((sym, qty, f"{pos['id']}:open"))
                used.add(sym)
            if tt in LONG_CALL_TYPES:
                active_lc.add(name)

    def open_position(self, day, name, tt, legs, entry_price, is_credit, strike, expiry, width):
        pos = {
            "id": self.next_id, "strategy": name, "trade_type": tt, "legs": legs,
            "strike": strike, "expiry": expiry, "width": width, "is_credit": is_credit,
            "entry_date": day, "entry_price": entry_price,
            "entry_cost": entry_price * 100 * abs(legs[0][1]),
            "open": True, "closing": False, "close_date": None, "close_reason": None,
            "cash_open": 0.0, "cash_close": 0.0, "open_filled": False,
            "open_fills": 0, "close_fills": 0,
        }
        self.next_id += 1
        self.positions.append(pos)
        for sym, qty in legs:
            self.pending.append((sym, qty, f"{pos['id']}:open"))
        return pos

    def enter_positions_v2(self, day, recs, firing):
        """QC v2 entries: strength-scaled allocation, position caps, Gallacher
        filter on credit trades."""
        if not firing:
            return
        active = [p for p in self.positions if p["open"] and not p["closing"]]
        blocked = {p["strategy"] for p in active} if self.one_per_signal else set()
        actionable = [k for k in firing if k not in blocked]
        pv = float(self.portfolio.total_portfolio_value)
        used = {sym for p in active for sym, _ in p["legs"]}

        for name in sorted(actionable, key=lambda k: firing[k]["strength"], reverse=True):
            sig = firing[name]
            tt = sig["trade_type"]
            if len(active) >= V2_MAX_POSITIONS:
                break
            if sum(1 for p in active if p["strategy"] == name) >= V2_MAX_PER_SIGNAL_TYPE:
                continue
            if tt in LONG_CALL_TYPES and \
                    sum(1 for p in active if p["trade_type"] in LONG_CALL_TYPES) >= MAX_LONG_CALLS:
                continue
            sel = select_contract_v2(recs, tt, used)
            if sel is None:
                continue

            budget = pv * (V2_BASE_ALLOC + (V2_MAX_ALLOC - V2_BASE_ALLOC) * sig["strength"])
            if sel["type"] == "single":
                c, qs = sel["contract"], sel["qty_sign"]
                net = c["mid"] * qs * 100
                n = int(budget / net) if net > 0 else int(budget / (abs(net) * 2))
                legs_src = [(c, qs)]
                entry_price, is_credit = c["mid"], qs < 0
                strike, expiry, width = c["strike"], c["expiry"], 0.0
            else:
                # RECONSTRUCTED: the website port only logged spreads. Sized like
                # singles: debit = net debit, credit = 2x net credit as margin.
                lng, sht = sel["long"], sel["short"]
                is_credit = tt == "sell_put_spread"
                net = (sht["mid"] - lng["mid"]) if is_credit else (lng["mid"] - sht["mid"])
                if net <= 0:
                    continue
                n = int(budget / (net * 100 * (2 if is_credit else 1)))
                primary, secondary = (sht, lng) if is_credit else (lng, sht)
                ps = -1 if is_credit else 1
                legs_src = [(primary, ps), (secondary, -ps)]
                entry_price = net
                strike, expiry = primary["strike"], primary["expiry"]
                width = abs(lng["strike"] - sht["strike"])
            n = max(1, min(n, V2_MAX_CONTRACTS))

            if tt in CREDIT_TYPES:
                if self.regime == "EXTREME":
                    continue
                if self.regime == "STRESSED":
                    n = max(1, int(n * STRESSED_SIZE_MULT))

            legs = [(r["symbol"], n * sign) for r, sign in legs_src]
            pos = self.open_position(day, name, tt, legs, entry_price, is_credit, strike, expiry, width)
            active.append(pos)
            used.update(sym for sym, _ in legs)

    # ── execution + fills ──────────────────────────────────────────

    def send_pending_orders(self):
        orders, self.pending = self.pending, []
        for sym, qty, tag in orders:
            if qty == 0:
                continue
            if not self.securities.contains_key(sym):
                self.debug(f"missing security {sym} for {tag}")
                continue
            self.market_order(sym, qty, tag=tag)

    def on_order_event(self, order_event: OrderEvent):
        if order_event.status not in (OrderStatus.FILLED, OrderStatus.PARTIALLY_FILLED):
            return
        tag = self.transactions.get_order_by_id(order_event.order_id).tag or ""
        if ":" not in tag:
            return
        pid, phase = tag.split(":", 1)
        pos = next((p for p in self.positions if str(p["id"]) == pid), None)
        if pos is None:
            return
        cash = -float(order_event.fill_quantity) * float(order_event.fill_price) * 100
        if phase == "open":
            pos["cash_open"] += cash
            if order_event.status == OrderStatus.FILLED:
                pos["open_fills"] += 1
                if pos["open_fills"] == len(pos["legs"]):
                    pos["open_filled"] = True
                    # Spec: entry_cost corrected to actual fill (OnOrderEvent)
                    pos["entry_cost"] = abs(pos["cash_open"])
        else:
            pos["cash_close"] += cash
            if order_event.status == OrderStatus.FILLED:
                pos["close_fills"] += 1
                if pos["close_fills"] == len(pos["legs"]):
                    pos["open"] = False

    # ── report ─────────────────────────────────────────────────────

    def on_end_of_algorithm(self):
        rows = ["id,strategy,trade_type,legs,entry_date,close_date,close_reason,"
                "entry_cost,is_credit,realized_pnl,status"]
        by_strat = {}
        for p in self.positions:
            closed = not p["open"]
            pnl = p["cash_open"] + p["cash_close"] if closed else None
            legs = " ".join(f"{qty:+d}x{sym.value.replace(' ', '')}" for sym, qty in p["legs"])
            rows.append(f"{p['id']},{p['strategy']},{p['trade_type']},{legs},{p['entry_date']},"
                        f"{p['close_date'] or ''},{p['close_reason'] or ''},{p['entry_cost']:.2f},"
                        f"{int(p['is_credit'])},{'' if pnl is None else f'{pnl:.2f}'},"
                        f"{'closed' if closed else 'open'}")
            if closed:
                s = by_strat.setdefault(p["strategy"], [0, 0, 0.0])
                s[0] += 1
                s[1] += 1 if pnl > 0 else 0
                s[2] += pnl
        self.object_store.save(f"entropy_t13_{self.variant}_trades.csv", "\n".join(rows))

        mrows = ["date,spot,n_records," + ",".join(METRIC_COLUMNS)]
        for day, spot, n, m in self.metric_rows:
            vals = ["" if m.get(k) is None else f"{m[k]:.6f}" for k in METRIC_COLUMNS]
            mrows.append(f"{day},{spot:.2f},{n}," + ",".join(vals))
        self.object_store.save(f"entropy_t13_{self.variant}_metrics.csv", "\n".join(mrows))

        pv = float(self.portfolio.total_portfolio_value)
        self.log(f"=== Entropy T13 [{self.variant}] {self.start_date.date()} → {self.end_date.date()} ===")
        self.log(f"Final equity {pv:,.2f} ({(pv / INITIAL_CASH - 1) * 100:+.2f}%)")
        total_n = sum(v[0] for v in by_strat.values())
        total_w = sum(v[1] for v in by_strat.values())
        total_p = sum(v[2] for v in by_strat.values())
        for name, (n, w, pnl) in sorted(by_strat.items()):
            self.log(f"{name:16s} trades={n:3d} wins={w:3d} pnl={pnl:+,.2f}")
        if total_n:
            self.log(f"{'TOTAL':16s} trades={total_n:3d} win%={100 * total_w / total_n:.0f} "
                     f"pnl={total_p:+,.2f}")
        if self.variant == "v2":
            self.log("Regime days: " + ", ".join(f"{k}={v}" for k, v in sorted(self.regime_days.items())))
        self.log("Signals fired (days): " + ", ".join(f"{k}={v}" for k, v in sorted(self.signal_counts.items())))
        self.log(f"Open positions at end: {sum(1 for p in self.positions if p['open'])}")
        self.set_runtime_statistic("Variant", self.variant)
