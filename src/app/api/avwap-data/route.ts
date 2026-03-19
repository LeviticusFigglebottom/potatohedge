import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 15;

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';

/**
 * Fetch with retry on 429 (rate limit) responses.
 * Polygon Options Starter allows 5 req/min — the main dashboard may
 * exhaust the budget before AVWAP requests fire.
 */
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.status === 429 && attempt < retries) {
      // Exponential backoff: 2s, 4s, 8s
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
      continue;
    }
    return response;
  }
  // Should never reach here, but satisfy TypeScript
  throw new Error('Retry exhausted');
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const ticker = searchParams.get('ticker');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const timespan = searchParams.get('timespan') || 'hour';
  const multiplier = searchParams.get('multiplier') || '1';

  if (!ticker || !from || !to) {
    return NextResponse.json({ error: 'ticker, from, and to are required' }, { status: 400 });
  }

  if (!POLYGON_API_KEY) {
    return NextResponse.json({ error: 'POLYGON_API_KEY is not configured' }, { status: 500 });
  }

  try {
    let allBars: unknown[] = [];
    let url: string | null = `https://api.polygon.io/v2/aggs/ticker/${ticker.toUpperCase()}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`;

    // Paginate if necessary
    while (url) {
      const fetchUrl: string = url;
      const response: Response = await fetchWithRetry(fetchUrl);
      if (!response.ok) {
        // Parse Polygon error into a clean message
        const errMsg = await parsePolygonError(response);
        return NextResponse.json({ error: errMsg }, { status: response.status });
      }
      const data = await response.json();
      if (data.results) allBars = allBars.concat(data.results);
      url = data.next_url ? `${data.next_url}&apiKey=${POLYGON_API_KEY}` : null;
    }

    return NextResponse.json({ bars: allBars, ticker: ticker.toUpperCase() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function parsePolygonError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const data = JSON.parse(text);
    if (data.error) return data.error;
    if (data.message) return data.message;
    return `Polygon API error (${response.status})`;
  } catch {
    return `Polygon API error (${response.status})`;
  }
}
