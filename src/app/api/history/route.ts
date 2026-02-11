export const maxDuration = 15;

/**
 * History API — client read/write for persistent metric and flow history.
 *
 * GET /api/history?type=metrics&ticker=SPY&days=365
 * GET /api/history?type=flow&days=365
 * GET /api/history?type=flow&ticker=NVDA&days=365
 * GET /api/history?type=status  → returns which backends are configured
 *
 * POST /api/history  { type, ticker?, records[] }
 *   → Bulk sync from client localStorage to server (merge, dedup)
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadHistory, saveHistoryBulk, getPersistenceStatus, testConnection } from '@/lib/persistence';

function historyKey(type: string, ticker?: string): string {
  if (type === 'metrics' && ticker) return `optix:metrics:${ticker.toUpperCase()}`;
  if (type === 'flow' && ticker) return `optix:flow:${ticker.toUpperCase()}`;
  if (type === 'flow') return `optix:flow:market`;
  if (type === 'tracked-trades') return `optix:tracked-trades:all`;
  return '';
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const type = params.get('type');

  // Status check — tells client what's available + connectivity test
  if (type === 'status') {
    const status = getPersistenceStatus();
    const ticker = params.get('ticker');
    // If ticker provided, also return record counts
    if (ticker) {
      const [metricsData, flowData] = await Promise.all([
        loadHistory(historyKey('metrics', ticker), 365).catch(() => []),
        loadHistory('optix:flow:market', 365).catch(() => []),
      ]);
      return NextResponse.json({
        ...status,
        metricsRecords: metricsData.length,
        flowRecords: flowData.length,
        connected: await testConnection(),
      });
    }
    return NextResponse.json({ ...status, connected: await testConnection() });
  }

  if (!type || (type !== 'metrics' && type !== 'flow' && type !== 'tracked-trades')) {
    return NextResponse.json({ error: 'type must be "metrics", "flow", "tracked-trades", or "status"' }, { status: 400 });
  }

  const ticker = params.get('ticker') || undefined;
  const days = Math.min(parseInt(params.get('days') || '365', 10), 365);

  if (type === 'metrics' && !ticker) {
    return NextResponse.json({ error: 'ticker required for metrics history' }, { status: 400 });
  }

  const key = historyKey(type, ticker);
  if (!key) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  try {
    const data = await loadHistory(key, days);
    return NextResponse.json({ key, count: data.length, records: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, ticker, records } = body as {
      type: string;
      ticker?: string;
      records: Array<Record<string, unknown> & { date: string; timestamp: number }>;
    };

    if (!type || !records || !Array.isArray(records) || records.length === 0) {
      return NextResponse.json({ error: 'type and records[] required' }, { status: 400 });
    }

    if (type === 'metrics' && !ticker) {
      return NextResponse.json({ error: 'ticker required for metrics' }, { status: 400 });
    }

    const key = historyKey(type, ticker);
    if (!key) {
      return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
    }

    await saveHistoryBulk(key, records);
    return NextResponse.json({ ok: true, key, merged: records.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
