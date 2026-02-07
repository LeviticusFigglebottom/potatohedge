import { NextRequest, NextResponse } from 'next/server';
import { getHistory } from '@/lib/providers/tradier';
import type { Interval } from '@/types/market';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  const interval = (request.nextUrl.searchParams.get('interval') || '1D') as Interval;
  const start = request.nextUrl.searchParams.get('start') || undefined;
  const end = request.nextUrl.searchParams.get('end') || undefined;

  if (!symbol) {
    return NextResponse.json({ error: 'symbol parameter required' }, { status: 400 });
  }

  try {
    const history = await getHistory(symbol.toUpperCase(), interval, start, end);
    return NextResponse.json(history);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
