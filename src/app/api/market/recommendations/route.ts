/**
 * STRIPPED TO BARE MINIMUM for debugging.
 * If this STILL returns 500 HTML, the issue is Vercel-specific for this path.
 * Full implementation moved to /api/market/recs
 */
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol') || 'NONE';
  return NextResponse.json({
    test: true,
    symbol,
    timestamp: Date.now(),
    message: 'Recommendations route alive — bare minimum version',
  });
}
