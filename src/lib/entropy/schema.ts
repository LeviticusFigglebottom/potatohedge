/**
 * Entropy Engine SQLite schema — shared by the engine and the API routes so
 * both create (and migrate) identical tables.
 */

export type SchemaDb = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
};

/** Columns added after the original T13 schema: [table, column, type]. */
const MIGRATIONS: [string, string, string][] = [
  // Second leg for vertical spreads (bull_call_spread / sell_put_spread)
  ['positions', 'leg2_symbol', 'TEXT'],
  ['positions', 'leg2_qty', 'INTEGER'],
  ['positions', 'leg2_strike', 'REAL'],
  // 'strategy' = INITIAL_CASH + strategy P/L; NULL = legacy shared broker balance
  ['equity_curve', 'basis', 'TEXT'],
];

export function initSchema(db: SchemaDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entropy_history (
      date TEXT PRIMARY KEY,
      spot REAL,
      metrics_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      trade_type TEXT,
      qty INTEGER,
      entry_price REAL,
      entry_cost REAL,
      entry_date TEXT,
      strike REAL,
      expiry TEXT,
      is_credit INTEGER,
      is_open INTEGER DEFAULT 1,
      close_date TEXT,
      close_reason TEXT,
      close_pnl REAL,
      fill_corrected INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trades_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      strategy TEXT,
      action TEXT,
      symbol TEXT,
      qty INTEGER,
      price REAL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS equity_curve (
      date TEXT PRIMARY KEY,
      portfolio_value REAL,
      cash REAL,
      positions_value REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS signals_log (
      date TEXT,
      strategy TEXT,
      fired INTEGER,
      strength REAL,
      trade_type TEXT,
      rationale TEXT,
      executed INTEGER DEFAULT 0,
      PRIMARY KEY (date, strategy)
    );
  `);

  for (const [table, column, type] of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}
