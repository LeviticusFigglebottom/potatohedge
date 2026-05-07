import { loadConfig } from './config.js';
import { log } from './log.js';
import { getPool } from './db.js';
import { isMarketOpenNow } from './market.js';
import { getAccount } from './alpaca.js';
import { fetchBriefing, normalizeTradeIdeas, type BriefingPayload } from './briefing.js';
import {
  executeExits,
  getOpenTradeKeys,
  planExits,
  reconcileWithAlpaca,
  summarizeOpenPositionsForRisk,
} from './manager.js';
import { sizeAndFilter, type SizingResult } from './risk.js';
import {
  buildOccSymbol,
  submitMlegOrder,
  submitOptionOrder,
  type MlegLeg,
  type PositionIntent,
} from './alpaca.js';
import type { NormalizedLeg, NormalizedTrade } from './types.js';

interface TickResult {
  status: 'ok' | 'skipped' | 'error';
  pv?: number;
  closedCount: number;
  openedCount: number;
  skippedReason?: string;
  errorMessage?: string;
}

async function startTickRun(): Promise<number> {
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO tick_runs (status) VALUES ('running') RETURNING id`,
  );
  return rows[0]!.id;
}

async function finishTickRun(id: number, r: TickResult): Promise<void> {
  await getPool().query(
    `UPDATE tick_runs
     SET finished_at=NOW(), status=$2, pv_usd=$3,
         closed_count=$4, opened_count=$5,
         skipped_reason=$6, error_message=$7
     WHERE id=$1`,
    [
      id,
      r.status,
      r.pv ?? null,
      r.closedCount,
      r.openedCount,
      r.skippedReason ?? null,
      r.errorMessage ?? null,
    ],
  );
}

async function persistBriefing(tickRunId: number, payload: BriefingPayload, parsed: NormalizedTrade[]): Promise<number> {
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO briefings (tick_run_id, payload, parsed) VALUES ($1, $2, $3) RETURNING id`,
    [tickRunId, payload, parsed],
  );
  return rows[0]!.id;
}

async function postAlert(text: string): Promise<void> {
  const url = loadConfig().ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    log.warn('alert webhook failed', { error: (e as Error).message });
  }
}

export async function runTick(opts: { force?: boolean } = {}): Promise<TickResult> {
  const cfg = loadConfig();
  const tickId = await startTickRun();

  if (!opts.force && !isMarketOpenNow()) {
    const r: TickResult = {
      status: 'skipped',
      closedCount: 0,
      openedCount: 0,
      skippedReason: 'market closed',
    };
    log.info('tick skipped', { reason: r.skippedReason });
    await finishTickRun(tickId, r);
    return r;
  }

  let closedCount = 0;
  let openedCount = 0;
  let pv: number | undefined;

  try {
    // ── 1. Reconcile our DB against Alpaca's source-of-truth state.
    await reconcileWithAlpaca();

    // ── 2. Manage existing positions FIRST (free up slots before opening).
    const exits = await planExits();
    log.info('planned exits', { count: exits.length });
    closedCount = await executeExits(exits, cfg.DRY_RUN);

    // ── 3. Pull account + portfolio value.
    const acct = await getAccount();
    pv = acct.portfolioValue;
    log.info('account snapshot', {
      pv: acct.portfolioValue,
      buying_power: acct.buyingPower,
      cash: acct.cash,
    });

    // ── 4. Fetch and normalize the AI briefing.
    const briefing = await fetchBriefing();
    const today = new Date().toISOString().slice(0, 10);
    const trades = await normalizeTradeIdeas(briefing, today);
    const briefingId = await persistBriefing(tickId, briefing, trades);

    // ── 5. Filter out trades we already hold (dedupe by structural trade key).
    const [openSummary, heldKeys] = await Promise.all([
      summarizeOpenPositionsForRisk(),
      getOpenTradeKeys(),
    ]);
    const fresh = trades.filter((t) => {
      if (heldKeys.has(t.key)) {
        log.info('skipping duplicate of open position', { trade: t.key });
        return false;
      }
      return true;
    });

    // ── 6. Size each trade against PV / caps / live quotes.
    const sized = await sizeAndFilter(fresh, {
      portfolioValue: acct.portfolioValue,
      buyingPower: acct.buyingPower,
      openPositions: openSummary,
    });

    // ── 7. Submit each accepted trade as a single Alpaca order:
    //   - 1 leg  → ordinary limit order on /v2/orders
    //   - 2-4    → MLEG order with net debit/credit (no partial-fill risk)
    // Persist every leg into `positions` with a shared trade_key + order id
    // so the manager can group them and dedupe the next briefing.
    for (const result of sized) {
      if (result.rejected) {
        log.info('trade rejected', { trade: result.trade.key, reason: result.reason });
        continue;
      }
      try {
        await openTrade(result, briefingId, cfg.DRY_RUN);
        openedCount++;
      } catch (e) {
        log.error('trade open failed', {
          trade: result.trade.key,
          error: (e as Error).message,
        });
      }
    }

    const r: TickResult = { status: 'ok', pv, closedCount, openedCount };
    await finishTickRun(tickId, r);
    await postAlert(
      `tick ok — pv=$${pv?.toFixed(0)} closed=${closedCount} opened=${openedCount}`,
    );
    return r;
  } catch (e) {
    const msg = (e as Error).message;
    log.error('tick failed', { error: msg });
    const r: TickResult = {
      status: 'error',
      pv,
      closedCount,
      openedCount,
      errorMessage: msg,
    };
    await finishTickRun(tickId, r);
    await postAlert(`tick FAILED: ${msg}`);
    return r;
  }
}

// Submit one trade as either a single-leg limit order or an MLEG, persisting
// every leg with a shared trade_key + Alpaca order id.
async function openTrade(
  result: SizingResult,
  briefingId: number,
  dryRun: boolean,
): Promise<void> {
  const trade = result.trade;
  const contracts = result.contracts;

  // Per-leg limit prices crossing the spread (long → ask, short → bid),
  // and the implied net debit/credit per spread unit (positive = debit).
  const legPlans = trade.legs.map((leg) => {
    const occ = buildOccSymbol(leg);
    const quote = result.perLegQuotes[occ];
    if (!quote) throw new Error(`missing quote for ${occ}`);
    const limit = leg.side === 'long' ? quote.ask : quote.bid;
    return { leg, occ, limit };
  });
  const netDebitPerShare = legPlans.reduce(
    (acc, { leg, limit }) => acc + (leg.side === 'long' ? 1 : -1) * limit * leg.ratio,
    0,
  );

  if (legPlans.length === 1) {
    const only = legPlans[0]!;
    const side: 'buy' | 'sell' = only.leg.side === 'long' ? 'buy' : 'sell';
    const qty = contracts * only.leg.ratio;
    if (dryRun) {
      log.info('DRY_RUN single-leg order', { occ: only.occ, side, qty, limit: only.limit });
      return;
    }
    const order = await submitOptionOrder({
      occSymbol: only.occ,
      qty,
      side,
      limitPrice: only.limit,
      timeInForce: 'day',
    });
    log.info('single-leg order submitted', {
      occ: only.occ,
      side,
      qty,
      limit: only.limit,
      order_id: order.id,
    });
    await insertLeg({
      occ: only.occ,
      leg: only.leg,
      qty,
      entryPrice: only.limit,
      orderId: order.id,
      mlegOrderId: null,
      trade,
      briefingId,
    });
    return;
  }

  // 2-4 legs → MLEG.
  const mlegLegs: MlegLeg[] = legPlans.map(({ leg, occ }) => ({
    occSymbol: occ,
    ratioQty: leg.ratio,
    side: leg.side === 'long' ? 'buy' : 'sell',
    positionIntent: legPositionIntent(leg, 'open'),
  }));
  if (dryRun) {
    log.info('DRY_RUN MLEG order', {
      trade: trade.key,
      qty: contracts,
      net: netDebitPerShare.toFixed(2),
      legs: mlegLegs,
    });
    return;
  }
  const order = await submitMlegOrder({
    qty: contracts,
    legs: mlegLegs,
    netLimitPrice: netDebitPerShare,
    timeInForce: 'day',
  });
  log.info('MLEG order submitted', {
    trade: trade.key,
    qty: contracts,
    net: netDebitPerShare.toFixed(2),
    order_id: order.id,
  });
  for (const { leg, occ, limit } of legPlans) {
    await insertLeg({
      occ,
      leg,
      qty: contracts * leg.ratio,
      entryPrice: limit,
      orderId: order.id,
      mlegOrderId: order.id,
      trade,
      briefingId,
    });
  }
}

function legPositionIntent(leg: NormalizedLeg, action: 'open' | 'close'): PositionIntent {
  if (action === 'open') {
    return leg.side === 'long' ? 'buy_to_open' : 'sell_to_open';
  }
  return leg.side === 'long' ? 'sell_to_close' : 'buy_to_close';
}

interface InsertLegArgs {
  occ: string;
  leg: NormalizedLeg;
  qty: number;
  entryPrice: number;
  orderId: string;
  mlegOrderId: string | null;
  trade: NormalizedTrade;
  briefingId: number;
}

async function insertLeg(a: InsertLegArgs): Promise<void> {
  await getPool().query(
    `INSERT INTO positions (
       occ_symbol, underlying, "right", strike, expiration, side, direction,
       qty, entry_price, entry_order_id, mleg_order_id, entry_briefing_id,
       trade_key,
       exit_target_pct, exit_stop_pct, exit_invalidation, exit_thesis
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (occ_symbol) DO NOTHING`,
    [
      a.occ,
      a.leg.underlying,
      a.leg.right,
      a.leg.strike,
      a.leg.expiration,
      a.leg.side,
      a.trade.direction,
      a.qty,
      a.entryPrice,
      a.orderId,
      a.mlegOrderId,
      a.briefingId,
      a.trade.key,
      a.trade.exitTargetPct ?? null,
      a.trade.exitStopPct ?? null,
      a.trade.invalidation ?? null,
      a.trade.thesis ?? null,
    ],
  );
}
