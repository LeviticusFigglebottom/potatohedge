/**
 * Flow Desk daily per-root summary storage (Postgres). Pure data — this module
 * never touches Alpaca or any order endpoint.
 */
import { getPool } from './db.js';

export interface FlowSummaryRow {
  root: string;
  date: string;
  total_net_premium: number;
  total_net_delta: number;
  total_net_vega: number;
}

export async function upsertFlowSummaries(rows: FlowSummaryRow[], source: 'live' | 'demo'): Promise<number> {
  let n = 0;
  for (const r of rows) {
    if (!/^[A-Z.]{1,12}$/.test(r.root) || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    await getPool().query(
      `INSERT INTO flow_daily_summary (root, date, source, total_net_premium, total_net_delta, total_net_vega, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (root, date, source) DO UPDATE SET
         total_net_premium = EXCLUDED.total_net_premium,
         total_net_delta   = EXCLUDED.total_net_delta,
         total_net_vega    = EXCLUDED.total_net_vega,
         updated_at        = NOW()`,
      [r.root, r.date, source, Number(r.total_net_premium) || 0, Number(r.total_net_delta) || 0, Number(r.total_net_vega) || 0],
    );
    n++;
  }
  return n;
}

export async function listFlowSummaries(opts: { root?: string; days: number; source: 'live' | 'demo' }) {
  const params: unknown[] = [opts.source, Math.max(1, Math.min(3650, opts.days))];
  let where = `source = $1 AND date >= CURRENT_DATE - ($2::int)`;
  if (opts.root) { params.push(opts.root.toUpperCase()); where += ` AND root = $3`; }
  const { rows } = await getPool().query(
    `SELECT root, to_char(date, 'YYYY-MM-DD') AS date, source, total_net_premium, total_net_delta, total_net_vega, updated_at
     FROM flow_daily_summary WHERE ${where} ORDER BY date DESC, root ASC LIMIT 5000`,
    params,
  );
  return rows;
}
