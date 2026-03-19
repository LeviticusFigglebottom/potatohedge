import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/entropy/cron/test — Dry-run diagnostic for the cron pipeline.
 *
 * Tests every component the cron job depends on without actually running the engine.
 * Returns a detailed checklist of what passed/failed so you can debug from the UI.
 */
export async function GET() {
  const checks: {
    name: string;
    status: 'pass' | 'fail' | 'warn';
    detail: string;
    ms?: number;
  }[] = [];

  const t = (label: string) => {
    const start = Date.now();
    return {
      pass: (detail: string) => checks.push({ name: label, status: 'pass', detail, ms: Date.now() - start }),
      fail: (detail: string) => checks.push({ name: label, status: 'fail', detail, ms: Date.now() - start }),
      warn: (detail: string) => checks.push({ name: label, status: 'warn', detail, ms: Date.now() - start }),
    };
  };

  // 1. CRON_SECRET configured?
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && cronSecret.length > 0) {
    t('CRON_SECRET').pass(`Set (${cronSecret.length} chars)`);
  } else {
    t('CRON_SECRET').fail('Not set — GitHub Actions and Vercel cron will 401');
  }

  // 2. TRADIER_API_KEY configured?
  const tradierKey = process.env.TRADIER_API_KEY;
  if (tradierKey && tradierKey.length > 0) {
    t('TRADIER_API_KEY').pass(`Set (${tradierKey.length} chars)`);
  } else {
    t('TRADIER_API_KEY').fail('Not set — engine cannot fetch options chain');
  }

  // 3. Tradier API reachable? (lightweight /markets/clock call)
  if (tradierKey) {
    try {
      const res = await fetch('https://api.tradier.com/v1/markets/clock', {
        headers: {
          Authorization: `Bearer ${tradierKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const json = await res.json();
        const state = json?.clock?.state || 'unknown';
        t('Tradier API').pass(`Reachable — market state: ${state}`);
      } else {
        t('Tradier API').fail(`HTTP ${res.status}: ${res.statusText}`);
      }
    } catch (err) {
      t('Tradier API').fail(`Network error: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  } else {
    t('Tradier API').warn('Skipped — no API key');
  }

  // 4. Redis connectivity
  try {
    const { hasRedisData } = await import('@/lib/entropy/persistence');
    const has = await hasRedisData();
    t('Redis (Upstash)').pass(has ? 'Connected — has existing data' : 'Connected — empty');
  } catch (err) {
    t('Redis (Upstash)').fail(`${err instanceof Error ? err.message : 'Connection failed'}`);
  }

  // 5. SQLite writable
  try {
    // Resolve DB path same way the main route does
    const path = await import('path');
    const fs = await import('fs');
    let dbPath = process.env.ENGINE_DB_PATH || '';
    if (!dbPath) {
      const cwdData = path.join(process.cwd(), 'data');
      try {
        if (!fs.existsSync(cwdData)) fs.mkdirSync(cwdData, { recursive: true });
        dbPath = path.join(cwdData, 'entropy_engine.db');
      } catch {
        dbPath = path.join('/tmp', 'entropy-data', 'entropy_engine.db');
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const row = db.prepare('SELECT COUNT(*) as cnt FROM entropy_history').get() as { cnt: number };
    db.close();
    t('SQLite').pass(`Writable — ${row.cnt} history rows`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Cannot open/write';
    if (msg.includes('no such table')) {
      t('SQLite').warn('DB exists but no tables yet — engine has not run');
    } else {
      t('SQLite').fail(msg);
    }
  }

  // 6. Is today a trading day?
  const now = new Date();
  const etStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [y, m, d] = etStr.split('-').map(Number);
  const etDate = new Date(y, m - 1, d);
  const dow = etDate.getDay();
  const isWeekend = dow === 0 || dow === 6;
  if (isWeekend) {
    t('Trading day').warn(`${etStr} is a weekend — cron will skip`);
  } else {
    t('Trading day').pass(`${etStr} is a weekday (day-of-week: ${dow})`);
  }

  // 7. Engine module importable?
  try {
    const { runEntropyEngine } = await import('@/lib/entropy/engine');
    if (typeof runEntropyEngine === 'function') {
      t('Engine module').pass('Imported successfully');
    } else {
      t('Engine module').fail('runEntropyEngine is not a function');
    }
  } catch (err) {
    t('Engine module').fail(`Import error: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  // 8. DEPLOY_URL set? (for GitHub Actions to know where to POST)
  const deployUrl = process.env.DEPLOY_URL;
  if (deployUrl) {
    t('DEPLOY_URL').pass(deployUrl);
  } else {
    t('DEPLOY_URL').warn('Not set — GitHub Actions will use default URL');
  }

  // Summary
  const passed = checks.filter(c => c.status === 'pass').length;
  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;

  return NextResponse.json({
    summary: failed === 0
      ? `All clear — ${passed} passed, ${warned} warnings`
      : `${failed} FAILED, ${passed} passed, ${warned} warnings`,
    allPassed: failed === 0,
    checks,
    timestamp: new Date().toISOString(),
  });
}
