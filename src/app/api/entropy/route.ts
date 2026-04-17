import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

function resolveDbPath(): string {
  if (process.env.ENGINE_DB_PATH) return process.env.ENGINE_DB_PATH;
  // Try cwd/data first (local dev), fall back to /tmp (serverless)
  const cwdData = path.join(process.cwd(), 'data');
  try {
    if (!fs.existsSync(cwdData)) fs.mkdirSync(cwdData, { recursive: true });
    const testFile = path.join(cwdData, '.write-test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
    return path.join(cwdData, 'entropy_engine.db');
  } catch {
    const tmpDir = path.join('/tmp', 'entropy-data');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    return path.join(tmpDir, 'entropy_engine.db');
  }
}

function initSchema(db: ReturnType<typeof getDb>) {
  if (!db) return;
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const dbPath = resolveDbPath();
  // Create writable DB (not readonly) so we can restore from Redis
  return new Database(dbPath);
}

export async function GET(request: NextRequest) {
  const view = request.nextUrl.searchParams.get('view') || 'dashboard';
  const days = parseInt(request.nextUrl.searchParams.get('days') || '60', 10);
  const status = request.nextUrl.searchParams.get('status') || 'all';

  let db;
  try {
    db = getDb();
  } catch {
    return NextResponse.json({
      status: 'no_db',
      message: 'Entropy engine database not found.',
      warmup: { current: 0, required: 30 },
    });
  }

  try {
    // Initialize schema, check for cross-instance purge, then restore from Redis
    initSchema(db);
    const { restoreFromRedis, checkPurgeFlag } = await import('@/lib/entropy/persistence');
    await checkPurgeFlag(db);
    await restoreFromRedis(db);

    if (view === 'dashboard') {
      // Latest entropy metrics
      const latest = db.prepare(
        'SELECT date, spot, metrics_json FROM entropy_history ORDER BY date DESC LIMIT 1'
      ).get() as { date: string; spot: number; metrics_json: string } | undefined;

      const metrics = latest ? JSON.parse(latest.metrics_json) : null;

      // History count for warmup status
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM entropy_history').get() as { cnt: number };
      const historyCount = countRow.cnt;

      if (historyCount === 0) {
        return NextResponse.json({
          status: 'no_db',
          message: 'Entropy engine has not been initialized yet.',
          warmup: { current: 0, required: 30 },
        });
      }

      // Open positions
      const openPositions = db.prepare(
        'SELECT * FROM positions WHERE is_open = 1 ORDER BY entry_date DESC'
      ).all();

      // Today's signals
      const today = new Date().toISOString().slice(0, 10);
      const todaySignals = db.prepare(
        'SELECT * FROM signals_log WHERE date = ? ORDER BY strategy'
      ).all(today);

      // If no signals today, get most recent day's signals
      let signalDate = today;
      let signals = todaySignals;
      if (signals.length === 0) {
        const latestSignalRow = db.prepare(
          'SELECT DISTINCT date FROM signals_log ORDER BY date DESC LIMIT 1'
        ).get() as { date: string } | undefined;
        if (latestSignalRow) {
          signalDate = latestSignalRow.date;
          signals = db.prepare(
            'SELECT * FROM signals_log WHERE date = ? ORDER BY strategy'
          ).all(signalDate);
        }
      }

      // Recent trades (last 20)
      const recentTrades = db.prepare(
        'SELECT * FROM trades_log ORDER BY date DESC, id DESC LIMIT 20'
      ).all();

      // Equity curve (last 90 days)
      const equity = db.prepare(
        'SELECT date, portfolio_value, cash, positions_value FROM equity_curve ORDER BY date DESC LIMIT 90'
      ).all();

      // Stats
      const totalTrades = db.prepare(
        'SELECT COUNT(*) as cnt FROM positions WHERE is_open = 0'
      ).get() as { cnt: number };
      const wins = db.prepare(
        'SELECT COUNT(*) as cnt FROM positions WHERE is_open = 0 AND close_pnl > 0'
      ).get() as { cnt: number };
      const totalPnl = db.prepare(
        'SELECT COALESCE(SUM(close_pnl), 0) as total FROM positions WHERE is_open = 0'
      ).get() as { total: number };

      // 21-day medians for gauge comparison
      const recentHistory = db.prepare(
        'SELECT metrics_json FROM entropy_history ORDER BY date DESC LIMIT 21'
      ).all() as { metrics_json: string }[];

      const medians: Record<string, number | null> = {};
      const thresholds: Record<string, number | null> = {};
      const percentileOf = (key: string, p: number): number | null => {
        const vals = recentHistory
          .map((r) => JSON.parse(r.metrics_json)[key])
          .filter((v: unknown): v is number => v != null && typeof v === 'number')
          .sort((a: number, b: number) => a - b);
        if (vals.length === 0) return null;
        const idx = (p / 100) * (vals.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        return lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (idx - lo);
      };
      if (recentHistory.length >= 10) {
        const keys = ['comp_volume', 'comp_greek', 'composite', 'composite_v2', 'iv_mean', 'put_skew', 'pcr_dollar', 'pcr_vol'];
        for (const key of keys) medians[key] = percentileOf(key, 50);
        // Parity thresholds the UI needs for the current-vs-threshold display.
        thresholds.comp_volume_p30 = percentileOf('comp_volume', 30);
        thresholds.pcr_vol_p80 = percentileOf('pcr_vol', 80);
      }

      return NextResponse.json({
        status: historyCount >= 30 ? 'active' : 'warmup',
        warmup: { current: historyCount, required: 30 },
        date: latest?.date || null,
        spot: latest?.spot || null,
        metrics,
        medians,
        thresholds,
        signals: { date: signalDate, items: signals },
        openPositions,
        recentTrades,
        equity: equity.reverse(),
        stats: {
          totalTrades: totalTrades.cnt,
          wins: wins.cnt,
          winRate: totalTrades.cnt > 0 ? Math.round((wins.cnt / totalTrades.cnt) * 100) : 0,
          totalPnl: totalPnl.total,
          openCount: openPositions.length,
        },
      });
    }

    if (view === 'history') {
      const rows = db.prepare(
        'SELECT date, spot, metrics_json FROM entropy_history ORDER BY date DESC LIMIT ?'
      ).all(days) as { date: string; spot: number; metrics_json: string }[];

      return NextResponse.json({
        history: rows.reverse().map(r => ({
          date: r.date,
          spot: r.spot,
          ...JSON.parse(r.metrics_json),
        })),
      });
    }

    if (view === 'signals') {
      const rows = db.prepare(
        `SELECT * FROM signals_log ORDER BY date DESC, strategy LIMIT ?`
      ).all(days * 6); // up to 6 signals per day

      return NextResponse.json({ signals: rows });
    }

    if (view === 'positions') {
      let query = 'SELECT * FROM positions';
      if (status === 'open') query += ' WHERE is_open = 1';
      else if (status === 'closed') query += ' WHERE is_open = 0';
      query += ' ORDER BY entry_date DESC';

      return NextResponse.json({ positions: db.prepare(query).all() });
    }

    if (view === 'equity') {
      const rows = db.prepare(
        'SELECT * FROM equity_curve ORDER BY date'
      ).all();

      return NextResponse.json({ equity: rows });
    }

    if (view === 'diagnostics') {
      const { hasRedisData } = await import('@/lib/entropy/persistence');
      const redisConnected = await hasRedisData().then(() => true).catch(() => false);
      const redisHasData = await hasRedisData().catch(() => false);

      // Fetch cron activity log from Redis
      let cronLog: { timestamp: string; status: string; message: string; source: string }[] = [];
      try {
        const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
        const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
        if (redisUrl && redisToken) {
          const { Redis } = await import('@upstash/redis');
          const redis = new Redis({ url: redisUrl, token: redisToken });
          cronLog = await redis.get<typeof cronLog>('entropy:cron-log') || [];
        }
      } catch { /* non-critical */ }

      // History stats
      const historyRows = db.prepare(
        'SELECT date FROM entropy_history ORDER BY date DESC'
      ).all() as { date: string }[];
      const lastRunDate = historyRows[0]?.date || null;
      const totalDays = historyRows.length;

      // Check for gaps in history (missing trading days)
      const gaps: string[] = [];
      for (let i = 0; i < historyRows.length - 1 && i < 30; i++) {
        const curr = new Date(historyRows[i].date);
        const prev = new Date(historyRows[i + 1].date);
        const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
        // Allow 1 day (consecutive) or 3 days (over weekend); flag anything larger
        if (diffDays > 3) {
          gaps.push(`${historyRows[i + 1].date} → ${historyRows[i].date} (${diffDays} days)`);
        }
      }

      // Recent run results (last 7 entries)
      const recentRuns = db.prepare(
        'SELECT date, spot, metrics_json FROM entropy_history ORDER BY date DESC LIMIT 7'
      ).all() as { date: string; spot: number; metrics_json: string }[];
      const runLog = recentRuns.map(r => {
        const m = JSON.parse(r.metrics_json);
        return {
          date: r.date,
          spot: r.spot,
          composite: m.composite ?? null,
          records: m._n_records ?? null,
        };
      });

      // Next expected run: next weekday at ~4:05pm ET
      const now = new Date();
      const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const etHour = etNow.getHours();
      let nextRun = new Date(etNow);
      // If past 4pm today or already ran today, next run is tomorrow
      if (etHour >= 16 || lastRunDate === now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })) {
        nextRun.setDate(nextRun.getDate() + 1);
      }
      // Skip to Monday if weekend
      while (nextRun.getDay() === 0 || nextRun.getDay() === 6) {
        nextRun.setDate(nextRun.getDate() + 1);
      }
      const nextRunStr = `${nextRun.getFullYear()}-${String(nextRun.getMonth() + 1).padStart(2, '0')}-${String(nextRun.getDate()).padStart(2, '0')} ~4:05pm ET`;

      // ── QC parity diagnostic payload ──────────────────────────
      // Today's dim-level metrics, thresholds, and signal state so the
      // user can eyeball what's driving fire/no-fire without round-tripping
      // through the engine run log.
      const todayRow = db.prepare(
        'SELECT date, spot, metrics_json, schema_version FROM entropy_history ORDER BY date DESC LIMIT 1'
      ).get() as { date: string; spot: number; metrics_json: string; schema_version: string | null } | undefined;
      let parity: Record<string, unknown> | null = null;
      if (todayRow) {
        const m = JSON.parse(todayRow.metrics_json);
        const hist = db.prepare(
          'SELECT metrics_json FROM entropy_history ORDER BY date DESC LIMIT 21'
        ).all() as { metrics_json: string }[];
        const parsed = hist.map((r) => JSON.parse(r.metrics_json)).reverse();
        const valsFor = (key: string): number[] =>
          parsed.map((h) => h[key]).filter((v: unknown): v is number => typeof v === 'number');
        const percentile = (arr: number[], p: number): number | null => {
          if (arr.length === 0) return null;
          const sorted = [...arr].sort((a, b) => a - b);
          const idx = (p / 100) * (sorted.length - 1);
          const lo = Math.floor(idx);
          const hi = Math.ceil(idx);
          return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
        };
        const cvVals = valsFor('comp_volume');
        const psVals = valsFor('put_skew');
        const pcrVals = valsFor('pcr_vol');

        // Cooldown status per signal (days since last fire)
        const lastFireRows = db.prepare(
          "SELECT strategy, MAX(date) AS last_date FROM signals_log WHERE fired = 1 AND strategy IN ('S_SkewFlow','S_PCRContrarian') GROUP BY strategy"
        ).all() as { strategy: string; last_date: string | null }[];
        const cooldownStatus: Record<string, { last_fire: string | null; days_since: number | null; in_cooldown: boolean }> = {};
        for (const s of ['S_SkewFlow', 'S_PCRContrarian']) {
          const row = lastFireRows.find((r) => r.strategy === s);
          if (!row?.last_date) {
            cooldownStatus[s] = { last_fire: null, days_since: null, in_cooldown: false };
          } else {
            const [ly, lm, ld] = row.last_date.split('-').map(Number);
            const [ty, tm, td] = todayRow.date.split('-').map(Number);
            const days = Math.round(
              (Date.UTC(ty, tm - 1, td) - Date.UTC(ly, lm - 1, ld)) / (1000 * 60 * 60 * 24)
            );
            cooldownStatus[s] = { last_fire: row.last_date, days_since: days, in_cooldown: days < 2 };
          }
        }

        // Today's signal-log rows (state, strength, rationale)
        const todaySignals = db.prepare(
          "SELECT strategy, fired, strength, state, rationale FROM signals_log WHERE date = ? AND strategy IN ('S_SkewFlow','S_PCRContrarian')"
        ).all(todayRow.date) as { strategy: string; fired: number; strength: number; state: string | null; rationale: string }[];

        parity = {
          date: todayRow.date,
          schema_version: todayRow.schema_version,
          chain_records: m._n_records ?? null,
          warmup_status: { days_elapsed: totalDays, required: 30, complete: totalDays >= 30 },
          dims: {
            H_vol_term_n: m.H_vol_term_n ?? null,
            H_vol_k_n: m.H_vol_k_n ?? null,
            H_prem_term_n: m.H_prem_term_n ?? null,
            H_vegavol_n: m.H_vegavol_n ?? null,
            H_dgamma_n: m.H_dgamma_n ?? null,
            H_gvx_n: m.H_gvx_n ?? null,
            H_dflow_n: m.H_dflow_n ?? null,
            H_spread_k_n: m.H_spread_k_n ?? null,
            H_moneyness_n: m.H_moneyness_n ?? null,
            H_charm_n: m.H_charm_n ?? null,
          },
          composites: {
            comp_volume: m.comp_volume ?? null,
            comp_greek: m.comp_greek ?? null,
            composite: m.composite ?? null,
            composite_v2: m.composite_v2 ?? null,
          },
          aux: {
            iv_mean: m.iv_mean ?? null,
            put_skew: m.put_skew ?? null,
            pcr_vol: m.pcr_vol ?? null,
            pcr_dollar: m.pcr_dollar ?? null,
          },
          thresholds: {
            comp_volume_p30: percentile(cvVals, 30),
            put_skew_p50: percentile(psVals, 50),
            pcr_vol_p80: percentile(pcrVals, 80),
          },
          cooldown_status: cooldownStatus,
          today_signals: todaySignals,
        };
      }

      return NextResponse.json({
        redisConnected,
        redisHasData,
        totalDays,
        warmupComplete: totalDays >= 30,
        lastRunDate,
        nextExpectedRun: nextRunStr,
        gaps,
        runLog,
        cronLog,
        parity,
      });
    }

    return NextResponse.json({ error: 'Unknown view' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (db) db.close();
  }
}

/**
 * DELETE /api/entropy — Clear all entropy data (clean slate).
 * This is an internal admin action triggered from the dashboard UI.
 * No CRON_SECRET required — the two-step UI confirmation is the guard.
 */
export async function DELETE() {

  try {
    const { clearAllRedisData } = await import('@/lib/entropy/persistence');
    const keysDeleted = await clearAllRedisData();

    // Also clear the local SQLite if it exists
    let sqliteCleared = false;
    try {
      const db = getDb();
      initSchema(db);
      db.exec(`
        DELETE FROM entropy_history;
        DELETE FROM positions;
        DELETE FROM trades_log;
        DELETE FROM equity_curve;
        DELETE FROM signals_log;
      `);
      db.close();
      sqliteCleared = true;
    } catch {
      // SQLite may not exist yet, that's fine
    }

    return NextResponse.json({
      success: true,
      message: 'All entropy data cleared',
      redisKeysDeleted: keysDeleted,
      sqliteCleared,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
