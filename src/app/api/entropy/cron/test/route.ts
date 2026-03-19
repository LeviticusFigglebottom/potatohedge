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

  // 5. SQLite + Redis data integrity
  // On Vercel, SQLite lives in ephemeral /tmp per-instance. The real data lives in Redis
  // and gets restored to SQLite on each cold start. So we check Redis data directly.
  try {
    const { hasRedisData } = await import('@/lib/entropy/persistence');
    const hasData = await hasRedisData();
    if (hasData) {
      t('Data persistence').pass('Redis has entropy data — will restore to SQLite on cold start');
    } else {
      t('Data persistence').warn('Redis is empty — engine has not run yet or was purged');
    }
  } catch (err) {
    t('Data persistence').fail(`${err instanceof Error ? err.message : 'Check failed'}`);
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
