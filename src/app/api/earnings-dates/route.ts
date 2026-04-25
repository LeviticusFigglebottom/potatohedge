import { NextRequest, NextResponse } from 'next/server';
import { getHistory } from '@/lib/providers/tradier';

export const maxDuration = 15;

const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';

interface AnchorDate {
  date: string;
  label: string;
  type: string;
}

interface DailyBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Fetch with retry on 429 (rate limit) responses.
 */
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.status === 429 && attempt < retries) {
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
      continue;
    }
    return response;
  }
  throw new Error('Retry exhausted');
}

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get('ticker');
  if (!ticker) {
    return NextResponse.json({ error: 'ticker required' }, { status: 400 });
  }

  try {
    const earningsDates: AnchorDate[] = [];
    const structureAnchors: AnchorDate[] = [];

    // Fetch recent earnings announcements
    if (POLYGON_API_KEY) {
      try {
        const url = `https://api.polygon.io/vX/reference/financials?ticker=${ticker.toUpperCase()}&limit=8&sort=period_of_report_date&order=desc&apiKey=${POLYGON_API_KEY}`;
        const response = await fetchWithRetry(url);
        if (response.ok) {
          const data = await response.json();
          const results = data.results || [];
          for (const item of results) {
            const date = item.filing_date || item.period_of_report_date;
            if (date) {
              earningsDates.push({
                date,
                label: `Earnings ${item.fiscal_period || ''} ${item.fiscal_year || ''}`.trim(),
                type: 'earnings',
              });
            }
          }
        }
      } catch {
        // Earnings data is supplementary — don't fail the whole request
      }
    }

    // Fetch 52-week high/low dates from daily aggregates.
    // Polygon /v2/aggs is preferred (faster, longer adjusted history), but if
    // the key is missing or the subscription is deactivated we fall back to
    // Tradier daily history which carries ~1 year of bars by default.
    let dailyBars: DailyBar[] = [];
    let polygonOk = false;
    if (POLYGON_API_KEY) {
      try {
        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const dailyUrl = `https://api.polygon.io/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${startDate}/${endDate}?adjusted=true&sort=asc&limit=365&apiKey=${POLYGON_API_KEY}`;
        const dailyRes = await fetchWithRetry(dailyUrl);
        if (dailyRes.ok) {
          const dailyData = await dailyRes.json();
          dailyBars = dailyData.results || [];
          polygonOk = dailyBars.length > 0;
        }
      } catch {
        // fall through to Tradier
      }
    }
    if (!polygonOk) {
      try {
        const ohlcv = await getHistory(ticker.toUpperCase(), '1D');
        // Tradier OHLCV uses unix seconds in `time`; convert to ms for parity
        // with the Polygon shape used downstream.
        dailyBars = ohlcv.map((b) => ({
          t: b.time * 1000,
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
        }));
      } catch {
        // Both providers failed — structureAnchors will only have YTD.
      }
    }

    if (dailyBars.length > 0) {
      // Compute median close for outlier detection
      const closes = dailyBars.map(b => b.c).sort((a, b) => a - b);
      const medianClose = closes[Math.floor(closes.length / 2)];

      // Find 52-week high using close prices (not wicks) to avoid flash-crash outliers.
      // Wicks can be extreme intraday anomalies (e.g., SPY flash to $69) that
      // produce misleading structural anchors.
      let highBar = dailyBars[0];
      let lowBar = dailyBars[0];
      for (const bar of dailyBars) {
        if (bar.c > highBar.c) highBar = bar;
        if (bar.c < lowBar.c) lowBar = bar;
      }

      // Only include if values are within a reasonable range of the median
      // (filters out clearly erroneous data points)
      if (highBar && highBar.c > 0 && highBar.c < medianClose * 3) {
        structureAnchors.push({
          date: new Date(highBar.t).toISOString().slice(0, 10),
          label: `52-Week High ($${highBar.c.toFixed(2)})`,
          type: '52w_high',
        });
      }
      if (lowBar && lowBar.c > 0 && lowBar.c > medianClose * 0.2) {
        structureAnchors.push({
          date: new Date(lowBar.t).toISOString().slice(0, 10),
          label: `52-Week Low ($${lowBar.c.toFixed(2)})`,
          type: '52w_low',
        });
      }
    }

    // YTD anchor — always available, no API call needed
    const ytdDate = `${new Date().getFullYear()}-01-01`;
    structureAnchors.push({
      date: ytdDate,
      label: 'YTD (Jan 1)',
      type: 'ytd',
    });

    return NextResponse.json({
      anchors: [...earningsDates, ...structureAnchors].sort((a, b) =>
        b.date.localeCompare(a.date)
      ),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
