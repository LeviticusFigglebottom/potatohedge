# region imports
from AlgorithmImports import *
# endregion
"""
Entropy-filtered put-selling (research candidate, from entropy_research_analysis).

Research findings it is built on (SPY, 2010-2026):
  - Selling ~3% OTM, ~28 DTE puts earned the volatility risk premium in every
    period, with or without signals.
  - The T13 entropy signals added no consistent timing edge over entering every
    day; T13's long-call profits were bull-market beta and its long calls drove
    the 2025-26 losses.
  - Short-dated (0-13 DTE) call-volume entropy across strikes, when low relative
    to its past year, marked better put-selling days: higher Sharpe and much
    smaller drawdowns than random days at the same frequency (robust to
    threshold/transform). The same measure on 14-45 DTE showed nothing — the
    informative flow migrated to short-dated options (0-1 DTE volume share
    6% in 2010 -> 81% in 2026).

Rules:
  every 5th trading day, if filter passes (or parameter use_filter=false):
    sell the put nearest 0.97 x spot at the expiry nearest 28 DTE (14-45)
    size: floor(RISK_PCT x equity / (0.15 x strike x 100)) contracts
  exits: +50% of credit (TP), loss > 2x credit (SL), or 5 DTE.
Parameters: use_filter (true/false), risk_pct (default 0.10), low_frac (default 0.5).
"""

import math
from collections import deque

import numpy as np
from scipy.special import ndtr

R = 0.05
STRIKES_EACH_SIDE = 40


def h_norm(dist):
    d = np.asarray(dist, dtype=float)
    d = d[d > 0]
    if len(d) <= 1:
        return 0.0
    d = d / d.sum()
    return float(-np.sum(d * np.log2(d)) / np.log2(len(d)))


class EntropyVrpCandidate(QCAlgorithm):

    def initialize(self):
        self.set_start_date(2011, 1, 1)
        self.set_end_date(2026, 10, 22)
        self.set_cash(100_000)
        self.use_filter = (self.get_parameter("use_filter") or "true").lower() == "true"
        self.risk_pct = float(self.get_parameter("risk_pct") or 0.10)
        self.low_frac = float(self.get_parameter("low_frac") or 0.5)

        eq = self.add_equity("SPY", Resolution.DAILY)
        eq.set_data_normalization_mode(DataNormalizationMode.RAW)
        self.spy = eq.symbol
        opt = self.add_option("SPY", Resolution.DAILY)
        opt.set_filter(lambda u: u.include_weeklys()
                       .strikes(-STRIKES_EACH_SIDE, STRIKES_EACH_SIDE)
                       .expiration(0, 45))
        self.opt = opt.symbol

        self.feature = deque(maxlen=253)
        self.day_count = 0
        self.last_day = None
        self.pending = []
        self.book = {}   # symbol -> dict(credit, qty, expiry)
        self.entries = 0
        self.filtered_out = 0
        self.schedule.on(self.date_rules.every_day(self.spy),
                         self.time_rules.after_market_open(self.spy, 1), self.send)

    def short_dated_callvol_entropy(self, chain, day, spot):
        strikes = sorted({float(c.strike) for c in chain})
        if not strikes:
            return None
        idx = int(np.searchsorted(strikes, spot))
        lo = strikes[max(idx - STRIKES_EACH_SIDE, 0)]
        hi = strikes[min(idx + STRIKES_EACH_SIDE - 1, len(strikes) - 1)]
        by_k = {}
        for c in chain:
            dte = (c.expiry.date() - day).days
            if c.right != OptionRight.CALL or not (0 <= dte <= 13):
                continue
            k = float(c.strike)
            if not (lo <= k <= hi) or not c.bid_price or c.bid_price <= 0:
                continue
            by_k[k] = by_k.get(k, 0.0) + float(c.volume or 0)
        v = np.array(list(by_k.values()))
        return h_norm(v) if v.sum() > 0 else None

    def on_data(self, data: Slice):
        chain = data.option_chains.get(self.opt)
        if chain is None or not data.bars.contains_key(self.spy):
            return
        bar = data.bars[self.spy]
        day = bar.time.date()
        if day == self.last_day:
            return
        self.last_day = day
        spot = float(bar.close)
        contracts = list(chain)

        f = self.short_dated_callvol_entropy(contracts, day, spot)
        if f is not None:
            self.feature.append(f)

        # manage
        for sym, pos in list(self.book.items()):
            if pos.get("closing"):
                continue
            sec = self.securities[sym]
            mid = (float(sec.bid_price) + float(sec.ask_price)) / 2
            dte = (pos["expiry"] - day).days
            pnl = pos["credit"] - mid * 100 * pos["qty"]
            if dte <= 5 or (mid > 0 and (pnl >= 0.5 * pos["credit"] or pnl < -2.0 * pos["credit"])):
                pos["closing"] = True
                self.pending.append((sym, pos["qty"]))

        self.day_count += 1
        if self.day_count % 5:
            return
        if self.use_filter:
            if f is None or len(self.feature) < 120:
                return
            # detrend vs trailing-252 median, then point-in-time percentile
            hist = np.array(self.feature)
            med = np.median(hist)
            dt = hist - med
            if (dt < dt[-1]).mean() > self.low_frac:
                self.filtered_out += 1
                return

        cands = [c for c in contracts if c.right == OptionRight.PUT
                 and 14 <= (c.expiry.date() - day).days <= 45 and c.bid_price and c.bid_price > 0.10]
        if not cands:
            return
        best_exp = min({c.expiry for c in cands}, key=lambda e: abs((e.date() - day).days - 28))
        same = [c for c in cands if c.expiry == best_exp]
        c = min(same, key=lambda x: abs(float(x.strike) / spot - 0.97))
        mid = (float(c.bid_price) + float(c.ask_price)) / 2
        if mid <= 0 or (float(c.ask_price) - float(c.bid_price)) >= 0.15 * mid:
            return
        qty = int(self.portfolio.total_portfolio_value * self.risk_pct / (0.15 * float(c.strike) * 100))
        if qty <= 0 or c.symbol in self.book:
            return
        self.book[c.symbol] = {"credit": mid * 100 * qty, "qty": qty, "expiry": c.expiry.date()}
        self.pending.append((c.symbol, -qty))
        self.entries += 1

    def send(self):
        orders, self.pending = self.pending, []
        for sym, q in orders:
            self.market_order(sym, q, tag="close" if q > 0 else "open")

    def on_order_event(self, e: OrderEvent):
        if e.status != OrderStatus.FILLED:
            return
        pos = self.book.get(e.symbol)
        if pos is None:
            return
        if e.fill_quantity < 0:
            pos["credit"] = -float(e.fill_quantity) * float(e.fill_price) * 100
        else:
            del self.book[e.symbol]

    def on_end_of_algorithm(self):
        self.log(f"filter={self.use_filter} risk_pct={self.risk_pct} low_frac={self.low_frac} "
                 f"entries={self.entries} filtered_out={self.filtered_out} "
                 f"final={self.portfolio.total_portfolio_value:,.0f}")
