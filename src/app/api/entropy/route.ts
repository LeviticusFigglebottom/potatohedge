import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

function getDb() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const dbPath = process.env.ENGINE_DB_PATH || path.join(process.cwd(), 'data', 'entropy_engine.db');
  if (!fs.existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

export async function GET(request: NextRequest) {
  const view = request.nextUrl.searchParams.get('view') || 'dashboard';
  const days = parseInt(request.nextUrl.searchParams.get('days') || '60', 10);
  const status = request.nextUrl.searchParams.get('status') || 'all';

  const db = getDb();
  if (!db) {
    return NextResponse.json({
      status: 'no_db',
      message: 'Entropy engine database not found. Run entropy_engine.py to initialize.',
      warmup: { current: 0, required: 30 },
    });
  }

  try {
    if (view === 'dashboard') {
      // Latest entropy metrics
      const latest = db.prepare(
        'SELECT date, spot, metrics_json FROM entropy_history ORDER BY date DESC LIMIT 1'
      ).get() as { date: string; spot: number; metrics_json: string } | undefined;

      const metrics = latest ? JSON.parse(latest.metrics_json) : null;

      // History count for warmup status
      const countRow = db.prepare('SELECT COUNT(*) as cnt FROM entropy_history').get() as { cnt: number };
      const historyCount = countRow.cnt;

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

    return NextResponse.json({ error: 'Unknown view' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    db.close();
  }
}
