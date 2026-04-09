#!/usr/bin/env python3
"""
Greek Entropy Diagnostic — breaks down comp_greek into its 5 components
and shows the underlying distributions that drive each one.

Usage:
  TRADIER_API_KEY=your_key python3 scripts/diagnose_greek_entropy.py

Requires: requests, numpy, scipy
"""

import os
import sys
import json
import requests
import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm as sp_norm
from datetime import datetime, date

RISK_FREE = 0.05
MIN_DTE = 14
MAX_DTE = 45

def tradier_get(endpoint, params):
    token = os.environ.get("TRADIER_API_KEY", "")
    if not token:
        print("ERROR: Set TRADIER_API_KEY environment variable")
        sys.exit(1)
    r = requests.get(
        f"https://api.tradier.com/v1{endpoint}",
        params=params,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    r.raise_for_status()
    return r.json()

def bsm_price(S, K, T, r, sig, is_call):
    if T <= 0 or sig <= 0:
        return 0.0
    d1 = (np.log(S/K) + (r + 0.5*sig**2)*T) / (sig*np.sqrt(T))
    d2 = d1 - sig*np.sqrt(T)
    if is_call:
        return float(S*sp_norm.cdf(d1) - K*np.exp(-r*T)*sp_norm.cdf(d2))
    return float(K*np.exp(-r*T)*sp_norm.cdf(-d2) - S*sp_norm.cdf(-d1))

def bsm_iv(price, S, K, T, r, is_call):
    if T <= 1e-6 or price <= 0:
        return None
    try:
        return brentq(lambda s: bsm_price(S, K, T, r, s, is_call) - price,
                      0.01, 5.0, xtol=1e-6, maxiter=100)
    except:
        return None

def bsm_greeks(S, K, T, r, sig, is_call):
    if T <= 0 or sig <= 0:
        return {"gamma": 0, "vega": 0, "charm": 0}
    sqT = np.sqrt(T)
    d1 = (np.log(S/K) + (r + 0.5*sig**2)*T) / (sig*sqT)
    d2 = d1 - sig*sqT
    nd1 = sp_norm.pdf(d1)
    gamma = float(nd1 / (S * sig * sqT))
    vega = float(S * nd1 * sqT / 100)
    charm = float(-nd1 * (2*r*T - d2*sig*sqT) / (2*T*sig*sqT))
    return {"gamma": gamma, "vega": vega, "charm": charm}

def h_norm(dist):
    d = np.asarray(dist, dtype=float)
    d = d[d > 0]
    if len(d) <= 1:
        return 0.0
    d = d / d.sum()
    h = float(-np.sum(d * np.log2(d)))
    return h / np.log2(len(d))

def main():
    print("=" * 70)
    print("GREEK ENTROPY DIAGNOSTIC")
    print("=" * 70)

    # 1. Get spot
    q = tradier_get("/markets/quotes", {"symbols": "SPY"})
    spot = float(q["quotes"]["quote"]["last"])
    print(f"\nSPY spot: ${spot:.2f}")

    # 2. Get expirations
    exp_data = tradier_get("/markets/options/expirations",
                           {"symbol": "SPY", "includeAllRoots": "true"})
    all_exps = exp_data.get("expirations", {}).get("date", [])
    if isinstance(all_exps, str):
        all_exps = [all_exps]

    today = date.today()
    valid_exps = []
    for e in all_exps:
        dte = (datetime.strptime(e, "%Y-%m-%d").date() - today).days
        if MIN_DTE <= dte <= MAX_DTE:
            valid_exps.append((e, dte))

    print(f"Expirations in {MIN_DTE}-{MAX_DTE} DTE: {len(valid_exps)}")
    for e, dte in valid_exps:
        print(f"  {e} ({dte} DTE)")

    # 3. Fetch chains and enrich
    recs = []
    for exp, dte in valid_exps:
        chain = tradier_get("/markets/options/chains",
                           {"symbol": "SPY", "expiration": exp, "greeks": "false"})
        options = chain.get("options", {}).get("option", [])
        if isinstance(options, dict):
            options = [options]

        for o in options:
            bid = float(o.get("bid", 0) or 0)
            ask = float(o.get("ask", 0) or 0)
            if bid <= 0 or ask <= 0 or ask < bid:
                continue
            mid = (bid + ask) / 2
            K = float(o.get("strike", 0))
            vol = int(o.get("volume", 0) or 0)
            is_call = o.get("option_type") == "call"
            T = dte / 365.0

            iv = bsm_iv(mid, spot, K, T, RISK_FREE, is_call)
            if iv is None:
                continue

            gr = bsm_greeks(spot, K, T, RISK_FREE, iv, is_call)
            spread_norm = (ask - bid) / mid if mid > 0 else 999

            recs.append({
                "strike": K, "expiry": exp, "dte": dte,
                "is_call": is_call, "mid": mid, "volume": vol,
                "iv": iv, "spread": spread_norm,
                "gamma": gr["gamma"], "vega": gr["vega"], "charm": gr["charm"],
                "moneyness": K / spot,
            })

    print(f"\nEnriched contracts: {len(recs)}")
    total_vol = sum(r["volume"] for r in recs)
    print(f"Total volume in 14-45 DTE window: {total_vol:,}")

    # 4. Compute each greek entropy dimension with detail
    print("\n" + "=" * 70)
    print("DIMENSION BREAKDOWN")
    print("=" * 70)

    # ── H_vegavol: |vega| × volume by strike ──
    vv = {}
    for r in recs:
        vv[r["strike"]] = vv.get(r["strike"], 0) + abs(r["vega"]) * r["volume"]
    vv_vals = sorted(vv.items(), key=lambda x: x[1], reverse=True)
    H_vv = h_norm([v for _, v in vv_vals])
    print(f"\n{'─'*50}")
    print(f"H_vegavol = {H_vv:.4f}")
    print(f"  Strikes with vega×vol: {sum(1 for _, v in vv_vals if v > 0)}/{len(vv_vals)}")
    print(f"  Top 5 strikes (concentration):")
    top5_vv = sum(v for _, v in vv_vals[:5])
    total_vv = sum(v for _, v in vv_vals)
    for strike, val in vv_vals[:5]:
        print(f"    K={strike:>8.1f}  vega×vol={val:>12.2f}  ({val/total_vv*100:.1f}%)")
    print(f"  Top 5 = {top5_vv/total_vv*100:.1f}% of total")

    # ── H_dgamma: |gamma| × volume × spot × 100 by strike ──
    dg = {}
    for r in recs:
        dg[r["strike"]] = dg.get(r["strike"], 0) + abs(r["gamma"]) * r["volume"] * spot * 100
    dg_vals = sorted(dg.items(), key=lambda x: x[1], reverse=True)
    H_dg = h_norm([v for _, v in dg_vals])
    print(f"\n{'─'*50}")
    print(f"H_dgamma = {H_dg:.4f}")
    print(f"  Strikes with dgamma: {sum(1 for _, v in dg_vals if v > 0)}/{len(dg_vals)}")
    print(f"  Top 5 strikes:")
    top5_dg = sum(v for _, v in dg_vals[:5])
    total_dg = sum(v for _, v in dg_vals)
    if total_dg > 0:
        for strike, val in dg_vals[:5]:
            print(f"    K={strike:>8.1f}  $gamma={val:>14.2f}  ({val/total_dg*100:.1f}%)")
        print(f"  Top 5 = {top5_dg/total_dg*100:.1f}% of total")

    # ── H_gvx: |gamma| × volume by strike ──
    gv = {}
    for r in recs:
        gv[r["strike"]] = gv.get(r["strike"], 0) + abs(r["gamma"]) * r["volume"]
    gv_vals = sorted(gv.items(), key=lambda x: x[1], reverse=True)
    H_gv = h_norm([v for _, v in gv_vals])
    print(f"\n{'─'*50}")
    print(f"H_gvx = {H_gv:.4f}")
    top5_gv = sum(v for _, v in gv_vals[:5])
    total_gv = sum(v for _, v in gv_vals)
    if total_gv > 0:
        print(f"  Top 5 = {top5_gv/total_gv*100:.1f}% of total")
        for strike, val in gv_vals[:5]:
            print(f"    K={strike:>8.1f}  gamma×vol={val:>12.6f}  ({val/total_gv*100:.1f}%)")

    # ── H_spread_k: volume/spread by strike ──
    sl = {}
    for r in recs:
        if r["spread"] > 0 and r["volume"] > 0:
            sl[r["strike"]] = sl.get(r["strike"], 0) + r["volume"] / r["spread"]
    sl_vals = sorted(sl.items(), key=lambda x: x[1], reverse=True)
    H_sk = h_norm([v for _, v in sl_vals]) if sl_vals else 0.5
    print(f"\n{'─'*50}")
    print(f"H_spread_k = {H_sk:.4f}")
    print(f"  Strikes with liquidity: {len(sl_vals)}")
    top5_sl = sum(v for _, v in sl_vals[:5])
    total_sl = sum(v for _, v in sl_vals)
    if total_sl > 0:
        print(f"  Top 5 = {top5_sl/total_sl*100:.1f}% of total")
        for strike, val in sl_vals[:5]:
            print(f"    K={strike:>8.1f}  vol/spread={val:>12.1f}  ({val/total_sl*100:.1f}%)")

    # ── H_charm: |charm| by DTE bucket ──
    cb = list(range(MIN_DTE, MAX_DTE + 2, 5))
    charm_buckets = np.zeros(len(cb) - 1)
    for r in recs:
        for b in range(len(cb) - 1):
            if cb[b] <= r["dte"] < cb[b + 1]:
                charm_buckets[b] += abs(r["charm"])
                break
    H_ch = h_norm(charm_buckets)
    print(f"\n{'─'*50}")
    print(f"H_charm = {H_ch:.4f}")
    print(f"  DTE bucket distribution:")
    total_charm = charm_buckets.sum()
    for b in range(len(cb) - 1):
        pct = charm_buckets[b] / total_charm * 100 if total_charm > 0 else 0
        bar = "█" * int(pct / 2)
        print(f"    {cb[b]:>2}-{cb[b+1]:>2} DTE: {charm_buckets[b]:>10.4f}  ({pct:>5.1f}%) {bar}")

    # 5. Final composite
    comp_greek = np.mean([H_vv, H_dg, H_gv, H_sk, H_ch])

    print(f"\n{'=' * 70}")
    print(f"COMP_GREEK = {comp_greek:.4f}")
    print(f"{'=' * 70}")
    print(f"  H_vegavol   = {H_vv:.4f}")
    print(f"  H_dgamma    = {H_dg:.4f}")
    print(f"  H_gvx       = {H_gv:.4f}")
    print(f"  H_spread_k  = {H_sk:.4f}")
    print(f"  H_charm     = {H_ch:.4f}")
    print(f"\n  Highest (most dispersed): {max([('H_vegavol', H_vv), ('H_dgamma', H_dg), ('H_gvx', H_gv), ('H_spread_k', H_sk), ('H_charm', H_ch)], key=lambda x: x[1])}")
    print(f"  Lowest (most concentrated): {min([('H_vegavol', H_vv), ('H_dgamma', H_dg), ('H_gvx', H_gv), ('H_spread_k', H_sk), ('H_charm', H_ch)], key=lambda x: x[1])}")

    # 6. Context: what would it take to drop comp_greek below 0.60?
    dims = [H_vv, H_dg, H_gv, H_sk, H_ch]
    current_mean = np.mean(dims)
    target = 0.60
    deficit = (current_mean - target) * 5  # how much total needs to drop
    print(f"\n  To reach comp_greek = {target}:")
    print(f"    Current sum of dims: {sum(dims):.4f}")
    print(f"    Need sum to be: {target * 5:.4f}")
    print(f"    Deficit: {deficit:.4f} across 5 dimensions")
    print(f"    If 1 dim dropped to 0.20, comp_greek would be: {(sum(dims) - max(dims) + 0.20) / 5:.4f}")
    print(f"    If 2 dims dropped to 0.30, comp_greek would be: {(sum(dims) - sum(sorted(dims, reverse=True)[:2]) + 0.60) / 5:.4f}")

    # 7. PCR diagnostic
    print(f"\n{'=' * 70}")
    print(f"PCR DIAGNOSTIC")
    print(f"{'=' * 70}")
    call_vol = sum(r["volume"] for r in recs if r["is_call"])
    put_vol = sum(r["volume"] for r in recs if not r["is_call"])
    pcr_vol = put_vol / call_vol if call_vol > 0 else 999
    print(f"  Call volume (14-45 DTE): {call_vol:>12,}")
    print(f"  Put volume  (14-45 DTE): {put_vol:>12,}")
    print(f"  PCR vol: {pcr_vol:.3f}")
    print(f"\n  Volume by expiration:")
    for exp, dte in valid_exps:
        cv = sum(r["volume"] for r in recs if r["is_call"] and r["expiry"] == exp)
        pv = sum(r["volume"] for r in recs if not r["is_call"] and r["expiry"] == exp)
        pcr = pv / cv if cv > 0 else 999
        print(f"    {exp} ({dte:>2d} DTE): calls={cv:>8,}  puts={pv:>8,}  PCR={pcr:.2f}")

if __name__ == "__main__":
    main()
