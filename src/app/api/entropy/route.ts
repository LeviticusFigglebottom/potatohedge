import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { initSchema } from '@/lib/entropy/schema';

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
      if (recentHistory.length >= 10) {
        const keys = ['comp_volume', 'comp_greek', 'composite', 'iv_mean', 'put_skew', 'pcr_dollar'];
        for (const key of keys) {
          const vals = recentHistory
            .map(r => JSON.parse(r.metrics_json)[key])
            .filter((v: unknown): v is number => v != null && typeof v === 'number')
            .sort((a: number, b: number) => a - b);
          medians[key] = vals.length > 0 ? vals[Math.floor(vals.length / 2)] : null;
        }
      }

      return NextResponse.json({
        status: historyCount >= 30 ? 'active' : 'warmup',
        warmup: { current: historyCount, required: 30 },
        date: latest?.date || null,
        spot: latest?.spot || null,
        metrics,
        medians,
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
          records: m.n_records ?? m._n_records ?? null,
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
 * Destructive and the site is public, so it requires `Authorization: Bearer <CRON_SECRET>`
 * (the dashboard asks for it during the two-step confirmation).
 */
export async function DELETE(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured — purge disabled' }, { status: 403 });
  }
  if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
