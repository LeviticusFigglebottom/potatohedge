import { NextRequest, NextResponse } from 'next/server';
import { getExpirations } from '@/lib/providers/tradier';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol parameter required' }, { status: 400 });
  }

  try {
    const expirations = await getExpirations(symbol.toUpperCase());
    return NextResponse.json(expirations);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
