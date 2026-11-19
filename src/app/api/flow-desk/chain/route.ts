import { NextRequest } from 'next/server';
import { getChain, resolveMode } from '@/lib/flowdesk/providers';
import { cleanSymbols, respond } from '../_util';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const [symbol] = cleanSymbols(p.get('symbol'), 1);
  return respond(() => getChain(symbol ?? 'SPY', resolveMode(p.get('mode'))));
}
