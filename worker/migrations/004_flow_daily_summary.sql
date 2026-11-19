-- Flow Desk: daily per-root options flow summary (written by the dashboard's
-- /api/flow-desk/summary via POST /flow-summary). Read-only data; no trading.
CREATE TABLE IF NOT EXISTS flow_daily_summary (
    root               TEXT NOT NULL,
    date               DATE NOT NULL,
    source             TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'demo')),
    total_net_premium  DOUBLE PRECISION NOT NULL,
    total_net_delta    DOUBLE PRECISION NOT NULL,
    total_net_vega     DOUBLE PRECISION NOT NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (root, date, source)
);

CREATE INDEX IF NOT EXISTS flow_daily_summary_date_idx ON flow_daily_summary (date DESC);
