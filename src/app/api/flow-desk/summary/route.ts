import { NextRequest, NextResponse } from 'next/server';
import { getTrades, resolveMode, sessionInfo } from '@/lib/flowdesk/providers';
import { FLOW_UNIVERSE } from '@/lib/flowdesk/demo';
import { dailyRootSummary, enrich } from '@/lib/flowdesk/flow/aggregate';
import { listSummaries, summaryBackend, upsertSummaries } from '@/lib/flowdesk/summaryStore';
import { DEFAULT_FLOW_SETTINGS, isNoSource } from '@/lib/flowdesk/types';
import { etParts, weekdaysEnding } from '@/lib/flowdesk/time';
import { cleanSymbols } from '../_util';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const mode = resolveMode(p.get('mode'));
  try {
    const rows = await listSummaries({ root: p.get('root'), days: Number(p.get('days') ?? 30) || 30, source: mode });
    return NextResponse.json({ data: rows, backend: summaryBackend() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, backend: summaryBackend() }, { status: 502 });
  }
}

/** Compute today's (and optionally the prior N sessions') per-root summary and persist it. */
export async function POST(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const mode = resolveMode(p.get('mode'));
  const body = (await req.json().catch(() => ({}))) as { roots?: string[]; days?: number };
  const roots = cleanSymbols((body.roots ?? FLOW_UNIVERSE).join(','));
  const days = Math.max(1, Math.min(5, Number(body.days ?? 1)));
  // Optional guard for live writes (they trigger provider calls): set FLOW_SUMMARY_TOKEN and send it as a Bearer token.
  const token = process.env.FLOW_SUMMARY_TOKEN;
  if (token && mode === 'live' && req.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized: live summary writes require FLOW_SUMMARY_TOKEN' }, { status: 401 });
  }
  try {
    const trades = await getTrades(roots, days, mode);
    if (isNoSource(trades)) return NextResponse.json(trades);
    const enriched = enrich(trades, DEFAULT_FLOW_SETTINGS);
    const { session } = sessionInfo(mode);
    const rows = weekdaysEnding(session, days).flatMap((date) =>
      dailyRootSummary(enriched.filter((t) => etParts(t.time).date === date), date));
    const n = await upsertSummaries(rows, mode);
    return NextResponse.json({ data: rows, written: n, backend: summaryBackend() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
