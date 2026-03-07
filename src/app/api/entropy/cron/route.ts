import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron endpoint for the entropy engine.
 * Runs at 3:50pm ET (19:50 UTC) Mon-Fri via vercel.json cron config.
 *
 * This mirrors the Python cron: 50 15 * * 1-5
 */
export async function GET(request: NextRequest) {
  // Verify cron authorization (Vercel sends this header for cron jobs)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  // In production, verify the request is from Vercel cron
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
