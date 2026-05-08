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

// Decide which TRADES (whole spreads) need to be closed this tick.
//
// Exit logic operates at spread-level, not per-leg, because:
//   - Profit target ("50% of credit captured") is a spread-level concept;
//     applied per-leg it doesn't trigger correctly.
//   - Stop loss ("2× credit") on a credit spread can NEVER trigger per-leg
//     because the leg's max value is bounded by the spread width.
//
// We sign-sum entry prices into initialNet (positive = debit paid up front,
// negative = credit received) and sign-sum closing prices into closeNet,
// then compute P/L% = (closeNet - initialNet) / |initialNet|. This formula
// works for both debit and credit spreads under the standard convention
// where target_pct and stop_pct describe percentage of initial cost/credit.
//
// Triggers (priority order):
//   1. Assignment risk: any short leg with DTE <= ASSIGNMENT_CLOSE_DTE
//   2. Stop loss:       P/L% <= -stop_pct
//   3. Profit target:   P/L% >=  target_pct
export async function planExits(): Promise<ExitDecision[]> {
  const cfg = loadConfig();
  const dbRows = await loadOpenPositions();
  if (dbRows.length === 0) {
    log.info('planExits summary', { rows_examined: 0, decisions_count: 0 });
    return [];
  }

  const live = await listPositions();
  const liveBy = new Map(live.map((p) => [p.symbol, p]));

  // Group rows by trade_key. Legacy rows (pre-trade_key column) get a
  // synthetic single-row group keyed by their id.
  const groups = new Map<string, DbPositionRow[]>();
  for (const row of dbRows) {
    if (row.status !== 'open') {
      log.info('skipping exit-check — row not open', {
        occ_symbol: row.occ_symbol,
        status: row.status,
      });
      continue;
    }
    const key = row.trade_key ?? `legacy:${row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const decisions: ExitDecision[] = [];

  for (const [tradeKey, legs] of groups) {
    // All legs must still be present at Alpaca for spread-level math.
    const missing = legs.filter((l) => !liveBy.get(l.occ_symbol));
    if (missing.length > 0) {
      log.warn('skipping exit-check — leg(s) missing at Alpaca', {
        tradeKey,
        missing_legs: missing.map((l) => l.occ_symbol),
      });
      continue;
    }

    // initialNet: sign-summed entry prices.
    //   long  →  +entry_price (we paid the ask)
    //   short →  -entry_price (we received the bid)
    // Positive net = debit spread, negative net = credit spread.
    let initialNet = 0;
    let entryMissing = false;
    for (const leg of legs) {
      const e = parseFloat(leg.entry_price ?? '0');
      if (e <= 0) {
        log.warn('exit-check — leg has no entry price', {
          occ_symbol: leg.occ_symbol,
        });
        entryMissing = true;
        break;
      }
      const sign = leg.side === 'long' ? +1 : -1;
      initialNet += sign * e;
    }
    if (entryMissing) continue;

    // closeNet: sign-summed conservative closing prices.
    //   long  →  +bid (sell to close)
    //   short →  -ask (buy to close)
    // Tradier first; Alpaca live mark fallback so we never bail silently.
    let closeNet = 0;
    let priceableAll = true;
    let priceSourceMix = '';
    for (const leg of legs) {
      const lp = liveBy.get(leg.occ_symbol)!;
      const q = await getOptionQuoteForLeg(rowToLeg(leg));
      let closingPx: number;
      if (q) {
        closingPx = leg.side === 'long' ? q.bid : q.ask;
        priceSourceMix += 'T';
      } else if (lp.currentPrice && lp.currentPrice > 0) {
        closingPx = lp.currentPrice;
        priceSourceMix += 'A';
      } else {
        log.error('exit-check skipped — leg unpriceable', {
          tradeKey,
          occ_symbol: leg.occ_symbol,
        });
        priceableAll = false;
        break;
      }
      const sign = leg.side === 'long' ? +1 : -1;
      closeNet += sign * closingPx;
    }
    if (!priceableAll) continue;

    const targetPct = legs[0].exit_target_pct ? parseFloat(legs[0].exit_target_pct) : null;
    const stopPct = legs[0].exit_stop_pct ? parseFloat(legs[0].exit_stop_pct) : null;
    const plRatio = (closeNet - initialNet) / Math.abs(initialNet);

    // 1. Assignment risk on any short leg.
    let assignmentReason: string | null = null;
    for (const leg of legs) {
      if (leg.side !== 'short') continue;
      try {
        const dte = dteFromExpiration(leg.expiration);
        if (dte <= cfg.ASSIGNMENT_CLOSE_DTE) {
          assignmentReason = `assignment-risk: ${leg.occ_symbol} short DTE ${dte} <= ${cfg.ASSIGNMENT_CLOSE_DTE}`;
          break;
        }
      } catch (e) {
        log.warn('dte calc failed', {
          occ_symbol: leg.occ_symbol,
          error: (e as Error).message,
        });
      }
    }

    let triggerReason: string | null = null;
    if (assignmentReason) {
      triggerReason = assignmentReason;
    } else if (stopPct !== null && plRatio <= -stopPct) {
      triggerReason = `stop-loss: P/L ${(plRatio * 100).toFixed(0)}% <= -${(stopPct * 100).toFixed(0)}% (initialNet ${initialNet.toFixed(2)}, closeNet ${closeNet.toFixed(2)})`;
    } else if (targetPct !== null && plRatio >= targetPct) {
      triggerReason = `profit-target: P/L ${(plRatio * 100).toFixed(0)}% >= ${(targetPct * 100).toFixed(0)}% (initialNet ${initialNet.toFixed(2)}, closeNet ${closeNet.toFixed(2)})`;
    }

    if (triggerReason) {
      // Push one decision per leg — executeExits dedupes by trade_key and
      // closes all sibling legs as one MLEG order anyway.
      for (const leg of legs) {
        decisions.push({
          position: leg,
          occSymbol: leg.occ_symbol,
          qty: Math.abs(leg.qty),
          reason: triggerReason,
        });
      }
    } else {
      log.info('exit-check no trigger', {
        tradeKey,
        legs: legs.length,
        initialNet: initialNet.toFixed(2),
        closeNet: closeNet.toFixed(2),
        pl_ratio_pct: (plRatio * 100).toFixed(0),
        target_pct: targetPct,
        stop_pct: stopPct,
        spread_type: initialNet > 0 ? 'debit' : 'credit',
        price_sources: priceSourceMix,
      });
    }
  }

  log.info('planExits summary', {
    rows_examined: dbRows.length,
    spreads: groups.size,
    decisions_count: decisions.length,
  });
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
        const liveSingle = (await listPositions()).find((p) => p.symbol === sib.occ_symbol);
        const order = await closeOptionPosition(
          sib.occ_symbol,
          Math.abs(sib.qty),
          sib.side,
          liveSingle?.currentPrice,
        );
        if (order) {
          await markGroupClosing(groupKey, isLegacy ? sib.id : null, trigger.reason);
          closed++;
        }
        continue;
      }

      // 2-4 legs → MLEG close at marketable net price.
      // If a leg is unquotable on Tradier, fall back to Alpaca's live
      // position.current_price (the broker's running mark — always available
      // for any open position, even when the quote endpoint isn't). Cross
      // the spread aggressively (×1.5 / ÷1.5 buffer) to guarantee a fill —
      // a partial-loss exit is infinitely better than a position that sits
      // bleeding because we couldn't get a clean two-sided quote.
      const mlegLegs: MlegLeg[] = [];
      let netDebitPerShare = 0;
      let qtySpread = Math.min(...siblings.map((s) => Math.abs(s.qty)));
      if (!Number.isFinite(qtySpread) || qtySpread <= 0) qtySpread = 1;
      const liveBy = new Map((await listPositions()).map((p) => [p.symbol, p]));

      let priceable = true;
      for (const sib of siblings) {
        const q = await getOptionQuoteForLeg(rowToLeg(sib));
        const closeSide: 'buy' | 'sell' = sib.side === 'long' ? 'sell' : 'buy';
        let px: number;
        if (q) {
          px = sib.side === 'long' ? q.bid : q.ask;
        } else {
          const live = liveBy.get(sib.occ_symbol);
          if (!live || !live.currentPrice || live.currentPrice <= 0) {
            log.error('cannot price leg for emergency close — no Tradier quote and no live mark', {
              occ_symbol: sib.occ_symbol,
            });
            priceable = false;
            break;
          }
          // Cross the spread aggressively. Long-side close (sell) accepts
          // less than mark; short-side close (buy) pays more than mark.
          px = sib.side === 'long' ? live.currentPrice * 0.7 : live.currentPrice * 1.5;
          log.warn('using Alpaca live mark for emergency close', {
            occ_symbol: sib.occ_symbol,
            mark: live.currentPrice,
            limit: px,
          });
        }
        const sign = sib.side === 'long' ? -1 : 1;
        netDebitPerShare += sign * px;
        mlegLegs.push({
          occSymbol: sib.occ_symbol,
          ratioQty: 1,
          side: closeSide,
          positionIntent: sib.side === 'long' ? 'sell_to_close' : 'buy_to_close',
        });
      }
      if (!priceable) {
        log.warn('cannot MLEG-close — leg unpriceable', { trade_key: groupKey });
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
