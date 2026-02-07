import { NextRequest, NextResponse } from 'next/server';
import { fetchEquityBars } from '@/lib/providers/equityBars';
import { getQuote } from '@/lib/providers/tradier';
import { computeHistoricalVolatility } from '@/lib/math/analytics';
import { computeCorrelations, getSectorETF, type CorrelationResult } from '@/lib/math/correlations';
import { getStockMeta } from '@/lib/stockUniverse';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const ticker = symbol.toUpperCase();

  try {
    // Look up sector info
    const meta = getStockMeta(ticker);
    const sectorInfo = meta ? getSectorETF(meta.sector) : null;

    // Fetch historical bars: stock, SPY, and optionally sector ETF
    // Use 500 days for meaningful statistical analysis
    const fetches: Promise<{ key: string; bars: Awaited<ReturnType<typeof fetchEquityBars>> }>[] = [
      fetchEquityBars(ticker, 500).then(bars => ({ key: 'stock', bars })),
      fetchEquityBars('SPY', 500).then(bars => ({ key: 'spy', bars })),
    ];

    if (sectorInfo && sectorInfo.etf !== ticker) {
      fetches.push(
        fetchEquityBars(sectorInfo.etf, 500).then(bars => ({ key: 'sector', bars }))
      );
    }

    // Also fetch current IV data
    const quotePromise = getQuote(ticker).catch(() => null);

    const [barResults, quote] = await Promise.all([
      Promise.all(fetches),
      quotePromise,
    ]);

    const stockBars = barResults.find(r => r.key === 'stock')?.bars || [];
    const spyBars = barResults.find(r => r.key === 'spy')?.bars || [];
    const sectorBars = barResults.find(r => r.key === 'sector')?.bars || null;

    if (stockBars.length < 30) {
      return NextResponse.json({ error: 'Insufficient historical data' }, { status: 500 });
    }

    // Compute current HV for vol pricing context
    const closes = stockBars.map(b => b.c).reverse();
    const hvCurrent = computeHistoricalVolatility(closes, 20);

    // We don't have live IV in this endpoint, pass 0 if unavailable
    // The caller (dashboard store) can enrich with snapshot IV data on the client side
    const currentIV = 0; // Will be enriched by the store if snapshot data is available

    const result: CorrelationResult = computeCorrelations(
      ticker,
      stockBars,
      spyBars,
      sectorBars,
      sectorInfo,
      currentIV,
      hvCurrent,
    );

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[correlations] ${ticker} error:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
