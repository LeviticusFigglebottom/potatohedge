import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron endpoint for the entropy engine.
 *
 * Schedule: "50 19,20 * * 1-5" (UTC) — fires at both 19:50 and 20:50 UTC
 * to cover 3:50pm ET in both EDT (UTC-4, Mar-Nov) and EST (UTC-5, Nov-Mar).
 *
 * Guards:
 * 1. Only runs if current ET hour is 15 (3pm) — skips the wrong UTC trigger
 * 2. Only runs on actual trading days (skips holidays)
 * 3. Engine itself deduplicates (won't run twice in same day)
 */
export async function GET(request: NextRequest) {
  // Verify cron authorization
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check if it's actually ~3:50pm ET right now (guard against wrong UTC slot)
  const now = new Date();
  const etHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
    10
  );
  if (etHour !== 15) {
    return NextResponse.json({
      success: true,
      status: 'skipped',
      message: `Not 3pm ET (currently ${etHour}:xx ET), skipping`,
    });
  }

  // Check if today is a trading day (not weekend/holiday)
  if (!isTradingDay(now)) {
    return NextResponse.json({
      success: true,
      status: 'skipped',
      message: 'Not a trading day (weekend or holiday)',
    });
  }

  try {
    const { runEntropyEngine } = await import('@/lib/entropy/engine');
    const result = await runEntropyEngine();
    console.log(`[entropy-cron] ${result.status}: ${result.message}`);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[entropy-cron] Error: ${message}`);
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
