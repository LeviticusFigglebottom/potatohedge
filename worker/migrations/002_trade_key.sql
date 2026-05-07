-- Structural identifier of the trade a position belongs to. Same value across
-- every leg of a multi-leg spread, stable across runs, so we can:
--   (a) collapse legs into a single "position" for the concurrency caps
--   (b) refuse to re-open an identical structural trade we still hold
--
-- Format (matches NormalizedTrade.key in TS): "<UNDERLYING>:<sorted leg sigs>"
ALTER TABLE positions ADD COLUMN IF NOT EXISTS trade_key TEXT;

CREATE INDEX IF NOT EXISTS positions_trade_key_idx ON positions (trade_key);

-- Net order id for the multi-leg order Alpaca returns for an MLEG submission.
-- Same value across every leg of one spread submission. Useful for canceling
-- the whole spread or correlating fills.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS mleg_order_id TEXT;
