/**
 * Entropy Engine Persistence — Redis-backed storage for serverless environments.
 *
 * SQLite is ephemeral on Vercel (wiped on cold start). This module syncs
 * all entropy tables to/from Upstash Redis so data survives redeployments.
 *
 * Keys:
 *   entropy:history     — daily entropy metrics [{date, spot, metrics_json}]
 *   entropy:positions   — all positions (open + closed)
 *   entropy:trades      — trade log entries
 *   entropy:equity      — equity curve points
 *   entropy:signals     — signal log entries
 */

// ─── Redis Client ──────────────────────────────────────────

function getRedisConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return { url, token };
  return null;
}

let _redis: import('@upstash/redis').Redis | null = null;

async function getRedis(): Promise<import('@upstash/redis').Redis | null> {
  const config = getRedisConfig();
  if (!config) return null;
  if (!_redis) {
    const { Redis } = await import('@upstash/redis');
    _redis = new Redis({ url: config.url, token: config.token });
  }
  return _redis;
}

// ─── Types ─────────────────────────────────────────────────

interface HistoryRow {
  date: string;
  spot: number;
  metrics_json: string;
}

interface PositionRow {
  id: number;
  strategy: string;
  symbol: string;
  trade_type: string;
  qty: number;
  entry_price: number;
  entry_cost: number;
  entry_date: string;
  strike: number;
  expiry: string;
  is_credit: number;
  is_open: number;
  close_date: string | null;
  close_reason: string | null;
  close_pnl: number | null;
  fill_corrected: number;
}

interface TradeRow {
  id: number;
  date: string;
  strategy: string;
  action: string;
  symbol: string;
  qty: number;
  price: number;
  details: string;
}

interface EquityRow {
  date: string;
  portfolio_value: number;
  cash: number;
  positions_value: number;
}

interface SignalRow {
  date: string;
  strategy: string;
  fired: number;
  strength: number;
  trade_type: string;
  rationale: string;
  executed: number;
}

interface EntropySnapshot {
  history: HistoryRow[];
  positions: PositionRow[];
  trades: TradeRow[];
  equity: EquityRow[];
  signals: SignalRow[];
}

type BetterSqlite3Database = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
};

// ─── Restore: Redis → SQLite ───────────────────────────────

/**
 * Restore all entropy data from Redis into the SQLite database.
 * Call this before any engine run or API read.
 */
export async function restoreFromRedis(db: BetterSqlite3Database): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;

  try {
    const [history, positions, trades, equity, signals] = await Promise.all([
      redis.get<HistoryRow[]>('entropy:history'),
      redis.get<PositionRow[]>('entropy:positions'),
      redis.get<TradeRow[]>('entropy:trades'),
      redis.get<EquityRow[]>('entropy:equity'),
      redis.get<SignalRow[]>('entropy:signals'),
    ]);

    // Check if DB already has data (avoid duplicate restore)
    const existingCount = (db.prepare('SELECT COUNT(*) as cnt FROM entropy_history').get() as { cnt: number }).cnt;
    if (existingCount > 0) return; // Already populated (warm instance)

    if (history && history.length > 0) {
      const stmt = db.prepare('INSERT OR IGNORE INTO entropy_history (date, spot, metrics_json) VALUES (?, ?, ?)');
      for (const row of history) {
        stmt.run(row.date, row.spot, typeof row.metrics_json === 'string' ? row.metrics_json : JSON.stringify(row.metrics_json));
      }
    }

    if (positions && positions.length > 0) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO positions (id, strategy, symbol, trade_type, qty, entry_price,
         entry_cost, entry_date, strike, expiry, is_credit, is_open, close_date, close_reason, close_pnl, fill_corrected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of positions) {
        stmt.run(row.id, row.strategy, row.symbol, row.trade_type, row.qty,
          row.entry_price, row.entry_cost, row.entry_date, row.strike, row.expiry,
          row.is_credit, row.is_open, row.close_date, row.close_reason, row.close_pnl,
          row.fill_corrected);
      }
    }

    if (trades && trades.length > 0) {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO trades_log (id, date, strategy, action, symbol, qty, price, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const row of trades) {
        stmt.run(row.id, row.date, row.strategy, row.action, row.symbol, row.qty, row.price, row.details);
      }
    }

    if (equity && equity.length > 0) {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO equity_curve (date, portfolio_value, cash, positions_value) VALUES (?, ?, ?, ?)'
      );
      for (const row of equity) {
        stmt.run(row.date, row.portfolio_value, row.cash, row.positions_value);
      }
    }

    if (signals && signals.length > 0) {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO signals_log (date, strategy, fired, strength, trade_type, rationale, executed) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const row of signals) {
        stmt.run(row.date, row.strategy, row.fired, row.strength, row.trade_type, row.rationale, row.executed);
      }
    }
  } catch (err) {
    console.error('[entropy-persistence] Failed to restore from Redis:', err);
  }
}

// ─── Persist: SQLite → Redis ───────────────────────────────

/**
 * Persist all entropy data from SQLite to Redis.
 * Call this after engine runs that modify data.
 */
export async function persistToRedis(db: BetterSqlite3Database): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;

  try {
    const history = db.prepare('SELECT date, spot, metrics_json FROM entropy_history ORDER BY date').all() as HistoryRow[];
    const positions = db.prepare('SELECT * FROM positions ORDER BY id').all() as PositionRow[];
    const trades = db.prepare('SELECT * FROM trades_log ORDER BY id').all() as TradeRow[];
    const equity = db.prepare('SELECT * FROM equity_curve ORDER BY date').all() as EquityRow[];
    const signals = db.prepare('SELECT * FROM signals_log ORDER BY date, strategy').all() as SignalRow[];

    await Promise.all([
      redis.set('entropy:history', JSON.stringify(history)),
      redis.set('entropy:positions', JSON.stringify(positions)),
      redis.set('entropy:trades', JSON.stringify(trades)),
      redis.set('entropy:equity', JSON.stringify(equity)),
      redis.set('entropy:signals', JSON.stringify(signals)),
    ]);
  } catch (err) {
    console.error('[entropy-persistence] Failed to persist to Redis:', err);
  }
}

/**
 * Check if Redis has entropy data (for diagnostics).
 */
export async function hasRedisData(): Promise<boolean> {
  const redis = await getRedis();
  if (!redis) return false;
  try {
    const history = await redis.get<HistoryRow[]>('entropy:history');
    return !!history && history.length > 0;
  } catch {
    return false;
  }
}
