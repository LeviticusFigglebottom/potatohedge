import { NextRequest, NextResponse } from 'next/server';
import { getOptionsChain } from '@/lib/providers/tradier';

export const maxDuration = 15;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  const expiration = request.nextUrl.searchParams.get('expiration');

  if (!symbol || !expiration) {
    return NextResponse.json({ error: 'symbol and expiration parameters required' }, { status: 400 });
  }

  try {
    const chain = await getOptionsChain(symbol.toUpperCase(), expiration);
    return NextResponse.json(chain);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
