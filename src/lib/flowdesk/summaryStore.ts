/**
 * Daily per-root flow summary persistence (server-only).
 *
 * Backends, in order:
 *   1. FLOW_DESK_WORKER_URL set → the Railway worker (Postgres, worker/migrations/004_flow_daily_summary.sql)
 *   2. local SQLite via better-sqlite3 (same pattern as the entropy engine): data/flowdesk.db,
 *      or FLOW_DESK_DB_PATH, falling back to /tmp when cwd is read-only.
 * The table DDL is valid in both SQLite and Postgres.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DailyRootSummary } from './flow/aggregate';

export interface StoredSummary extends DailyRootSummary {
  source: 'demo' | 'live';
  updated_at: string;
}

export const FLOW_SUMMARY_DDL = `
CREATE TABLE IF NOT EXISTS flow_daily_summary (
  root               TEXT NOT NULL,
  date               DATE NOT NULL,
  source             TEXT NOT NULL DEFAULT 'live',
  total_net_premium  DOUBLE PRECISION NOT NULL,
  total_net_delta    DOUBLE PRECISION NOT NULL,
  total_net_vega     DOUBLE PRECISION NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (root, date, source)
);`;

type Db = {
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  exec(sql: string): void;
};

let db: Db | null = null;

function resolvePath(): string {
  if (process.env.FLOW_DESK_DB_PATH) return process.env.FLOW_DESK_DB_PATH;
  const dir = path.join(process.cwd(), 'data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return path.join(dir, 'flowdesk.db');
  } catch {
    const tmp = path.join('/tmp', 'flowdesk-data');
    fs.mkdirSync(tmp, { recursive: true });
    return path.join(tmp, 'flowdesk.db');
  }
}

function getDb(): Db {
  if (db) return db;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  db = new Database(resolvePath()) as Db;
  db.exec(FLOW_SUMMARY_DDL);
  return db;
}

function workerUrl(): string | null {
  return process.env.FLOW_DESK_WORKER_URL?.replace(/\/$/, '') || null;
}

function workerHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.FLOW_SUMMARY_TOKEN) h.Authorization = `Bearer ${process.env.FLOW_SUMMARY_TOKEN}`;
  return h;
}

export function summaryBackend(): 'worker' | 'sqlite' {
  return workerUrl() ? 'worker' : 'sqlite';
}

export async function upsertSummaries(rows: DailyRootSummary[], source: 'demo' | 'live'): Promise<number> {
  const updated_at = new Date().toISOString();
  const url = workerUrl();
  if (url) {
    const res = await fetch(`${url}/flow-summary`, { method: 'POST', headers: workerHeaders(), body: JSON.stringify({ source, rows }), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`worker flow-summary POST failed: ${res.status}`);
    return rows.length;
  }
  const d = getDb();
  const stmt = d.prepare(`INSERT INTO flow_daily_summary (root, date, source, total_net_premium, total_net_delta, total_net_vega, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (root, date, source) DO UPDATE SET
      total_net_premium = excluded.total_net_premium,
      total_net_delta = excluded.total_net_delta,
      total_net_vega = excluded.total_net_vega,
      updated_at = excluded.updated_at`);
  for (const r of rows) stmt.run(r.root, r.date, source, r.total_net_premium, r.total_net_delta, r.total_net_vega, updated_at);
  return rows.length;
}

export async function listSummaries(opts: { root?: string | null; days: number; source: 'demo' | 'live' }): Promise<StoredSummary[]> {
  const url = workerUrl();
  if (url) {
    const q = new URLSearchParams({ days: String(opts.days), source: opts.source });
    if (opts.root) q.set('root', opts.root);
    const res = await fetch(`${url}/flow-summary?${q}`, { headers: workerHeaders(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`worker flow-summary GET failed: ${res.status}`);
    return ((await res.json()) as { rows: StoredSummary[] }).rows;
  }
  const d = getDb();
  const params: unknown[] = [opts.source];
  let where = 'source = ?';
  if (opts.root) { where += ' AND root = ?'; params.push(opts.root.toUpperCase()); }
  const rows = d.prepare(`SELECT root, date, source, total_net_premium, total_net_delta, total_net_vega, updated_at
    FROM flow_daily_summary WHERE ${where} ORDER BY date DESC, root ASC LIMIT ?`).all(...params, Math.max(1, opts.days) * 50) as StoredSummary[];
  return rows;
}
