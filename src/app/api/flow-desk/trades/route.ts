import { NextRequest } from 'next/server';
import { getTrades, resolveMode } from '@/lib/flowdesk/providers';
import { cleanSymbols, respond } from '../_util';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const symbols = cleanSymbols(p.get('symbols'));
  const days = Number(p.get('days') ?? 1) || 1;
  return respond(() => getTrades(symbols.length ? symbols : ['SPY'], days, resolveMode(p.get('mode'))));
}
