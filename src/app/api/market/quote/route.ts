import { NextRequest, NextResponse } from 'next/server';
import { getQuote } from '@/lib/providers/tradier';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol parameter required' }, { status: 400 });
  }

  try {
    const quote = await getQuote(symbol.toUpperCase());
    return NextResponse.json(quote);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
