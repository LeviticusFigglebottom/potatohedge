import { NextRequest, NextResponse } from 'next/server';
import { resolveMode, sessionInfo, sourceStatus } from '@/lib/flowdesk/providers';
import { FLOW_UNIVERSE } from '@/lib/flowdesk/demo';
import { summaryBackend } from '@/lib/flowdesk/summaryStore';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const mode = resolveMode(req.nextUrl.searchParams.get('mode'));
  return NextResponse.json({ mode, ...sessionInfo(mode), sources: sourceStatus(), universe: FLOW_UNIVERSE, summaryBackend: summaryBackend() });
}
