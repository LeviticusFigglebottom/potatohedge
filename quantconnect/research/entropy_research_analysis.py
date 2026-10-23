# region imports
from AlgorithmImports import *
# endregion
"""
Entropy research analysis — runs inside QuantConnect on the Object Store
output of entropy_feature_extractor.py (no option data is loaded, so it is fast).

Answers three questions, printed as compact tables in the log and saved to
entropy_research/<section>.csv:

  1. drift      How the option market's structure changed by year (volume mix by
                DTE, entropy levels) — e.g. the post-2022 0DTE shift.
  2. baseline   What each T13 trade structure earns when entered EVERY day,
                repriced off the stored IV surface with T13 exits — the return
                you get with no signal at all (beta / vol-risk-premium).
  3. signals    Each T13 signal's trades vs that baseline, by period: timing edge.
  4. screen     Every feature x transform, point-in-time quintiles: Q1-Q5 spread
                of forward SPY return, realised vol, IV change and of each trade
                structure's return, by period.

Parameter `section` = all | drift | baseline | signals | screen.
"""

import io
import math
from collections import defaultdict
from datetime import date, timedelta

import numpy as np
from scipy.special import ndtr

R = 0.05
GRID = np.round(np.arange(0.85, 1.1001, 0.01), 2)
PERIODS = [("2010-14", 2010, 2014), ("2015-18", 2015, 2018), ("2019-21", 2019, 2021),
           ("2022-23", 2022, 2023), ("2024-26", 2024, 2026)]
STRUCTURES = {
    # name: (legs [(moneyness, is_call, qty_sign)], is_credit)
    "long_call": ([(1.00, True, 1)], False),
    "short_put": ([(0.97, False, -1)], True),
    "put_spread": ([(0.98, False, -1), (0.95, False, 1)], True),
    "call_spread": ([(1.00, True, 1), (1.03, True, -1)], False),
}
EXITS = {"t13": dict(tp_d=1.0, sl_d=-1.0, tp_c=0.5, sl_c=-2.0),
         "v2": dict(tp_d=0.8, sl_d=-0.6, tp_c=0.5, sl_c=-1.5)}
CLOSE_DTE = 5


def period_of(y):
    for name, a, b in PERIODS:
        if a <= y <= b:
            return name
    return None


def bs(S, K, T, sig, call):
    if T <= 0:
        return max(S - K, 0.0) if call else max(K - S, 0.0)
    sq = math.sqrt(T)
    d1 = (math.log(S / K) + (R + 0.5 * sig * sig) * T) / (sig * sq)
    d2 = d1 - sig * sq
    if call:
        return S * ndtr(d1) - K * math.exp(-R * T) * ndtr(d2)
    return K * math.exp(-R * T) * ndtr(-d2) - S * ndtr(-d1)


def fnum(x):
    try:
        v = float(x)
        return v if not math.isnan(v) else None
    except (TypeError, ValueError):
        return None


class EntropyResearch(QCAlgorithm):

    def initialize(self):
        self.set_start_date(2026, 10, 20)
        self.set_end_date(2026, 10, 21)
        self.set_cash(100_000)
        self.section = (self.get_parameter("section") or "all").lower()
        self.add_equity("SPY", Resolution.DAILY)
        self.out = {}
        self._ord = {}

    # ── loading ──────────────────────────────────────────────────────

    def load(self):
        rows, surf = [], defaultdict(dict)
        for y in range(2010, 2027):
            key = f"entropy_features/{y}.csv"
            if self.object_store.contains_key(key):
                text = self.object_store.read(key)
                lines = text.strip().split("\n")
                cols = lines[0].split(",")
                for ln in lines[1:]:
                    vals = ln.split(",")
                    rows.append({c: (v if c == "date" else fnum(v)) for c, v in zip(cols, vals)})
            key = f"entropy_surface/{y}.csv"
            if self.object_store.contains_key(key):
                lines = self.object_store.read(key).strip().split("\n")
                cols = lines[0].split(",")
                gi = [cols.index(f"iv_{g:.2f}") for g in GRID]
                ri = cols.index("rel_spread_atm")
                for ln in lines[1:]:
                    v = ln.split(",")
                    ivs = np.array([fnum(v[i]) if fnum(v[i]) is not None else np.nan for i in gi])
                    surf[v[0]][v[1]] = (int(v[2]), ivs, fnum(v[ri]))
        rows.sort(key=lambda r: r["date"])
        self.rows = rows
        self.surf = surf
        self.dates = [r["date"] for r in rows]
        self.didx = {d: i for i, d in enumerate(self.dates)}
        self.spot = np.array([r["spot"] for r in rows], dtype=float)
        self.log(f"loaded {len(rows)} days ({self.dates[0]}..{self.dates[-1]}), "
                 f"surface days {len(surf)}")

    # ── pricing off the stored surface ───────────────────────────────

    def ordinal(self, d):
        o = self._ord.get(d)
        if o is None:
            o = self._ord[d] = date.fromisoformat(d).toordinal()
        return o

    def iv_at(self, d, expiry, m):
        s = self.surf.get(d, {}).get(expiry)
        if s is None:
            return None, None
        _, ivs, rs = s
        ok = ~np.isnan(ivs)
        if ok.sum() < 3:
            return None, rs
        g, v = GRID[ok], ivs[ok]
        return float(np.interp(min(max(m, g[0]), g[-1]), g, v)), rs

    def price(self, d, expiry, K, call, S):
        T = (self.ordinal(expiry) - self.ordinal(d)) / 365.0
        iv, rs = self.iv_at(d, expiry, K / S)
        if iv is None:
            return None, None
        return bs(S, K, T, iv, call), (rs if rs is not None else 0.05)

    def simulate(self, i, structure, exits):
        """Enter at day i's close (T13 selection), manage daily. Returns
        (return on basis, pnl$ per 1 lot, basis$) or None."""
        d0, S0 = self.dates[i], self.spot[i]
        exps = self.surf.get(d0, {})
        cands = [(abs(v[0] - 28), e) for e, v in exps.items() if 14 <= v[0] <= 45]
        if not cands:
            return None
        expiry = min(cands)[1]
        legs, is_credit = STRUCTURES[structure]
        lk = []
        entry = 0.0
        cost = 0.0
        for m, call, q in legs:
            K = float(round(S0 * m))
            p, rs = self.price(d0, expiry, K, call, S0)
            if p is None or p <= 0.05:
                return None
            lk.append((K, call, q))
            entry += q * p
            cost += abs(p) * rs / 2
        basis = abs(entry) * 100
        if basis <= 0 or (is_credit and entry >= 0) or (not is_credit and entry <= 0):
            return None
        e = EXITS[exits]
        exp_o = self.ordinal(expiry)
        for j in range(i + 1, len(self.dates)):
            dj, Sj = self.dates[j], self.spot[j]
            dte = exp_o - self.ordinal(dj)
            val = 0.0
            xcost = 0.0
            ok = True
            for K, call, q in lk:
                p, rs = self.price(dj, expiry, K, call, Sj)
                if p is None:
                    if dte <= 0:
                        p, rs = (max(Sj - K, 0) if call else max(K - Sj, 0)), 0.0
                    else:
                        ok = False
                        break
                val += q * p
                xcost += abs(p) * rs / 2
            if not ok:
                continue
            pnl = (val - entry) * 100 - (cost + xcost) * 100
            r = pnl / basis
            if dte <= CLOSE_DTE:
                return r, pnl, basis
            if is_credit:
                if r >= e["tp_c"] or r < e["sl_c"]:
                    return r, pnl, basis
            elif r >= e["tp_d"] or r < e["sl_d"]:
                return r, pnl, basis
        return None

    def trade_table(self):
        if hasattr(self, "_trades"):
            return self._trades
        t = {}
        for s in STRUCTURES:
            for ex in EXITS:
                arr = np.full(len(self.dates), np.nan)
                for i in range(len(self.dates) - 1):
                    res = self.simulate(i, s, ex)
                    if res is not None:
                        arr[i] = res[0]
                t[(s, ex)] = arr
        self._trades = t
        return t

    # ── helpers ──────────────────────────────────────────────────────

    def col(self, name):
        return np.array([r.get(name) if r.get(name) is not None else np.nan for r in self.rows],
                        dtype=float)

    def years(self):
        return np.array([int(d[:4]) for d in self.dates])

    def emit(self, section, header, rows, quiet=False):
        if quiet:
            return
        buf = io.StringIO()
        buf.write(",".join(header) + "\n")
        for r in rows:
            buf.write(",".join("" if v is None else (f"{v:.4g}" if isinstance(v, float) else str(v))
                               for v in r) + "\n")
        self.object_store.save(f"entropy_research/{section}.csv", buf.getvalue())
        self.log(f"=== {section} ===")
        self.log(" | ".join(header))
        for r in rows:
            self.log(" | ".join("" if v is None else (f"{v:.3g}" if isinstance(v, float) else str(v))
                                for v in r))

    # ── sections ─────────────────────────────────────────────────────

    def run_drift(self):
        yrs = self.years()
        keys = ["volshare_0_1", "volshare_2_7", "volshare_8_13", "volshare_14_30", "volshare_31_60",
                "t13_comp_volume", "t13_comp_greek", "t13_composite", "t13_iv_mean", "t13_pcr_vol",
                "t13_n", "a_composite", "s_composite", "gex"]
        cols = {k: self.col(k) for k in keys}
        rows = []
        for y in sorted(set(yrs)):
            sel = yrs == y
            rows.append([y] + [float(np.nanmean(cols[k][sel])) if np.isfinite(cols[k][sel]).any()
                               else None for k in keys])
        self.emit("drift", ["year"] + keys, rows)

    def run_baseline(self):
        t = self.trade_table()
        yrs = self.years()
        rows = []
        for (s, ex), arr in t.items():
            for y in sorted(set(yrs)):
                v = arr[(yrs == y) & np.isfinite(arr)]
                if len(v):
                    rows.append([s, ex, y, len(v), float(np.mean(v)), float(np.mean(v > 0))])
        self.emit("baseline", ["structure", "exits", "year", "n", "mean_ret", "win"], rows)

    def t13_signals(self):
        """Replicate T13's six signals point-in-time on t13_ features."""
        cv, cg, co = self.col("t13_comp_volume"), self.col("t13_comp_greek"), self.col("t13_composite")
        iv, ps, pcr = self.col("t13_iv_mean"), self.col("t13_put_skew"), self.col("t13_pcr_dollar")
        n = len(cv)
        sig = {k: np.zeros(n, bool) for k in
               ["S_LowVolEnt", "S_VolCollapse", "S_LowEntLowIV", "S_LowGreekEnt", "S_SkewFlow",
                "S_PCRContrarian"]}
        lvtype = np.array([""] * n, dtype=object)
        d1 = np.full(n, np.nan)
        d1[1:] = cv[1:] - cv[:-1]

        def med(a, i):
            w = a[max(0, i - 20):i + 1]
            w = w[np.isfinite(w)]
            return np.median(w) if len(w) >= 10 else np.nan

        def pctl(a, i, p):
            w = a[max(0, i - 59):i + 1]
            w = w[np.isfinite(w)]
            return np.percentile(w, p) if len(w) >= 10 else np.nan

        for i in range(30, n):
            cvm, cgm, com, ivm, psm = med(cv, i), med(cg, i), med(co, i), med(iv, i), med(ps, i)
            if cv[i] < cvm:
                sig["S_LowVolEnt"][i] = True
                lvtype[i] = "long_call" if iv[i] < ivm else "short_put"
            p20 = pctl(d1, i, 20)
            if np.isfinite(d1[i]) and d1[i] < p20:
                sig["S_VolCollapse"][i] = True
            if co[i] < com and iv[i] < ivm:
                sig["S_LowEntLowIV"][i] = True
            if cg[i] < cgm:
                sig["S_LowGreekEnt"][i] = True
            if cv[i] < cvm and ps[i] > psm:
                sig["S_SkewFlow"][i] = True
            p80 = pctl(pcr, i, 80)
            if np.isfinite(pcr[i]) and pcr[i] > p80:
                sig["S_PCRContrarian"][i] = True
        return sig, lvtype

    def run_signals(self):
        t = self.trade_table()
        sig, lvtype = self.t13_signals()
        struct = {"S_VolCollapse": "call_spread", "S_LowEntLowIV": "long_call",
                  "S_LowGreekEnt": "short_put", "S_SkewFlow": "put_spread",
                  "S_PCRContrarian": "short_put"}
        yrs = self.years()
        rows = []
        for name, fired in sig.items():
            for ex in EXITS:
                for pname, a, b in PERIODS + [("ALL", 2010, 2026)]:
                    per = (yrs >= a) & (yrs <= b)
                    if name == "S_LowVolEnt":
                        groups = [("long_call", fired & (lvtype == "long_call")),
                                  ("short_put", fired & (lvtype == "short_put"))]
                    else:
                        groups = [(struct[name], fired)]
                    for s, f in groups:
                        arr = t[(s, ex)]
                        on = arr[per & f & np.isfinite(arr)]
                        allv = arr[per & np.isfinite(arr)]
                        if len(on) < 5:
                            continue
                        rows.append([name, s, ex, pname, len(on), float(np.mean(on)),
                                     float(np.mean(allv)), float(np.mean(on) - np.mean(allv)),
                                     float(np.mean(on > 0))])
        self.emit("signals", ["signal", "structure", "exits", "period", "n_fired", "mean_fired",
                              "mean_all", "edge", "win_fired"], rows)

    def transforms(self, x):
        n = len(x)
        out = {"lvl": x}

        def roll(fn, w):
            r = np.full(n, np.nan)
            for i in range(n):
                seg = x[max(0, i - w + 1):i + 1]
                seg = seg[np.isfinite(seg)]
                if len(seg) >= max(10, w // 2) and np.isfinite(x[i]):
                    r[i] = fn(seg, x[i])
            return r

        out["z21"] = roll(lambda s, v: (v - s.mean()) / (s.std() + 1e-12), 21)
        out["z63"] = roll(lambda s, v: (v - s.mean()) / (s.std() + 1e-12), 63)
        out["pr252"] = roll(lambda s, v: float((s < v).mean()), 252)
        out["dt252"] = roll(lambda s, v: v - float(np.median(s)), 252)
        d1 = np.full(n, np.nan)
        d1[1:] = x[1:] - x[:-1]
        out["d1"] = d1
        d5 = np.full(n, np.nan)
        d5[5:] = x[5:] - x[:-5]
        out["d5"] = d5
        acc = np.full(n, np.nan)
        acc[2:] = d1[2:] - d1[1:-1]
        out["acc"] = acc
        return out

    def run_screen(self):
        t = self.trade_table()
        n = len(self.dates)
        S = self.spot
        yrs = self.years()
        fwd = {}
        for h in (5, 21):
            f = np.full(n, np.nan)
            f[:-h] = S[h:] / S[:-h] - 1
            fwd[f"ret{h}"] = f
        lr = np.full(n, np.nan)
        lr[1:] = np.log(S[1:] / S[:-1])
        rv = np.full(n, np.nan)
        for i in range(n - 21):
            rv[i] = np.std(lr[i + 1:i + 22]) * math.sqrt(252)
        fwd["rv21"] = rv
        iv30 = self.col("atm_iv_30")
        div = np.full(n, np.nan)
        div[:-5] = iv30[5:] - iv30[:-5]
        fwd["div5"] = div
        fwd["vrp21"] = iv30 - rv
        for s in STRUCTURES:
            fwd[f"tr_{s}"] = t[(s, "t13")]

        features = [k for k in self.rows[0].keys() if k not in ("date", "spot", "t13_n", "w_n",
                                                                  "s_n", "a_n")]
        rows = []
        for fname in features:
            x = self.col(fname)
            if np.isfinite(x).sum() < 500:
                continue
            for tname, z in self.transforms(x).items():
                # point-in-time quintile: rank within trailing 252 days
                q = np.full(n, np.nan)
                for i in range(252, n):
                    w = z[i - 252:i + 1]
                    w = w[np.isfinite(w)]
                    if len(w) >= 100 and np.isfinite(z[i]):
                        q[i] = min(int((w < z[i]).mean() * 5), 4)
                for pname, a, b in PERIODS + [("ALL", 2010, 2026)]:
                    per = (yrs >= a) & (yrs <= b) & np.isfinite(q)
                    row = [fname, tname, pname, int(per.sum())]
                    for tg, arr in fwd.items():
                        lo = arr[per & (q == 0) & np.isfinite(arr)]
                        hi = arr[per & (q == 4) & np.isfinite(arr)]
                        row.append(float(np.mean(lo) - np.mean(hi)) if len(lo) > 10 and len(hi) > 10
                                   else None)
                    rows.append(row)
        header = ["feature", "transform", "period", "n"] + [f"q1_minus_q5_{k}" for k in fwd]
        self.emit("screen", header, [], quiet=True)
        # Rank feature x transform per target by consistency across the five periods:
        # score = mean spread / (std across periods) and count of periods with the same sign.
        tnames = list(fwd)
        by = defaultdict(dict)
        for r in rows:
            by[(r[0], r[1])][r[2]] = r[4:]
        summary = []
        for (f, tr), per in by.items():
            for ti, tg in enumerate(tnames):
                vals = [per[p][ti] for p, _, _ in PERIODS if p in per and per[p][ti] is not None]
                if len(vals) < 4:
                    continue
                m, sd = float(np.mean(vals)), float(np.std(vals)) + 1e-12
                same = max(sum(v > 0 for v in vals), sum(v < 0 for v in vals))
                recent = per.get("2024-26", [None] * len(tnames))[ti]
                summary.append([tg, f, tr, m, m / sd, same, len(vals), recent])
        out = []
        for tg in tnames:
            cand = [x for x in summary if x[0] == tg]
            cand.sort(key=lambda x: (x[5] / x[6], abs(x[4])), reverse=True)
            out += cand[:12]
        self.emit("screen_top", ["target", "feature", "transform", "mean_q1_q5", "mean_over_sd",
                                 "same_sign_periods", "periods", "spread_2024_26"], out)
        self._screen_rows = rows

    def on_end_of_algorithm(self):
        self.load()
        sec = self.section
        if sec in ("all", "drift"):
            self.run_drift()
        if sec in ("all", "baseline"):
            self.run_baseline()
        if sec in ("all", "signals"):
            self.run_signals()
        if sec in ("all", "screen"):
            self.run_screen()
