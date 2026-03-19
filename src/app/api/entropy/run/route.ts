import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for chain fetching + computation

export async function POST() {
  try {
    // Dynamic import to avoid bundling issues with better-sqlite3
    const { runEntropyEngine } = await import('@/lib/entropy/engine');
    const result = await runEntropyEngine();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, status: 'error', message, date: new Date().toISOString().slice(0, 10) },
      { status: 500 }
    );
  }
}
