import { NextRequest } from 'next/server';
import { getBars, resolveMode } from '@/lib/flowdesk/providers';
import { CHART_INTERVALS, type ChartInterval } from '@/lib/flowdesk/indicators/mtf';
import { cleanSymbols, respond } from '../_util';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const [symbol] = cleanSymbols(p.get('symbol'), 1);
  const raw = p.get('interval') as ChartInterval;
  const interval = CHART_INTERVALS.includes(raw) ? raw : '5m';
  return respond(() => getBars(symbol ?? 'SPY', interval, resolveMode(p.get('mode'))));
}
