import { NextResponse } from 'next/server';
import { isNoSource } from '@/lib/flowdesk/types';

/** Uniform JSON response: NoSource → 200 with {noSource}, errors → 502 with a message (no secrets). */
export async function respond<T>(fn: () => Promise<T>) {
  try {
    const data = await fn();
    if (isNoSource(data)) return NextResponse.json(data);
    return NextResponse.json({ data });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    // Messages never contain keys: providers send keys in headers, not URLs.
    return NextResponse.json({ error: message.replace(/apiKey=[^&\s]+/gi, 'apiKey=***') }, { status: 502 });
  }
}

export function cleanSymbols(raw: string | null, max = 20): string[] {
  return (raw ?? '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z.:]{1,12}$/.test(s)).slice(0, max);
}
