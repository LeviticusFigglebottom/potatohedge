# Flow Desk

A new top-level tab group in Optix (**Flow Desk**, next to Overview) that rebuilds the friend's options-flow dashboard panel by panel and adds the **ELMo-D** indicator as a chart you can put on any interval, with an optional higher-timeframe overlay.

- Open it: the **Flow Desk** tab, or deep-link `/?tab=flowdesk&panel=flow&demo=1`.
- It follows the dashboard's active ticker (the ticker search at the top).
- **Live / Demo** toggle (top right). Demo = deterministic synthetic data, with a banner on every view. Live uses your existing keys; anything they can't supply shows **"No data source configured"**. See [DATA_SOURCES.md](DATA_SOURCES.md).
- Read-only. Flow Desk never calls an order endpoint (it doesn't import `tradierPaper.ts` or the worker's Alpaca code).

Screenshots of every panel in demo mode are in [`docs/flow-desk/`](docs/flow-desk/).

## Panels

| # | Sub-tab | Panel | Notes |
|---|---|---|---|
| 1 | Flow | **Options Flow** | Per ticker, by minute: cumulative call flow, put flow and net flow ($), stock price on the left axis, volume bars. Toggles **Show Stock Price**, **RTH Only** (09:30–16:00 ET). |
| 2 | Flow | **Top Symbols by Premium Flow** | Symbol, Net, Call, Put premium, Total/Call/Put volume, Sentiment. Click any header to sort; click again to reverse. |
| 3 | Flow | **Premium Flow by Expiration (All Symbols)** | Expiration, Net, Call, Put, Total Volume, Call/Put Ratio (volume), Sentiment. |
| 4 | Flow | **Recent Flow (Last 30 Minutes)** | Same columns as 2, over a rolling window (15/30/60 min setting). |
| 5 | Heatmap | **Option Heatmap (Flow)** | Strike (y) × expiry (x). Green = buys/sells > 1, red < 1, grey = balanced; intensity = log ratio. Tooltip: Premium Flow Bullish/Bearish ($), calls $, puts $, call/put volume, buy n (%), sell n (%), unknown n. Dashed spot line. |
| 6 | Dealer Greeks | **Dealer Greek Exposure** | DELTA / GAMMA / VEGA / VANNA / CHARM by strike (checkboxes). Modes: Weighted OI · Dealer (5d) · Flow (1d) · Combined · Compare Greeks (all checked greeks on one chart, each on its own axis, symmetric around a shared zero). Strike range All / ±5% / ±10% / ±20%, expiry filter, spot marker, "(Prior Trading Day)" on OI modes. |
| 7 | Volatility | **IV term structure** and **fixed-strike skew** | ATM call IV vs put IV per expiry; OTM IV by strike for up to 6 expiries. |
| 8 | Tape | **Tape** | TIME, SYMBOL, EXP, STRIKE, C/P, SPOT, DETAILS (`qty@price_A/_B/_M`), TYPE (SWEEP/BLOCK), VALUE, IV. Deep-ITM prints are flagged. |
| 9 | MSI | **MSI – Market Stability Index** | Composite time series plus one sparkline per component. The formula is JSON (below). |
| 10 | Daily Summary | **Daily per-root summary** | root, date, total_net_premium, total_net_delta, total_net_vega, persisted (SQLite, or the worker's Postgres). |
| — | ELMo-D Chart | **ELMo-D** | Price layer + ELMo-D pane + LHH pane + 8-row heatmap pane, on 1m/3m/5m/15m/1h/4h/1D. |

## Conventions

**Aggressor signing** (`src/lib/flowdesk/flow/classify.ts`) against the NBBO at trade time:

| Print | Side | Premium sign |
|---|---|---|
| price ≥ ask | buy | + |
| price ≤ bid | sell | − |
| bid < price < ask, above mid | buy (quote rule) | + |
| bid < price < ask, below mid | sell (quote rule) | − |
| exactly at mid, no quote, crossed/locked quote | unknown | 0 (still counts toward volume) |

Premium = price × size × 100. "Call Premium" / "Put Premium" columns are the **signed** sums for that right.

**Net Premium: the friend's two tables use different conventions, and both are kept by default:**

| Table | Default | Setting |
|---|---|---|
| Top Symbols, Recent Flow | **Net = Call − Put** | Settings bar → "Top Symbols / Recent net" |
| By Expiration | **Net = Call + Put** | Settings bar → "By-Expiration net" |

Sentiment = sign of that table's Net (Bullish > 0, Bearish < 0). The Options Flow chart's net line is Call − Put.

**Deep-ITM prints:** |delta| > 0.95 (financing / dividend-capture prints) are flagged in the tape and, by default, **excluded from premium and sentiment** in every table, the heatmap's $ figures, the flow chart, dealer-flow modes, MSI and the daily summary. They still count toward volume. Settings bar → "Exclude |Δ| > 0.95 from sentiment".

**Dealer greeks** use the repo's Black-Scholes engine (`src/lib/math/blackScholes.ts`, the same functions behind GEX/DEX/vanna/charm; vendor Δ/Γ/vega are used when the chain provides them). Units match the existing GEX chart:

| Mode | Dealer position per contract |
|---|---|
| Weighted OI | repo convention: +OI for calls, −OI for puts (OI = prior trading day) |
| Dealer (5d) | −Σ aggressor-signed contracts over the last 5 sessions (dealer takes the other side) |
| Flow (1d) | the same over today |
| Combined | Weighted OI + Flow (1d) |

Exposure: Δ·100·S ($ delta), Γ·100·S²·0.01 ($ gamma per 1%), vega·100 ($ per vol point), vanna·100, charm·100 (per day), each multiplied by that position.

**Daily summary** (per root, per date): `total_net_premium` = Σ bullish-signed premium (call buys and put sells +, call sells and put buys −) = Call − Put; `total_net_delta` = Σ side × contracts × 100 × Δ; `total_net_vega` = Σ side × contracts × 100 × vega.

## ELMo-D

Pure functions in `src/lib/flowdesk/indicators/` (`ta.ts`, `elmod.ts`, `mtf.ts`), unit-tested in `elmod.test.ts`.

- **ENTP** = 100·(r − min)/(max − min), r = WMA9(ln(close/close[10])). Scaling: **loaded history** (default; uses the whole loaded series) or **rolling 1,000 bars** (causal; uses what exists until 1,000 bars are loaded).
- **Ribbon:** MA1..MA4 = ALMA(ENTP, 5/20/50/100, offset 0.85, sigma 10). Filled bands ENTP/MA1, MA1/MA2, MA2/MA3, MA3/MA4: green when the faster line is above the slower one, else red.
- **LHH** (Hui-Heubel, 10): pmax = highest(high,10), pmin = lowest(low,10), dv = Σ10 hlc3·volume, LHH = ((pmax − pmin)/pmin) / (dv / (sma(vol,10)·sma(close,10))) · 100, with SMA20 and SMA50.
- **Price layer:** ALMA(close, 20/100/200, 0.85, sigma 6); EMA 20/50/100/200 (alpha 2/(n+1), seeded with the SMA of the first n bars); **liquidity shelves** = confirmed pivot highs/lows (left 10, right 5; drawn from the pivot bar, known only 5 bars later) and gap edges, each extended until price trades through it (the chart shows the 14 nearest active ones); **consolidation boxes** where LHH < SMA50(LHH) for ≥ 6 bars.
- **Extreme-turn marks** (`ctx▼` / `ctx▲`): an ENTP peak ≥ 80 that has started dipping, a trough ≤ 20 that has started rising. Labelled in the UI as **context marks, not signals**.
- **Pine conventions:** ALMA m = floor(offset·(len−1)), s = len/sigma, w_i = exp(−(i−m)²/(2s²)), with w_0 applied to the **oldest** bar of the window (as `ta.alma`); WMA weights newest = len … oldest = 1; any NaN in a window gives NaN.
- **Multi-timeframe:** the ELMo-D pane works on every interval. 3m is built from 1m bars; 1h and 4h from 15m bars (Tradier's native intraday sizes); buckets are aligned to ET midnight. The optional **HTF overlay** (e.g. 15m ENTP/MA1/MA2 as dotted step lines on a 5m chart) is computed from completed HTF bars only. A bucket counts as complete at the close of its last LTF bar if that bar reaches the bucket end, otherwise at the close of the first bar of the next bucket. A unit test checks that truncating future bars never changes past overlay values (rolling scaling). With history scaling, the overlay's 0–100 range uses the whole loaded HTF history; that is what history scaling means.
- **Heatmap pane:** 8 rows (chart ticker + SPY, QQQ, DIA, IWM, BTCUSD, GLD, TLT; edit the list in the "rows" box). Cell colour = number of bullish fills (0–4) with ENTP lookback 20. Dots (labelled approximate): bull (white) = ENTP crosses up MA1 while below MA3; bear (dark) = ENTP crosses down MA1 while above MA3. Each row is aligned to the chart's bars by the last bar at or before each time.

## MSI and its formula hook

Components (`src/lib/flowdesk/msi/components.ts`), sampled every 5 minutes over RTH:

| id | Definition |
|---|---|
| `gamma_all` | all-expiry OI-weighted dealer gamma, recomputed at each sample's spot and time to expiry |
| `dex_5pct` | dealer $ delta for strikes within ±5% of spot |
| `exp_prem_today` | Σ OI × 100 × BS value of contracts expiring today |
| `exp_prem_week` | the same for expiries on or before this Friday |
| `entropy_strike` | normalised Shannon entropy H/ln N of \|cumulative signed premium\| across strikes |
| `entropy_expiry` | the same across expiries |
| `flow_skew` | (call net − put net) / (\|call net\| + \|put net\|), cumulative |

The composite is defined entirely in JSON, so the research repo can swap it without code changes:

```json
{
  "name": "MSI – Market Stability Index", "version": 1,
  "normalize": "expanding_zscore",
  "components": [ { "id": "gamma_all", "weight": 0.35 }, { "id": "exp_prem_today", "weight": 0.1, "invert": true } ],
  "output": { "transform": "logistic", "scale": 100 }
}
```

`composite(t) = output(Σ weight · (invert ? −1 : 1) · normalize(component)(t))`. Normalisation is one of `expanding_zscore` (causal), `zscore`, `minmax`, `none`; output transform one of `logistic`, `minmax`, `none`.

Where the config comes from, highest priority first:
1. **Edit formula (JSON)** in the panel: validated, stored in this browser only; "Reset to server config" removes it.
2. `FLOW_DESK_MSI_CONFIG=/path/to/msi.json` on the server.
3. The bundled default, [`config/flow-desk/msi.json`](config/flow-desk/msi.json). **Its weights are an uncalibrated placeholder**, and the panel says so.

## Pointing it at live data

1. Set the keys you already use (`TRADIER_API_KEY`, `POLYGON_API_KEY`) in `.env.local` / Vercel.
2. Flip the toggle to **Live**. Chain-based panels (Weighted OI greeks, Volatility) and the ELMo-D chart work with Tradier alone. Flow panels need option prints with NBBO; see [DATA_SOURCES.md](DATA_SOURCES.md) for what is needed and the options.
3. Optional:
   - `FLOW_DESK_MAX_CONTRACTS` (default 25): how many of the most active contracts per root to pull prints for.
   - `FLOW_DESK_DEMO=true`: force demo mode server-side.
   - `FLOW_DESK_DB_PATH`: SQLite path for the daily summary.
   - `FLOW_DESK_WORKER_URL` + `FLOW_SUMMARY_TOKEN`: write the daily summary to the worker's Postgres instead. Set the same token on the worker; worker writes are disabled without it.
   - `FLOW_SUMMARY_TOKEN` on the dashboard also guards live `POST /api/flow-desk/summary`.
4. To persist the daily summary automatically, call `POST /api/flow-desk/summary?mode=live` after the close, the same way `.github/workflows/entropy-cron.yml` calls the entropy cron, with `Authorization: Bearer $FLOW_SUMMARY_TOKEN`.

### API

| Route | Returns |
|---|---|
| `GET /api/flow-desk/status?mode=` | mode, session date, "now", which sources are configured (booleans only), universe |
| `GET /api/flow-desk/trades?symbols=SPY,QQQ&days=1..5&mode=` | `OptionTrade[]` (with NBBO) or `{noSource}` |
| `GET /api/flow-desk/chain?symbol=&mode=` | `ChainSnapshot` or `{noSource}` |
| `GET /api/flow-desk/bars?symbol=&interval=1m…1D&mode=` | OHLCV or `{noSource}` |
| `GET /api/flow-desk/msi-config` | the active server MSI config |
| `GET/POST /api/flow-desk/summary?mode=` | list / compute and persist the daily per-root summary |

## Development

```bash
npm test                    # vitest: indicator math, flow conventions, greeks, MSI, demo data
npm run build
npx next start -p 3100 &    # then:
node scripts/flowdesk-screenshots.mjs http://localhost:3100 docs/flow-desk 2
```

Code map: `src/lib/flowdesk/` (pure logic, providers, demo generator, storage) · `src/components/flowdesk/` (UI) · `src/app/api/flow-desk/` (routes) · `worker/migrations/004_flow_daily_summary.sql`, `worker/src/flowSummary.ts` (Postgres).
