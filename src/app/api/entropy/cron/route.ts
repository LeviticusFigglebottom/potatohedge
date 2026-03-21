import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Log a cron invocation to Redis so the UI can display activity history. */
async function logCronActivity(entry: { timestamp: string; status: string; message: string; source: string }) {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) return;
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis({ url, token });
    const existing = await redis.get<typeof entry[]>('entropy:cron-log') || [];
    existing.unshift(entry);
    // Keep last 50 entries
    await redis.set('entropy:cron-log', JSON.stringify(existing.slice(0, 50)));
  } catch {
    // Non-critical — don't let logging failures break the cron
  }
}

/**
 * Vercel Cron endpoint for the entropy engine.
 *
 * Schedule: "5 21 * * 1-5" (UTC) — 21:05 UTC daily Mon-Fri.
 * This maps to ~4:05pm ET (EST) or ~5:05pm ET (EDT) — both are post-close.
 * Using post-close data is intentional: volume is finalized, bid/ask reflect
 * closing values, and the engine computes its own IV/greeks from mid prices.
 *
 * Also callable via GitHub Actions or manual trigger for reliability.
 *
 * Guards:
 * 1. Only runs on actual trading days (skips weekends + holidays)
 * 2. Engine itself deduplicates (won't run twice in same day)
 */
export async function GET(request: NextRequest) {
  // Verify cron authorization (Vercel sends this header for cron jobs)
  // Also accept GitHub Actions triggers with the same secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Detect source from headers
  const source = request.headers.get('user-agent')?.includes('github') ? 'github-actions'
    : request.headers.get('x-vercel-cron') ? 'vercel-cron'
    : 'manual';

  const now = new Date();
  const timestamp = now.toISOString();

  // Check if today is a trading day (not weekend/holiday)
  if (!isTradingDay(now)) {
    const result = {
      success: true,
      status: 'skipped',
      message: 'Not a trading day (weekend or holiday)',
    };
    await logCronActivity({ timestamp, status: result.status, message: result.message, source });
    return NextResponse.json(result);
  }

  try {
    const { runEntropyEngine } = await import('@/lib/entropy/engine');
    const result = await runEntropyEngine();
    console.log(`[entropy-cron] ${result.status}: ${result.message}`);
    await logCronActivity({ timestamp, status: result.status, message: result.message, source });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[entropy-cron] Error: ${message}`);
    await logCronActivity({ timestamp, status: 'error', message, source });
    return NextResponse.json(
      { success: false, status: 'error', message },
      { status: 500 }
    );
  }
}

/**
 * Check if a date falls on a US equity market trading day.
 * Handles weekends and major US holidays.
 */
function isTradingDay(date: Date): boolean {
  const etStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [y, m, d] = etStr.split('-').map(Number);
  const etDate = new Date(y, m - 1, d);
  const dow = etDate.getDay();

  // Weekend
  if (dow === 0 || dow === 6) return false;

  // Fixed holidays
  const mmdd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const fixedHolidays = [
    '01-01', // New Year's Day
    '06-19', // Juneteenth
    '07-04', // Independence Day
    '12-25', // Christmas
  ];
  if (fixedHolidays.includes(mmdd)) return false;

  // Floating holidays
  // MLK Day: 3rd Monday of January
  if (m === 1 && dow === 1 && d >= 15 && d <= 21) return false;
  // Presidents' Day: 3rd Monday of February
  if (m === 2 && dow === 1 && d >= 15 && d <= 21) return false;
  // Memorial Day: last Monday of May
  if (m === 5 && dow === 1 && d >= 25) return false;
  // Labor Day: 1st Monday of September
  if (m === 9 && dow === 1 && d <= 7) return false;
  // Thanksgiving: 4th Thursday of November
  if (m === 11 && dow === 4 && d >= 22 && d <= 28) return false;

  // Good Friday: 2 days before Easter Sunday (approximate)
  const easter = computeEaster(y);
  const goodFriday = new Date(easter);
  goodFriday.setDate(goodFriday.getDate() - 2);
  if (m === goodFriday.getMonth() + 1 && d === goodFriday.getDate()) return false;

  return true;
}

/**
 * Compute Easter Sunday for a given year using the Anonymous Gregorian algorithm.
 */
function computeEaster(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
