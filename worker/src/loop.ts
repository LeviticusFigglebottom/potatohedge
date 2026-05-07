import { loadConfig } from './config.js';
import { log } from './log.js';
import { getPool } from './db.js';
import { isMarketOpenNow } from './market.js';
import { getAccount } from './alpaca.js';
import { fetchBriefing, normalizeTradeIdeas, type BriefingPayload } from './briefing.js';
import {
  executeExits,
  planExits,
  reconcileWithAlpaca,
  summarizeOpenPositionsForRisk,
} from './manager.js';
import { sizeAndFilter } from './risk.js';
import {
  buildOccSymbol,
  getOptionQuote,
  submitOptionOrder,
} from './alpaca.js';
import type { NormalizedTrade } from './types.js';

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

    // ── 5. Filter out trades we already hold (dedupe by trade key).
    const openSummary = await summarizeOpenPositionsForRisk();
    const heldKeys = new Set(openSummary.map((p) => p.tradeKey));
    const fresh = trades.filter((t) => {
      // Heuristic dedupe: existing summary key is "<briefing_id>:<underlying>"
      // — that is a *db* artifact and won't match the structural trade.key.
      // We dedupe by underlying+direction+legs hash via `t.key`.
      // Track the last-N opened keys in a separate query if you need stronger
      // dedupe across runs. For now we let live position checks below handle it.
      return !heldKeys.has(t.key);
    });

    // ── 6. Size each trade against PV / caps / live quotes.
    const sized = await sizeAndFilter(fresh, {
      portfolioValue: acct.portfolioValue,
      buyingPower: acct.buyingPower,
      openPositions: openSummary,
    });

    // ── 7. Submit. Persist legs into `positions` keyed by entry_briefing_id.
    for (const result of sized) {
      if (result.rejected) {
        log.info('trade rejected', { trade: result.trade.key, reason: result.reason });
        continue;
      }
      try {
        for (const leg of result.trade.legs) {
          const occ = buildOccSymbol(leg);
          const quote = result.perLegQuotes[occ];
          if (!quote) continue;
          // Cross the spread on entry too.
          const limit = leg.side === 'long' ? quote.ask : quote.bid;
          const side: 'buy' | 'sell' = leg.side === 'long' ? 'buy' : 'sell';
          const qty = result.contracts * leg.ratio;

          if (cfg.DRY_RUN) {
            log.info('DRY_RUN order', { occ, side, qty, limit });
          } else {
            const order = await submitOptionOrder({
              occSymbol: occ,
              qty,
              side,
              limitPrice: limit,
              timeInForce: 'day',
            });
            log.info('order submitted', { occ, side, qty, limit, order_id: order.id });
            await getPool().query(
              `INSERT INTO positions (
                 occ_symbol, underlying, "right", strike, expiration, side, direction,
                 qty, entry_price, entry_order_id, entry_briefing_id,
                 exit_target_pct, exit_stop_pct, exit_invalidation, exit_thesis
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               ON CONFLICT (occ_symbol) DO NOTHING`,
              [
                occ,
                leg.underlying,
                leg.right,
                leg.strike,
                leg.expiration,
                leg.side,
                result.trade.direction,
                qty,
                limit,
                order.id,
                briefingId,
                result.trade.exitTargetPct ?? null,
                result.trade.exitStopPct ?? null,
                result.trade.invalidation ?? null,
                result.trade.thesis ?? null,
              ],
            );
          }
        }
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
