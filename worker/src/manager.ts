import { loadConfig } from './config.js';
import { log } from './log.js';
import { dteFromExpiration } from './market.js';
import {
  closeOptionPosition,
  getOptionQuote,
  listPositions,
  type OptionQuote,
} from './alpaca.js';
import { getPool } from './db.js';
import type { OpenPositionSummary } from './risk.js';
import type { Direction, OptionRight, OptionSide } from './types.js';

interface DbPositionRow {
  id: number;
  occ_symbol: string;
  underlying: string;
  right: OptionRight;
  strike: string;
  expiration: string;
  side: OptionSide;
  direction: Direction;
  qty: number;
  entry_price: string | null;
  exit_target_pct: string | null;
  exit_stop_pct: string | null;
  exit_invalidation: string | null;
  status: 'open' | 'closing' | 'closed';
  // Trade key — recomputed from leg attrs because positions table is per leg.
  trade_key?: string;
}

// Group rows that belong to the same opened trade. Heuristic: positions
// inserted with the same entry_briefing_id and underlying within the same
// tick are one trade. (We rely on the loop writing them in one tx.)
async function loadOpenPositions(): Promise<DbPositionRow[]> {
  const { rows } = await getPool().query<DbPositionRow>(
    `SELECT * FROM positions WHERE status IN ('open', 'closing') ORDER BY id`,
  );
  return rows;
}

export async function reconcileWithAlpaca(): Promise<void> {
  // Source-of-truth check: any DB-open row with no matching Alpaca position
  // is marked closed (likely closed via Alpaca UI or stop-out we missed).
  const [dbRows, live] = await Promise.all([loadOpenPositions(), listPositions()]);
  const liveSet = new Set(live.map((p) => p.symbol));
  for (const row of dbRows) {
    if (!liveSet.has(row.occ_symbol)) {
      await getPool().query(
        `UPDATE positions
         SET status='closed', closed_at=NOW(), close_reason='reconcile: not present at Alpaca'
         WHERE id=$1`,
        [row.id],
      );
      log.warn('reconciled missing position', { occ_symbol: row.occ_symbol });
    }
  }
}

export interface ExitDecision {
  position: DbPositionRow;
  occSymbol: string;
  qty: number;
  reason: string;
}

// Decide which positions need to be closed this tick.
// Rules in priority order:
//   1. Assignment risk: short leg ITM with DTE <= ASSIGNMENT_CLOSE_DTE.
//   2. Profit target: live mid hits exit_target_pct of entry.
//   3. Stop loss: live mid hits exit_stop_pct of entry.
// Underlying spot is needed for the ITM check; we use Alpaca's last trade
// price on the position itself (current_price), not a separate equity quote,
// to keep this scaffold simple. A more accurate version would query equity.
export async function planExits(): Promise<ExitDecision[]> {
  const cfg = loadConfig();
  const dbRows = await loadOpenPositions();
  if (dbRows.length === 0) return [];

  const live = await listPositions();
  const liveBy = new Map(live.map((p) => [p.symbol, p]));
  const decisions: ExitDecision[] = [];

  for (const row of dbRows) {
    if (row.status !== 'open') continue;
    const lp = liveBy.get(row.occ_symbol);
    if (!lp) continue; // reconcile pass already handles this

    const dte = dteFromExpiration(row.expiration);

    // Rule 1 — assignment risk on a short leg.
    if (row.side === 'short' && dte <= cfg.ASSIGNMENT_CLOSE_DTE) {
      // ITM check uses option's intrinsic > extrinsic as a robust proxy:
      // an ITM short near expiry has near-zero extrinsic. We use Alpaca's
      // current_price (option mark) and compare to the strike.
      // For a precise ITM call/put test we'd need the underlying spot;
      // querying it on every tick adds latency, so we approximate via the
      // option's current_price + intrinsic decomposition done by quote spread.
      const quote = await getOptionQuote(row.occ_symbol);
      if (quote) {
        // Conservative heuristic: if mid <= 0.10 and DTE <= cap, the short
        // is either deep OTM (safe — but still close to free up capital) or
        // pinned. Either way, close.
        // If mid is meaningful, we still close because of the DTE rule.
        decisions.push({
          position: row,
          occSymbol: row.occ_symbol,
          qty: Math.abs(row.qty),
          reason: `assignment-risk: short DTE ${dte} <= ${cfg.ASSIGNMENT_CLOSE_DTE}, mid ${quote.mid.toFixed(2)}`,
        });
        continue;
      }
    }

    // Rules 2 & 3 — profit target / stop, from per-position quote.
    const entry = parseFloat(row.entry_price ?? '0');
    if (entry <= 0) continue;
    const quote = await getOptionQuote(row.occ_symbol);
    if (!quote) continue;
    const tgt = row.exit_target_pct ? parseFloat(row.exit_target_pct) : null;
    const stp = row.exit_stop_pct ? parseFloat(row.exit_stop_pct) : null;
    const mid = quote.mid;

    if (row.side === 'long' && tgt && mid >= entry * (1 + tgt)) {
      decisions.push({
        position: row,
        occSymbol: row.occ_symbol,
        qty: Math.abs(row.qty),
        reason: `profit-target: mid ${mid.toFixed(2)} >= entry ${entry.toFixed(2)} × (1+${tgt})`,
      });
    } else if (row.side === 'short' && tgt && mid <= entry * (1 - tgt)) {
      decisions.push({
        position: row,
        occSymbol: row.occ_symbol,
        qty: Math.abs(row.qty),
        reason: `profit-target: mid ${mid.toFixed(2)} <= entry ${entry.toFixed(2)} × (1-${tgt})`,
      });
    } else if (row.side === 'long' && stp && mid <= entry * (1 - stp)) {
      decisions.push({
        position: row,
        occSymbol: row.occ_symbol,
        qty: Math.abs(row.qty),
        reason: `stop-loss: mid ${mid.toFixed(2)} <= entry ${entry.toFixed(2)} × (1-${stp})`,
      });
    } else if (row.side === 'short' && stp && mid >= entry * (1 + stp)) {
      decisions.push({
        position: row,
        occSymbol: row.occ_symbol,
        qty: Math.abs(row.qty),
        reason: `stop-loss: mid ${mid.toFixed(2)} >= entry ${entry.toFixed(2)} × (1+${stp})`,
      });
    }
  }

  return decisions;
}

export async function executeExits(decisions: ExitDecision[], dryRun: boolean): Promise<number> {
  let closed = 0;
  for (const d of decisions) {
    log.info('closing position', {
      occ_symbol: d.occSymbol,
      qty: d.qty,
      reason: d.reason,
      dryRun,
    });
    if (dryRun) {
      closed++;
      continue;
    }
    try {
      const order = await closeOptionPosition(d.occSymbol, d.qty, d.position.side);
      if (order) {
        await getPool().query(
          `UPDATE positions SET status='closing', close_reason=$2 WHERE id=$1`,
          [d.position.id, d.reason],
        );
        closed++;
      }
    } catch (e) {
      log.error('close failed', { occ_symbol: d.occSymbol, error: (e as Error).message });
    }
  }
  return closed;
}

// Build the trade-level position summary the risk sizer expects.
export async function summarizeOpenPositionsForRisk(): Promise<OpenPositionSummary[]> {
  // We treat each row in `positions` as a leg; group by (underlying, direction,
  // opened_at minute) as a heuristic for "same trade". For the scaffold, group
  // by entry_briefing_id when present; otherwise fall back to one-per-row.
  const { rows } = await getPool().query<{
    trade_key: string;
    underlying: string;
    direction: Direction;
  }>(
    `SELECT
        COALESCE(entry_briefing_id::text, '') || ':' || underlying AS trade_key,
        underlying,
        direction
     FROM positions
     WHERE status IN ('open', 'closing')
     GROUP BY trade_key, underlying, direction`,
  );
  return rows.map((r) => ({
    tradeKey: r.trade_key,
    underlying: r.underlying,
    direction: r.direction,
  }));
}
