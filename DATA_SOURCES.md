# Flow Desk: data sources

Flow Desk reuses the providers Optix already has. No new paid service is required to *run* it: every panel works in **Demo** mode with synthetic data, and the panels whose data the current providers can't supply show a **"No data source configured"** state in Live mode.

Keys are read only from the env vars the repo already uses. They are sent in request headers, never in URLs, and never logged or returned by an API route.

| Env var | Used for |
|---|---|
| `TRADIER_API_KEY` (+ `TRADIER_SANDBOX`) | chain snapshots (OI, IV, greeks), spot, price bars (1m/5m/15m/daily) |
| `POLYGON_API_KEY` | chain fallback, BTCUSD bars (`X:BTCUSD`), **option trade prints + NBBO** |
| `FLOW_DESK_DEMO=true` | force demo mode server-side |

## What each panel needs

| Panel | Data | Available today with |
|---|---|---|
| 1 Options Flow, 2 Top Symbols, 3 By Expiration, 4 Recent Flow, 5 Heatmap, 8 Tape, 10 Daily summary | **trade-level option prints with the NBBO at the time of each trade** (for aggressor signing) | Polygon (see below) — *not* Tradier |
| 6 Dealer Greeks: Weighted OI | chain snapshot with OI + greeks | Tradier or Polygon snapshot |
| 6 Dealer Greeks: Dealer (5d) / Flow (1d) / Combined | prints (as above) for 1 or 5 sessions | Polygon (see below) |
| 7 Volatility | chain snapshot with IV per contract | Tradier or Polygon snapshot |
| 9 MSI | chain snapshot (gamma / DEX / expiring premium) + prints (entropy, flow skew) | Tradier + Polygon prints |
| ELMo-D chart | OHLCV bars | Tradier (equities/ETFs), Polygon (BTCUSD) |

## The gap: prints with NBBO

Aggressor signing (buy at/above ask = +, sell at/below bid = −, quote rule in between) needs, for every option trade, the national best bid/offer **in force at that instant**. Tradier exposes chains and quotes, but no option time & sales. So:

**What is needed exactly:** for each traded contract, every print (timestamp, price, size, exchange, conditions) plus the NBBO quote stream (or the quote attached to each trade) for the session, and for 5 sessions for the "Dealer (5d)" mode.

**Options (no sign-up done; pick one):**

1. **Polygon options plans that include trades (Developer) and quotes (Advanced)** — check current plan names and pricing before buying. Already wired: `src/lib/flowdesk/providers.ts → polygonTradesForRoot` pulls `/v3/trades/{contract}` for the most active contracts (`FLOW_DESK_MAX_CONTRACTS`, default 25 per root) and merges `/v3/quotes/{contract}` as-of each trade. If the key has trades but not quotes, prints are signed against the snapshot's last quote and flagged `≈quote` in the tape (`nbboAtTrade: false`), which is approximate. If the key has neither, the panels show the no-source state.
2. **OPRA via a market-data vendor that ships trades with NBBO attached** (for example Databento OPRA `tcbbo`/`cbbo`, or ThetaData's options trade + quote feed). Implement `getTrades()` in `providers.ts` against the same `OptionTrade` shape (`bid`/`ask` = NBBO at trade time).
3. **A pre-classified flow feed** (for example Unusual Whales or a similar flow API) that already returns side/aggressor. Map its side to `bid`/`ask` placeholders, or extend `OptionTrade` with a vendor `side`.

Whichever you choose, the rest of Flow Desk does not change: all aggregation is in pure functions over `OptionTrade[]` (`src/lib/flowdesk/flow/*`).

## Storage

The daily per-root summary (panel 10) is stored in SQLite (`data/flowdesk.db`, `FLOW_DESK_DB_PATH` to override; same pattern as the entropy engine). If `FLOW_DESK_WORKER_URL` is set, it is written to the Railway worker's Postgres table `flow_daily_summary` instead (`worker/migrations/004_flow_daily_summary.sql`; writes need `FLOW_SUMMARY_TOKEN` on both sides).
