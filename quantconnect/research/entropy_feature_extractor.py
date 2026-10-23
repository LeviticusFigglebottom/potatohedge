# region imports
from AlgorithmImports import *
# endregion
"""
Entropy feature extractor (research only — places no trades).

For every trading day it builds the SPY option chain (0-60 DTE, +/-40 strikes),
solves IVs (vectorised), and saves to the Object Store:

  entropy_features/<year>.csv  one row per day: T13 entropy components and
                               composites on four universes, open-interest
                               entropies, volume/OI mix by DTE bucket, ATM IV
                               term structure, 25-delta skew, dealer gamma.
  entropy_surface/<year>.csv   one row per (day, expiry 3-60 DTE): OTM implied
                               vol on a moneyness grid 0.85..1.10 plus median
                               relative spread, for offline repricing of trades.

Universes (prefixes):
  t13_  14-45 DTE, 20 strikes each side of spot (the original T13 universe)
  w_    14-45 DTE, 40 strikes each side
  s_    0-13 DTE, 40 strikes each side (short-dated flow)
  a_    0-60 DTE, 40 strikes each side
"""

import io
import math
from datetime import timedelta

import numpy as np
from scipy.special import ndtr

R = 0.05
STRIKES_EACH_SIDE = 40
T13_STRIKES = 20
GRID = np.round(np.arange(0.85, 1.1001, 0.01), 2)

UNIVERSES = {
    "t13": dict(dte=(14, 45), strikes=T13_STRIKES),
    "w": dict(dte=(14, 45), strikes=STRIKES_EACH_SIDE),
    "s": dict(dte=(0, 13), strikes=STRIKES_EACH_SIDE),
    "a": dict(dte=(0, 60), strikes=STRIKES_EACH_SIDE),
}
H_KEYS = ["H_vol_term_n", "H_vol_k_n", "H_prem_term_n", "H_vegavol_n", "H_dgamma_n",
          "H_gvx_n", "H_dflow_n", "H_spread_k_n", "H_moneyness_n", "H_charm_n"]
U_KEYS = H_KEYS + ["dgamma_conc5", "comp_volume", "comp_greek", "composite",
                   "pcr_vol", "pcr_dollar", "iv_mean", "put_skew",
                   "H_oi_k_n", "H_oi_term_n", "H_callvol_k_n", "H_putvol_k_n",
                   "vol_total", "oi_total", "n"]
G_KEYS = ["spot", "volshare_0_1", "volshare_2_7", "volshare_8_13", "volshare_14_30",
          "volshare_31_60", "oishare_0_7", "oishare_8_30", "oishare_31_60",
          "atm_iv_7", "atm_iv_14", "atm_iv_30", "atm_iv_45", "put25_iv_30", "call25_iv_30",
          "rr25_30", "term_slope", "gex", "gex_0_7", "vol_all", "oi_all"]


def h_norm(dist):
    d = np.asarray(dist, dtype=float)
    d = d[d > 0]
    if len(d) <= 1:
        return 0.0
    d = d / d.sum()
    return float(-np.sum(d * np.log2(d)) / np.log2(len(d)))


def bs_price(S, K, T, sig, call):
    sq = np.sqrt(T)
    d1 = (np.log(S / K) + (R + 0.5 * sig * sig) * T) / (sig * sq)
    d2 = d1 - sig * sq
    disc = np.exp(-R * T)
    c = S * ndtr(d1) - K * disc * ndtr(d2)
    p = K * disc * ndtr(-d2) - S * ndtr(-d1)
    return np.where(call, c, p)


def implied_vol(price, S, K, T, call):
    """Vectorised bisection on [0.01, 5]; NaN where unsolvable (spec's rules)."""
    disc = np.exp(-R * T)
    intr = np.where(call, np.maximum(S - K * disc, 0), np.maximum(K * disc - S, 0))
    lo = np.full(price.shape, 0.01)
    hi = np.full(price.shape, 5.0)
    ok = (price > 0) & (price >= intr * 0.90) & (T > 1e-6)
    ok &= (bs_price(S, K, T, lo, call) <= price) & (bs_price(S, K, T, hi, call) >= price)
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        above = bs_price(S, K, T, mid, call) > price
        hi = np.where(above, mid, hi)
        lo = np.where(above, lo, mid)
    iv = 0.5 * (lo + hi)
    return np.where(ok, iv, np.nan)


def group_sum(keys, vals):
    out = {}
    for k, v in zip(keys, vals):
        out[k] = out.get(k, 0.0) + v
    return np.array(list(out.values()), dtype=float) if out else np.array([])


def universe_metrics(r, spot):
    """T13 ComputeEntropy on record arrays r (dict of np arrays), plus extras."""
    m = {}
    n = len(r["K"])
    m["n"] = n
    if n < 10:
        return m
    vol, K, exp, mid, dte = r["vol"], r["K"], r["exp"], r["mid"], r["dte"]
    ve = group_sum(exp, vol)
    m["H_vol_term_n"] = h_norm(ve) if ve.sum() > 0 else None
    vk = group_sum(K, vol)
    m["H_vol_k_n"] = h_norm(vk) if vk.sum() > 0 else None
    pe = np.abs(group_sum(exp, mid * vol * 100))
    m["H_prem_term_n"] = h_norm(pe) if pe.sum() > 0 else None
    vv = np.abs(r["vega"]) * vol
    va = group_sum(K[vv > 0], vv[vv > 0])
    m["H_vegavol_n"] = h_norm(va) if len(va) > 3 and va.sum() > 0 else None
    dgv = np.abs(r["gamma"] * mid * vol * spot ** 2 * 0.01)
    da = group_sum(K[dgv > 0], dgv[dgv > 0])
    if len(da) > 3 and da.sum() > 0:
        m["H_dgamma_n"] = h_norm(da)
        m["dgamma_conc5"] = float(np.sort(da)[::-1][:5].sum() / da.sum())
    gvx = np.abs(r["gamma"] * vol * 100)
    ga = group_sum(K[gvx > 0], gvx[gvx > 0])
    m["H_gvx_n"] = h_norm(ga) if len(ga) > 3 and ga.sum() > 0 else None
    ad = np.abs(r["delta"])
    bv = np.array([vol[(ad >= b / 10) & (ad < (b + 1) / 10)].sum() for b in range(10)])
    m["H_dflow_n"] = h_norm(bv) if bv.sum() > 0 else None
    sp = r["ask"] - r["bid"]
    pos = sp > 0
    if pos.sum() > 0:
        ssum, scnt = {}, {}
        for k, s in zip(K[pos], sp[pos]):
            ssum[k] = ssum.get(k, 0.0) + s
            scnt[k] = scnt.get(k, 0) + 1
        sk = np.array([ssum[k] / scnt[k] for k in ssum])
        m["H_spread_k_n"] = h_norm(sk) if len(sk) > 3 else None
    mon = K / spot
    mb = [0, .90, .95, .97, .99, 1.01, 1.03, 1.05, 1.10, 2.0]
    mv = np.array([vol[(vol > 0) & (mon >= mb[b]) & (mon < mb[b + 1])].sum() for b in range(len(mb) - 1)])
    m["H_moneyness_n"] = h_norm(mv) if mv.sum() > 0 else None
    db = [0, 5, 10, 15, 20, 30, 45]
    cg = np.abs(r["gamma"] * vol / np.maximum(dte, 1))
    cv = np.array([cg[(dte > db[b]) & (dte <= db[b + 1]) & (np.abs(r["delta"]) > 0)].sum()
                   for b in range(len(db) - 1)])
    m["H_charm_n"] = h_norm(cv) if cv.sum() > 0 else None

    call = r["call"]
    cvol, pvol = vol[call].sum(), vol[~call].sum()
    m["pcr_vol"] = pvol / cvol if cvol > 0 else None
    cdv, pdv = (mid * vol)[call].sum(), (mid * vol)[~call].sum()
    m["pcr_dollar"] = pdv / cdv if cdv > 0 else None
    near = (dte >= 7) & (dte <= 45)
    if near.sum() > 5:
        m["iv_mean"] = float(np.mean(r["iv"][near]))
        atm = near & (mon >= 0.98) & (mon <= 1.02)
        otp = near & ~call & (mon < 0.97)
        if atm.any() and otp.any():
            m["put_skew"] = float(np.mean(r["iv"][otp]) - np.mean(r["iv"][atm]))
    vkeys = ["H_vol_term_n", "H_prem_term_n", "H_vol_k_n", "H_vegavol_n"]
    gkeys = ["H_gvx_n", "H_dflow_n", "H_vegavol_n", "H_dgamma_n", "H_charm_n"]
    cvv = [m[k] for k in vkeys if m.get(k) is not None]
    cgg = [m[k] for k in gkeys if m.get(k) is not None]
    alls = [m[k] for k in H_KEYS if m.get(k) is not None]
    m["comp_volume"] = float(np.mean(cvv)) if cvv else None
    m["comp_greek"] = float(np.mean(cgg)) if cgg else None
    m["composite"] = float(np.mean(alls)) if alls else None

    oi = r["oi"]
    ok = group_sum(K, oi)
    m["H_oi_k_n"] = h_norm(ok) if ok.sum() > 0 else None
    ot = group_sum(exp, oi)
    m["H_oi_term_n"] = h_norm(ot) if ot.sum() > 0 else None
    cvk = group_sum(K[call], vol[call])
    m["H_callvol_k_n"] = h_norm(cvk) if cvk.sum() > 0 else None
    pvk = group_sum(K[~call], vol[~call])
    m["H_putvol_k_n"] = h_norm(pvk) if pvk.sum() > 0 else None
    m["vol_total"] = float(vol.sum())
    m["oi_total"] = float(oi.sum())
    return m


def interp_iv_at(dtes, ivs, target):
    """Linear interpolation in total variance across expiries."""
    if len(dtes) == 0:
        return None
    order = np.argsort(dtes)
    d, v = np.asarray(dtes)[order], np.asarray(ivs)[order]
    if target <= d[0]:
        return float(v[0])
    if target >= d[-1]:
        return float(v[-1])
    w = np.interp(target, d, v * v * d)
    return float(math.sqrt(max(w / target, 0)))


class EntropyFeatureExtractor(QCAlgorithm):

    def initialize(self):
        self.set_start_date(2010, 1, 1)
        self.set_end_date(2026, 10, 22)
        self.set_cash(100_000)
        eq = self.add_equity("SPY", Resolution.DAILY)
        eq.set_data_normalization_mode(DataNormalizationMode.RAW)
        self.spy = eq.symbol
        opt = self.add_option("SPY", Resolution.DAILY)
        opt.set_filter(lambda u: u.include_weeklys()
                       .strikes(-STRIKES_EACH_SIDE, STRIKES_EACH_SIDE)
                       .expiration(0, 60))
        self.opt = opt.symbol
        self.rows, self.surface = [], []
        self.year = None
        self.last_day = None

    def flush(self, year):
        if year is None:
            return
        if self.rows:
            cols = ["date"] + [f"{u}_{k}" for u in UNIVERSES for k in U_KEYS] + G_KEYS
            buf = io.StringIO()
            buf.write(",".join(cols) + "\n")
            for row in self.rows:
                buf.write(",".join("" if row.get(c) is None else
                                   (f"{row[c]:.6g}" if isinstance(row[c], float) else str(row[c]))
                                   for c in cols) + "\n")
            self.object_store.save(f"entropy_features/{year}.csv", buf.getvalue())
        if self.surface:
            cols = ["date", "expiry", "dte"] + [f"iv_{g:.2f}" for g in GRID] + ["rel_spread_atm", "vol", "oi"]
            buf = io.StringIO()
            buf.write(",".join(cols) + "\n")
            for row in self.surface:
                buf.write(",".join("" if v is None or (isinstance(v, float) and math.isnan(v)) else
                                   (f"{v:.5g}" if isinstance(v, float) else str(v)) for v in row) + "\n")
            self.object_store.save(f"entropy_surface/{year}.csv", buf.getvalue())
        self.log(f"saved {year}: {len(self.rows)} days, {len(self.surface)} surface rows")
        self.rows, self.surface = [], []

    def on_data(self, data: Slice):
        chain = data.option_chains.get(self.opt)
        if chain is None or not data.bars.contains_key(self.spy):
            return
        bar = data.bars[self.spy]
        day = bar.time.date()
        if day == self.last_day:
            return
        self.last_day = day
        if self.year != day.year:
            self.flush(self.year)
            self.year = day.year
        spot = float(bar.close)

        cs = list(chain)
        if len(cs) < 20:
            return
        K = np.array([float(c.strike) for c in cs])
        exp = np.array([c.expiry.date() for c in cs])
        dte = np.array([(e - day).days for e in exp])
        call = np.array([c.right == OptionRight.CALL for c in cs])
        bid = np.array([float(c.bid_price or 0) for c in cs])
        ask = np.array([float(c.ask_price or 0) for c in cs])
        vol = np.array([float(c.volume or 0) for c in cs])
        oi = np.array([float(c.open_interest or 0) for c in cs])
        mid = (bid + ask) / 2

        T = np.maximum(dte, 0) / 365.0
        valid = (mid > 0) & (bid > 0) & (dte > 0)
        iv = np.full(len(cs), np.nan)
        iv[valid] = implied_vol(mid[valid], spot, K[valid], T[valid], call[valid])
        good = valid & ~np.isnan(iv)
        sig = np.where(good, iv, 0.2)
        Tg = np.where(T > 0, T, 1 / 365)
        sq = np.sqrt(Tg)
        d1 = (np.log(spot / K) + (R + 0.5 * sig * sig) * Tg) / (sig * sq)
        pdf = np.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
        gamma = pdf / (spot * sig * sq)
        delta = np.where(call, ndtr(d1), ndtr(d1) - 1)
        vega = spot * pdf * sq / 100

        uniq = np.unique(K)
        idx = np.searchsorted(uniq, spot)
        row = {"date": str(day), "spot": spot}
        for name, u in UNIVERSES.items():
            lo_k = uniq[max(idx - u["strikes"], 0)]
            hi_k = uniq[min(idx + u["strikes"] - 1, len(uniq) - 1)]
            sel = good & (dte >= u["dte"][0]) & (dte <= u["dte"][1]) & (K >= lo_k) & (K <= hi_k)
            r = {"K": K[sel], "exp": exp[sel], "dte": dte[sel], "call": call[sel], "bid": bid[sel],
                 "ask": ask[sel], "mid": mid[sel], "vol": vol[sel], "oi": oi[sel], "iv": iv[sel],
                 "delta": delta[sel], "gamma": gamma[sel], "vega": vega[sel]}
            for k, v in universe_metrics(r, spot).items():
                row[f"{name}_{k}"] = v

        tv, toi = vol.sum(), oi.sum()
        for lo, hi, key in [(0, 1, "volshare_0_1"), (2, 7, "volshare_2_7"), (8, 13, "volshare_8_13"),
                            (14, 30, "volshare_14_30"), (31, 60, "volshare_31_60")]:
            row[key] = float(vol[(dte >= lo) & (dte <= hi)].sum() / tv) if tv > 0 else None
        for lo, hi, key in [(0, 7, "oishare_0_7"), (8, 30, "oishare_8_30"), (31, 60, "oishare_31_60")]:
            row[key] = float(oi[(dte >= lo) & (dte <= hi)].sum() / toi) if toi > 0 else None
        row["vol_all"], row["oi_all"] = float(tv), float(toi)
        sgn = np.where(call, 1.0, -1.0)
        gexv = sgn * gamma * oi * 100 * spot * spot * 0.01
        row["gex"] = float(np.nansum(np.where(good, gexv, 0)))
        row["gex_0_7"] = float(np.nansum(np.where(good & (dte <= 7), gexv, 0)))

        # Per-expiry smile on the moneyness grid (OTM side), ATM and 25-delta IVs
        atm_d, atm_v, p25_d, p25_v, c25_d, c25_v = [], [], [], [], [], []
        for e in np.unique(exp[good]):
            sel = good & (exp == e)
            d = int(dte[sel][0])
            if d < 3:
                continue
            mon = K[sel] / spot
            otm = np.where(mon < 1.0, ~call[sel], call[sel])
            mm, vv = mon[otm], iv[sel][otm]
            if len(mm) < 4:
                continue
            o = np.argsort(mm)
            mm, vv = mm[o], vv[o]
            smile = [float(np.interp(g, mm, vv)) if mm[0] <= g <= mm[-1] else float("nan") for g in GRID]
            near = sel & (np.abs(K / spot - 1) <= 0.03)
            rs = float(np.median(((ask - bid) / mid)[near])) if near.any() else float("nan")
            self.surface.append([str(day), str(e), d] + smile +
                                [rs, float(vol[sel].sum()), float(oi[sel].sum())])
            atm = float(np.interp(1.0, mm, vv))
            atm_d.append(d)
            atm_v.append(atm)
            dl = delta[sel][otm][o]
            puts = dl < 0
            if puts.sum() >= 2 and dl[puts].min() <= -0.25 <= dl[puts].max():
                pd_ = dl[puts]
                p25_d.append(d)
                p25_v.append(float(np.interp(-0.25, pd_, vv[puts])))
            calls_ = dl > 0
            if calls_.sum() >= 2 and dl[calls_].min() <= 0.25 <= dl[calls_].max():
                cd_ = dl[calls_][::-1]
                c25_d.append(d)
                c25_v.append(float(np.interp(0.25, cd_, vv[calls_][::-1])))
        for t in (7, 14, 30, 45):
            row[f"atm_iv_{t}"] = interp_iv_at(atm_d, atm_v, t)
        row["put25_iv_30"] = interp_iv_at(p25_d, p25_v, 30)
        row["call25_iv_30"] = interp_iv_at(c25_d, c25_v, 30)
        if row["put25_iv_30"] is not None and row["call25_iv_30"] is not None:
            row["rr25_30"] = row["put25_iv_30"] - row["call25_iv_30"]
        if row["atm_iv_7"] is not None and row["atm_iv_45"] is not None:
            row["term_slope"] = row["atm_iv_45"] - row["atm_iv_7"]
        self.rows.append(row)

    def on_end_of_algorithm(self):
        self.flush(self.year)
