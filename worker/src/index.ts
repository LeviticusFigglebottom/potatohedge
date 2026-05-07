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
