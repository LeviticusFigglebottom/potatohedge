-- Portfolio manager state.
-- All trade decisions are reconciled against Alpaca on every tick — this
-- table is the durable store of *exit criteria* and *briefing provenance*
-- per opened position, which Alpaca itself does not record.

CREATE TABLE IF NOT EXISTS positions (
    id                  BIGSERIAL PRIMARY KEY,
    -- Alpaca option contract symbol, e.g. SPY250221C00605000
    occ_symbol          TEXT NOT NULL UNIQUE,
    underlying          TEXT NOT NULL,
    right               TEXT NOT NULL CHECK (right IN ('call', 'put')),
    strike              NUMERIC(12, 4) NOT NULL,
    expiration          DATE NOT NULL,
    side                TEXT NOT NULL CHECK (side IN ('long', 'short')),
    direction           TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish', 'neutral')),
    qty                 INTEGER NOT NULL,
    entry_price         NUMERIC(12, 4),
    entry_order_id      TEXT,
    entry_briefing_id   BIGINT,
    -- Free-form exit rules supplied by the AI briefing, plus a normalized
    -- numeric target/stop so we don't have to re-parse on every tick.
    exit_target_pct     NUMERIC(6, 4),
    exit_stop_pct       NUMERIC(6, 4),
    exit_invalidation   TEXT,
    exit_thesis         TEXT,
    status              TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'closing', 'closed')),
    opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at           TIMESTAMPTZ,
    close_reason        TEXT
);

CREATE INDEX IF NOT EXISTS positions_status_idx ON positions (status);
CREATE INDEX IF NOT EXISTS positions_underlying_idx ON positions (underlying);

-- One row per scheduled tick. Useful for debugging "why did nothing happen?"
CREATE TABLE IF NOT EXISTS tick_runs (
    id              BIGSERIAL PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'ok', 'error', 'skipped')),
    skipped_reason  TEXT,
    pv_usd          NUMERIC(14, 2),
    positions_open  INTEGER,
    closed_count    INTEGER DEFAULT 0,
    opened_count    INTEGER DEFAULT 0,
    error_message   TEXT,
    notes           TEXT
);

-- Raw briefing payloads, kept so we can replay or audit a decision later.
CREATE TABLE IF NOT EXISTS briefings (
    id          BIGSERIAL PRIMARY KEY,
    tick_run_id BIGINT REFERENCES tick_runs (id) ON DELETE SET NULL,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload     JSONB NOT NULL,
    parsed      JSONB
);
