import { NextRequest, NextResponse } from 'next/server';
import { logErr, logWarn } from '@/lib/errorLogger';

/**
 * GET /api/tracker/prices?symbols=SPY250214C00605000,SPY250214P00600000&underlying=SPY
 *
 * Fetches live option prices for tracked trade legs using the production Tradier API.
 * Also returns the current underlying spot price for P/L calculations.
 */

const FETCH_TIMEOUT = 8000;

export async function GET(request: NextRequest) {
  const token = process.env.TRADIER_API_KEY;
  if (!token) {
    return NextResponse.json({ error: 'TRADIER_API_KEY not configured' }, { status: 500 });
  }

  const symbols = request.nextUrl.searchParams.get('symbols');
  const underlying = request.nextUrl.searchParams.get('underlying');

  if (!symbols) {
    return NextResponse.json({ error: 'symbols parameter required' }, { status: 400 });
  }

  const baseUrl = process.env.TRADIER_SANDBOX === 'true'
    ? 'https://sandbox.tradier.com/v1'
    : 'https://api.tradier.com/v1';

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  };

  try {
    // Fetch option quotes and underlying quote in parallel
    const allSymbols = underlying ? `${symbols},${underlying}` : symbols;

    const res = await fetch(
      `${baseUrl}/markets/quotes?symbols=${encodeURIComponent(allSymbols)}&greeks=false`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logWarn('tradier', `Quote fetch error: ${res.status}`, { symbols, status: res.status });
      return NextResponse.json({ error: `Tradier error: ${res.status} ${body.slice(0, 200)}` }, { status: 502 });
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      logErr('tradier', `JSON parse error on quote response`, { symbols }, e);
      return NextResponse.json({ error: `Tradier JSON parse error: ${e instanceof Error ? e.message : 'malformed response'}` }, { status: 502 });
    }
    const rawQuotes = data.quotes?.quote;
    if (!rawQuotes) {
      return NextResponse.json({ quotes: {}, spot: null });
    }

    const arr = Array.isArray(rawQuotes) ? rawQuotes : [rawQuotes];

    const quotes: Record<string, { bid: number; ask: number; mid: number; last: number }> = {};
    let spot: number | null = null;

    for (const q of arr) {
      if (!q.symbol) continue;

      if (underlying && q.symbol.toUpperCase() === underlying.toUpperCase()) {
        spot = q.last ?? q.bid ?? 0;
        continue;
      }

      const bid = q.bid ?? 0;
      const ask = q.ask ?? 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : q.last ?? 0;
      quotes[q.symbol] = { bid, ask, mid, last: q.last ?? 0 };
    }

    return NextResponse.json({ quotes, spot });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logErr('tradier', `Tracker prices route error: ${msg}`, { symbols, underlying }, err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
