import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { runMigrations } from './db.js';
import { log } from './log.js';
import { runTick } from './loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.error('[boot] starting');
  let cfg;
  try {
    cfg = loadConfig();
    console.error('[boot] env validated');
  } catch (e) {
    console.error('[boot] config error:', (e as Error).message);
    throw e;
  }

  // Run migrations on boot — Railway redeploys are fast and migrations
  // are idempotent (tracked in schema_migrations).
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  console.error('[boot] running migrations from', migrationsDir);
  try {
    await runMigrations(migrationsDir);
    console.error('[boot] migrations applied');
  } catch (e) {
    console.error('[boot] migration error:', (e as Error).message);
    log.error('startup migrations failed', { error: (e as Error).message });
    process.exit(1);
  }

  // CLI one-shot: `npm run tick` or `node dist/index.js --once`.
  if (process.argv.includes('--once')) {
    const force = process.argv.includes('--force');
    const r = await runTick({ force });
    log.info('one-shot tick complete', { ...r });
    process.exit(r.status === 'error' ? 1 : 0);
  }

  // ── HTTP service for Railway health + manual triggers.
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ ok: true, ts: Date.now(), dryRun: cfg.DRY_RUN }));

  // Manual run trigger (useful for the dashboard "run now" button or
  // ad-hoc curl/PowerShell from a terminal). GET-or-POST so callers don't
  // have to set Content-Type for empty bodies.
  const runHandler = async (
    req: import('fastify').FastifyRequest<{ Querystring: { force?: string } }>,
    reply: import('fastify').FastifyReply,
  ) => {
    const force = req.query.force === 'true' || req.query.force === '1';
    log.info('manual /run triggered', { force });
    runTick({ force }).catch((e) =>
      log.error('manual tick failed', { error: (e as Error).message }),
    );
    reply.code(202);
    return { accepted: true, force };
  };
  app.get('/run', runHandler);
  app.post('/run', runHandler);

  app.get('/positions', async () => {
    // Lightweight inspection endpoint.
    const { getPool } = await import('./db.js');
    const { rows } = await getPool().query(
      `SELECT occ_symbol, underlying, "right", strike, expiration, side, direction,
              qty, entry_price, status, opened_at, close_reason
       FROM positions
       ORDER BY id DESC
       LIMIT 100`,
    );
    return { positions: rows };
  });

  // Spread-level P/L snapshot. Same math the manager uses for exits, exposed
  // on demand so you can see WHY a spread is or isn't triggering a close
  // without waiting for the next tick.
  app.get('/pnl', async () => {
    const { getPool } = await import('./db.js');
    const { listPositions } = await import('./alpaca.js');
    const { getOptionQuoteForLeg, resetQuoteCache } = await import('./quotes.js');
    const { dteFromExpiration } = await import('./market.js');
    const cfgLocal = loadConfig();

    type Row = {
      id: number;
      occ_symbol: string;
      underlying: string;
      right: 'call' | 'put';
      strike: string;
      expiration: string | Date;
      side: 'long' | 'short';
      direction: 'bullish' | 'bearish' | 'neutral';
      qty: number;
      entry_price: string | null;
      exit_target_pct: string | null;
      exit_stop_pct: string | null;
      trade_key: string | null;
    };
    const { rows } = await getPool().query<Row>(
      `SELECT id, occ_symbol, underlying, "right", strike, expiration, side, direction,
              qty, entry_price, exit_target_pct, exit_stop_pct, trade_key
       FROM positions
       WHERE status = 'open'
       ORDER BY trade_key, id`,
    );

    resetQuoteCache();
    const live = await listPositions();
    const liveBy = new Map(live.map((p) => [p.symbol, p]));

    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = r.trade_key ?? `legacy:${r.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    const expToString = (e: string | Date) =>
      e instanceof Date ? e.toISOString().slice(0, 10) : e.slice(0, 10);

    const out: unknown[] = [];
    for (const [tradeKey, legs] of groups) {
      let initialNet = 0;
      let closeNet = 0;
      let priceableAll = true;
      const legDetails: unknown[] = [];

      for (const leg of legs) {
        const lp = liveBy.get(leg.occ_symbol);
        const e = parseFloat(leg.entry_price ?? '0');
        const sign = leg.side === 'long' ? +1 : -1;
        initialNet += sign * e;

        const expStr = expToString(leg.expiration);
        const q = await getOptionQuoteForLeg({
          underlying: leg.underlying,
          right: leg.right,
          strike: parseFloat(leg.strike),
          expiration: expStr,
          side: leg.side,
          ratio: 1,
        });
        let closingPx: number | null = null;
        let priceSrc = '';
        if (q) {
          closingPx = leg.side === 'long' ? q.bid : q.ask;
          priceSrc = 'tradier';
        } else if (lp?.currentPrice && lp.currentPrice > 0) {
          closingPx = lp.currentPrice;
          priceSrc = 'alpaca-mark';
        } else {
          priceableAll = false;
        }
        if (closingPx !== null) closeNet += sign * closingPx;

        legDetails.push({
          occ_symbol: leg.occ_symbol,
          side: leg.side,
          qty: leg.qty,
          entry: e,
          closing_px: closingPx,
          price_source: priceSrc,
          alpaca_mark: lp?.currentPrice ?? null,
          alpaca_market_value: lp?.marketValue ?? null,
        });
      }

      const targetPct = legs[0]?.exit_target_pct ? parseFloat(legs[0].exit_target_pct) : null;
      const stopPct = legs[0]?.exit_stop_pct ? parseFloat(legs[0].exit_stop_pct) : null;
      const plRatio = priceableAll ? (closeNet - initialNet) / Math.abs(initialNet) : null;

      // Per-spread $ P/L (use the smallest leg qty as spread-units count;
      // every leg of an MLEG-opened spread should have the same qty anyway).
      const spreadUnits = Math.min(...legs.map((l) => Math.abs(l.qty)));
      const dollarPnL =
        priceableAll ? (closeNet - initialNet) * 100 * spreadUnits : null;

      const wouldTriggerStop =
        plRatio !== null && stopPct !== null && plRatio <= -stopPct;
      const wouldTriggerTarget =
        plRatio !== null && targetPct !== null && plRatio >= targetPct;

      let assignmentRisk: string | null = null;
      for (const leg of legs) {
        if (leg.side !== 'short') continue;
        try {
          const dte = dteFromExpiration(expToString(leg.expiration));
          if (dte <= cfgLocal.ASSIGNMENT_CLOSE_DTE) {
            assignmentRisk = `${leg.occ_symbol} DTE ${dte}`;
            break;
          }
        } catch {
          /* ignore */
        }
      }

      out.push({
        trade_key: tradeKey,
        underlying: legs[0]?.underlying,
        direction: legs[0]?.direction,
        legs_count: legs.length,
        spread_units: spreadUnits,
        initial_net: initialNet.toFixed(2),
        close_net: priceableAll ? closeNet.toFixed(2) : null,
        spread_type: initialNet > 0 ? 'debit' : 'credit',
        pl_ratio_pct: plRatio !== null ? (plRatio * 100).toFixed(1) : null,
        dollar_pnl: dollarPnL !== null ? dollarPnL.toFixed(2) : null,
        target_pct: targetPct,
        stop_pct: stopPct,
        would_trigger_stop: wouldTriggerStop,
        would_trigger_target: wouldTriggerTarget,
        would_trigger_assignment: assignmentRisk,
        legs: legDetails,
      });
    }

    // Sort by largest $ loss first so the bleeders are at the top.
    out.sort((a, b) => {
      const av = parseFloat((a as { dollar_pnl: string | null }).dollar_pnl ?? '0');
      const bv = parseFloat((b as { dollar_pnl: string | null }).dollar_pnl ?? '0');
      return av - bv;
    });

    return { snapshot_at: new Date().toISOString(), spreads: out };
  });

  // Inspect the most recent AI briefing — full prompt sent to Claude,
  // analysis text returned, and the normalized trades the worker derived.
  // Use ?id=N to fetch a specific briefing instead of the latest.
  app.get<{ Querystring: { id?: string } }>('/briefings/latest', async (req) => {
    const { getPool } = await import('./db.js');
    const id = req.query.id ? parseInt(req.query.id, 10) : null;
    const sql = id
      ? `SELECT id, tick_run_id, fetched_at, prompt, payload, parsed
           FROM briefings WHERE id = $1`
      : `SELECT id, tick_run_id, fetched_at, prompt, payload, parsed
           FROM briefings ORDER BY id DESC LIMIT 1`;
    const args = id ? [id] : [];
    const { rows } = await getPool().query(sql, args);
    if (rows.length === 0) return { error: 'no briefings yet' };
    const row = rows[0];
    return {
      id: row.id,
      tick_run_id: row.tick_run_id,
      fetched_at: row.fetched_at,
      prompt_chars: row.prompt?.length ?? 0,
      analysis_chars: row.payload?.analysis?.length ?? 0,
      trade_idea_count: row.parsed?.length ?? 0,
      // Full content (long — render in browser dev tools or a JSON viewer)
      prompt: row.prompt,
      analysis: row.payload?.analysis,
      ai_trade_ideas: row.payload?.aiTradeIdeas,
      normalized_trades: row.parsed,
    };
  });

  // Emergency: cancel every open options order at the broker. Used to
  // unstick the state when previous close orders are still working and
  // blocking new submissions / manual closes from the Alpaca UI.
  app.post('/admin/cancel-options-orders', async () => {
    const { listOpenOptionOrders, cancelOrder } = await import('./alpaca.js');
    const open = await listOpenOptionOrders();
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const o of open) {
      try {
        await cancelOrder(o.id);
        results.push({ id: o.id, ok: true });
      } catch (e) {
        results.push({ id: o.id, ok: false, error: (e as Error).message });
      }
    }
    log.warn('admin cancel-options-orders invoked', {
      attempted: open.length,
      cancelled: results.filter((r) => r.ok).length,
    });
    return { attempted: open.length, results };
  });

  // Force-close a single position (or all positions for an underlying) via
  // Alpaca's public DELETE /v2/positions API. Useful when the Alpaca UI is
  // 403'ing for unclear reasons — the public API typically goes through
  // even when the dashboard's internal API doesn't.
  app.post<{ Querystring: { occ_symbol?: string; underlying?: string } }>(
    '/admin/liquidate',
    async (req) => {
      const { occ_symbol, underlying } = req.query;
      if (!occ_symbol && !underlying) {
        return { error: 'pass ?occ_symbol=... or ?underlying=...' };
      }
      const { listPositions } = await import('./alpaca.js');
      const live = await listPositions();
      const targets = occ_symbol
        ? live.filter((p) => p.symbol === occ_symbol)
        : live.filter((p) => p.symbol.startsWith(underlying!.toUpperCase()));
      if (targets.length === 0) {
        return { error: 'no matching open positions at Alpaca', live_count: live.length };
      }

      const cfg = loadConfig();
      const results: { occ_symbol: string; ok: boolean; status?: number; body?: string }[] = [];
      for (const t of targets) {
        try {
          const res = await fetch(
            `${cfg.ALPACA_TRADING_BASE}/v2/positions/${encodeURIComponent(t.symbol)}?cancel_orders=true`,
            {
              method: 'DELETE',
              headers: {
                'APCA-API-KEY-ID': cfg.ALPACA_KEY_ID,
                'APCA-API-SECRET-KEY': cfg.ALPACA_SECRET_KEY,
                Accept: 'application/json',
              },
              signal: AbortSignal.timeout(15_000),
            },
          );
          const body = await res.text().catch(() => '');
          results.push({
            occ_symbol: t.symbol,
            ok: res.ok,
            status: res.status,
            body: body.slice(0, 300),
          });
        } catch (e) {
          results.push({ occ_symbol: t.symbol, ok: false, body: (e as Error).message });
        }
      }
      log.warn('admin liquidate invoked', {
        occ_symbol,
        underlying,
        attempted: targets.length,
        ok: results.filter((r) => r.ok).length,
      });
      return { attempted: targets.length, results };
    },
  );

  // Force-close a position via the worker's MLEG close path. Use this when
  // /admin/liquidate fails with "uncovered" or "insufficient buying power"
  // errors — those come from Alpaca closing legs one at a time and seeing
  // a momentary naked position. MLEG submits one atomic order that closes
  // every leg of the spread simultaneously, so the account never holds an
  // uncovered position and BP is netted.
  //
  // Use either:
  //   ?trade_key=<exact trade_key string>   — close one spread
  //   ?underlying=TSLA                       — close every open spread for ticker
  app.post<{ Querystring: { trade_key?: string; underlying?: string } }>(
    '/admin/close-trade',
    async (req) => {
      const tradeKey = req.query.trade_key;
      const underlying = req.query.underlying;
      if (!tradeKey && !underlying) {
        return { error: 'pass ?trade_key=... or ?underlying=...' };
      }

      const { getPool } = await import('./db.js');
      const { executeExits } = await import('./manager.js');

      let tradeKeys: string[];
      if (tradeKey) {
        tradeKeys = [tradeKey];
      } else {
        const r = await getPool().query<{ trade_key: string }>(
          `SELECT DISTINCT trade_key FROM positions
           WHERE status = 'open' AND trade_key IS NOT NULL AND underlying = $1`,
          [underlying!.toUpperCase()],
        );
        tradeKeys = r.rows.map((row) => row.trade_key);
      }

      if (tradeKeys.length === 0) {
        return { error: 'no open trades found for that key/underlying' };
      }

      const results: { trade_key: string; closed: number }[] = [];
      for (const tk of tradeKeys) {
        const r = await getPool().query(
          `SELECT * FROM positions WHERE trade_key = $1 AND status = 'open' LIMIT 1`,
          [tk],
        );
        if (r.rows.length === 0) continue;
        const row = r.rows[0]!;
        const closed = await executeExits(
          [
            {
              position: row,
              occSymbol: row.occ_symbol,
              qty: Math.abs(row.qty),
              reason: 'manual /admin/close-trade',
            },
          ],
          false,
        );
        results.push({ trade_key: tk, closed });
      }
      log.warn('admin close-trade invoked', { tradeKey, underlying, count: results.length });
      return { results };
    },
  );

  // Browser-friendly admin page. Lists every open spread with one-click
  // close buttons, a global "cancel all working orders" button, and a
  // manual "run tick" trigger. Avoids needing PowerShell/curl for routine
  // ops. No auth — the worker's public URL is the only protection, so
  // keep that URL private.
  app.get('/admin', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return ADMIN_HTML;
  });

  app.get('/runs', async () => {
    const { getPool } = await import('./db.js');
    const { rows } = await getPool().query(
      `SELECT id, started_at, finished_at, status, pv_usd,
              positions_open, closed_count, opened_count, skipped_reason, error_message
       FROM tick_runs
       ORDER BY id DESC
       LIMIT 50`,
    );
    return { runs: rows };
  });

  // ── Scheduler. We keep an internal cron rather than Railway's so the
  // service is a single always-on container, the schedule is config-driven,
  // and we can use the same /run endpoint to test manually.
  if (!cron.validate(cfg.TICK_CRON)) {
    log.error('invalid TICK_CRON', { value: cfg.TICK_CRON });
    process.exit(1);
  }
  cron.schedule(
    cfg.TICK_CRON,
    () => {
      log.info('cron fired', { schedule: cfg.TICK_CRON });
      runTick().catch((e) => log.error('cron tick failed', { error: (e as Error).message }));
    },
    { timezone: 'UTC' },
  );
  log.info('cron registered', { schedule: cfg.TICK_CRON, tz: 'UTC' });

  const port = Number(process.env.PORT) || cfg.PORT;
  await app.listen({ host: '0.0.0.0', port });
  log.info('worker up', { port, dryRun: cfg.DRY_RUN });
}

main().catch((e) => {
  // Print raw to stderr so the message survives any log-collector parsing.
  // Railway sometimes shows only msg text from JSON lines, so we duplicate
  // the failure as plain stderr text first.
  console.error('========== FATAL BOOT FAILURE ==========');
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  console.error('========================================');
  log.error('fatal', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});

// Best-effort graceful shutdown so in-flight queries / orders aren't truncated.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`signal received: ${sig}`);
    setTimeout(() => process.exit(0), 2_000);
  });
}

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>potatohedge worker — admin</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.5px; color: #555; }
  button { font: inherit; padding: 6px 12px; border: 1px solid #888; background: #f7f7f7; cursor: pointer; border-radius: 4px; }
  button:hover { background: #eee; }
  button.danger { background: #fee; border-color: #d44; color: #a00; }
  button.danger:hover { background: #fdd; }
  button.primary { background: #def; border-color: #48c; color: #036; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; }
  th { font-weight: 600; background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .gain { color: #060; }
  .loss { color: #a00; }
  .small { font-size: 12px; color: #666; }
  #log { background: #f4f4f4; border: 1px solid #ddd; padding: 8px 12px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; max-height: 240px; overflow: auto; white-space: pre-wrap; }
  .row-actions button { margin-right: 4px; }
</style>
</head>
<body>
<h1>potatohedge worker — admin</h1>
<div class="small" id="health">checking…</div>

<h2>Quick actions</h2>
<button class="primary" id="refresh">Refresh /pnl</button>
<button id="runTick">Force run tick (force=true)</button>
<button class="danger" id="cancelAll">Cancel all working option orders</button>

<h2>Open spreads</h2>
<table id="spreads">
  <thead><tr>
    <th>Underlying</th><th>Dir</th><th>Legs</th><th>Type</th>
    <th class="num">Initial</th><th class="num">Close</th><th class="num">P/L %</th><th class="num">$ P/L</th>
    <th class="num">Stop %</th><th>Triggers</th><th>Actions</th>
  </tr></thead>
  <tbody></tbody>
</table>

<h2>Activity</h2>
<div id="log">(idle)</div>

<script>
const $ = (sel) => document.querySelector(sel);
const log = (msg) => {
  const t = new Date().toISOString().slice(11, 19);
  const el = $("#log");
  el.textContent = (el.textContent === "(idle)" ? "" : el.textContent + "\\n") + t + "  " + msg;
  el.scrollTop = el.scrollHeight;
};

async function post(path) {
  log("POST " + path);
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const txt = await res.text();
    log("  → " + res.status + " " + txt.slice(0, 500));
    return { ok: res.ok, body: txt };
  } catch (e) {
    log("  → ERROR " + e.message);
    return { ok: false, body: e.message };
  }
}

async function loadPnl() {
  log("GET /pnl");
  const res = await fetch("/pnl");
  const j = await res.json();
  const tbody = $("#spreads tbody");
  tbody.innerHTML = "";
  if (!j.spreads || j.spreads.length === 0) {
    tbody.innerHTML = "<tr><td colspan=11 style=\\"text-align:center;color:#666;padding:24px\\">no open spreads</td></tr>";
    log("  → 0 open spreads");
    return;
  }
  let totalPnl = 0;
  for (const s of j.spreads) {
    const pnl = parseFloat(s.dollar_pnl ?? "0");
    if (Number.isFinite(pnl)) totalPnl += pnl;
    const triggers = [];
    if (s.would_trigger_stop) triggers.push("STOP");
    if (s.would_trigger_target) triggers.push("TARGET");
    if (s.would_trigger_assignment) triggers.push("ASSIGN");
    const cls = pnl >= 0 ? "gain" : "loss";
    const tk = encodeURIComponent(s.trade_key);
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td><b>\${s.underlying}</b></td>
      <td>\${s.direction}</td>
      <td>\${s.legs_count} × \${s.spread_units}</td>
      <td>\${s.spread_type}</td>
      <td class="num">\${s.initial_net}</td>
      <td class="num">\${s.close_net ?? "—"}</td>
      <td class="num \${cls}">\${s.pl_ratio_pct ?? "—"}%</td>
      <td class="num \${cls}">$\${s.dollar_pnl ?? "—"}</td>
      <td class="num">\${s.stop_pct ?? "—"}</td>
      <td>\${triggers.join(" ") || "—"}</td>
      <td class="row-actions">
        <button class="danger" data-tk="\${tk}">Close (MLEG)</button>
      </td>\`;
    tbody.appendChild(tr);
  }
  log("  → " + j.spreads.length + " spreads, total P/L $" + totalPnl.toFixed(0));
  for (const btn of document.querySelectorAll(".row-actions button")) {
    btn.addEventListener("click", async () => {
      if (!confirm("Close this spread via MLEG? This is irreversible.")) return;
      btn.disabled = true;
      await post("/admin/close-trade?trade_key=" + btn.dataset.tk);
      setTimeout(loadPnl, 1500);
    });
  }
}

async function loadHealth() {
  const res = await fetch("/health");
  const j = await res.json();
  $("#health").textContent = "service: " + (j.ok ? "up" : "down") + " · dryRun=" + j.dryRun + " · ts " + new Date(j.ts).toISOString();
}

$("#refresh").addEventListener("click", loadPnl);
$("#runTick").addEventListener("click", async () => {
  if (!confirm("Force a tick now? (force=true, bypasses market-hours check)")) return;
  await post("/run?force=true");
});
$("#cancelAll").addEventListener("click", async () => {
  if (!confirm("Cancel ALL working option orders at Alpaca?")) return;
  await post("/admin/cancel-options-orders");
  setTimeout(loadPnl, 1500);
});

loadHealth();
loadPnl();
</script>
</body>
</html>`;
