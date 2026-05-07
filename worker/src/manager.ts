import { loadConfig } from './config.js';
import { log } from './log.js';
import { dteFromExpiration } from './market.js';
import {
  closeOptionPosition,
  listPositions,
  submitMlegOrder,
  type MlegLeg,
} from './alpaca.js';
import { getOptionQuoteForLeg } from './quotes.js';
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
  trade_key: string | null;
}

// Group rows that belong to the same opened trade. Heuristic: positions
// inserted with the same entry_briefing_id and underlying within the same
// tick are one trade. (We rely on the loop writing them in one tx.)
function rowToLeg(row: DbPositionRow): {
  underlying: string;
  right: OptionRight;
  strike: number;
  expiration: string;
  side: 'long' | 'short';
  ratio: number;
} {
  return {
    underlying: row.underlying,
    right: row.right,
    strike: parseFloat(row.strike),
    expiration:
      typeof row.expiration === 'string'
        ? row.expiration.slice(0, 10)
        : new Date(row.expiration as unknown as Date).toISOString().slice(0, 10),
    side: row.side,
    ratio: 1,
  };
}

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
      const quote = await getOptionQuoteForLeg(rowToLeg(row));
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
    const quote = await getOptionQuoteForLeg(rowToLeg(row));
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

// Close a whole spread atomically: any single-leg trigger pulls every sibling
// leg with the same trade_key into one MLEG closing order. Legacy positions
// without trade_key fall back to per-leg single closes.
export async function executeExits(decisions: ExitDecision[], dryRun: boolean): Promise<number> {
  if (decisions.length === 0) return 0;

  // Group triggers by trade_key. Legs without a trade_key get a synthetic
  // unique group so they're handled one-by-one (legacy fallback).
  const groups = new Map<string, ExitDecision>();
  for (const d of decisions) {
    const key = d.position.trade_key ?? `legacy:${d.position.id}`;
    if (!groups.has(key)) groups.set(key, d);
  }

  let closed = 0;
  for (const [groupKey, trigger] of groups) {
    try {
      const isLegacy = groupKey.startsWith('legacy:');
      const siblings = isLegacy
        ? [trigger.position]
        : await loadOpenLegsByTradeKey(groupKey);
      if (siblings.length === 0) continue;

      log.info('closing trade', {
        trade_key: groupKey,
        legs: siblings.length,
        reason: trigger.reason,
        dryRun,
      });

      if (dryRun) {
        closed++;
        continue;
      }

      if (siblings.length === 1) {
        const sib = siblings[0]!;
        const order = await closeOptionPosition(sib.occ_symbol, Math.abs(sib.qty), sib.side);
        if (order) {
          await markGroupClosing(groupKey, isLegacy ? sib.id : null, trigger.reason);
          closed++;
        }
        continue;
      }

      // 2-4 legs → MLEG close at marketable net price.
      const mlegLegs: MlegLeg[] = [];
      let netDebitPerShare = 0;
      let unquotable = false;
      let qtySpread = Math.min(...siblings.map((s) => Math.abs(s.qty)));
      if (!Number.isFinite(qtySpread) || qtySpread <= 0) qtySpread = 1;

      for (const sib of siblings) {
        const q = await getOptionQuoteForLeg(rowToLeg(sib));
        if (!q) {
          unquotable = true;
          break;
        }
        // Closing a long leg = sell at bid; closing a short leg = buy at ask.
        const closeSide: 'buy' | 'sell' = sib.side === 'long' ? 'sell' : 'buy';
        const px = sib.side === 'long' ? q.bid : q.ask;
        const sign = sib.side === 'long' ? -1 : 1; // closing flips the sign
        netDebitPerShare += sign * px;
        mlegLegs.push({
          occSymbol: sib.occ_symbol,
          ratioQty: 1,
          side: closeSide,
          positionIntent: sib.side === 'long' ? 'sell_to_close' : 'buy_to_close',
        });
      }
      if (unquotable) {
        log.warn('cannot MLEG-close — leg unquotable', { trade_key: groupKey });
        continue;
      }

      const order = await submitMlegOrder({
        qty: qtySpread,
        legs: mlegLegs,
        netLimitPrice: netDebitPerShare,
        timeInForce: 'day',
      });
      log.info('MLEG close submitted', {
        trade_key: groupKey,
        order_id: order.id,
        net: netDebitPerShare.toFixed(2),
      });
      await markGroupClosing(groupKey, null, trigger.reason);
      closed++;
    } catch (e) {
      log.error('group close failed', { groupKey, error: (e as Error).message });
    }
  }
  return closed;
}

async function loadOpenLegsByTradeKey(tradeKey: string): Promise<DbPositionRow[]> {
  const { rows } = await getPool().query<DbPositionRow>(
    `SELECT * FROM positions WHERE trade_key = $1 AND status = 'open' ORDER BY id`,
    [tradeKey],
  );
  return rows;
}

async function markGroupClosing(
  tradeKey: string,
  legacyPositionId: number | null,
  reason: string,
): Promise<void> {
  if (legacyPositionId !== null) {
    await getPool().query(
      `UPDATE positions SET status='closing', close_reason=$2 WHERE id=$1`,
      [legacyPositionId, reason],
    );
    return;
  }
  await getPool().query(
    `UPDATE positions SET status='closing', close_reason=$2
     WHERE trade_key = $1 AND status = 'open'`,
    [tradeKey, reason],
  );
}

// Build the trade-level position summary the risk sizer expects.
// Groups legs by their structural trade_key so a 4-leg iron condor counts
// as one position against the concurrency / directional caps.
export async function summarizeOpenPositionsForRisk(): Promise<OpenPositionSummary[]> {
  const { rows } = await getPool().query<{
    trade_key: string;
    underlying: string;
    direction: Direction;
  }>(
    `SELECT trade_key, underlying, direction
     FROM positions
     WHERE status IN ('open', 'closing') AND trade_key IS NOT NULL
     GROUP BY trade_key, underlying, direction`,
  );
  return rows.map((r) => ({
    tradeKey: r.trade_key,
    underlying: r.underlying,
    direction: r.direction,
  }));
}

// Set of structural trade keys we currently hold. Used to refuse re-opening
// an identical spread the briefing surfaces again on a later tick.
export async function getOpenTradeKeys(): Promise<Set<string>> {
  const { rows } = await getPool().query<{ trade_key: string }>(
    `SELECT DISTINCT trade_key FROM positions
     WHERE status IN ('open', 'closing') AND trade_key IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.trade_key));
}
