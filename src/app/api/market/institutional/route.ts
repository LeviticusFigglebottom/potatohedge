import { NextRequest, NextResponse } from 'next/server';
import { getShortInterestBulk, getShortVolumeBulk } from '@/lib/providers/polygon';
import { getMarketSwapSummary, getSwapDataForTicker } from '@/lib/providers/dtcc';
import {
  fetchRegSHOWithDate,
  fetchShortInterestWithDate,
  fetchShortSaleVolumeWithDate,
  type ShortVolumeData,
} from '@/lib/providers/finra';

export const maxDuration = 15;

/** Race a promise against a hard deadline */
function raceTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);
}

export async function GET(req: NextRequest) {
  try {
    const ticker = req.nextUrl.searchParams.get('ticker')?.toUpperCase() || '';

    // ── Per-ticker data (parallel) ──
    const tickerPromises = ticker ? [
      // SI: last 2 settlement dates for this ticker (to compute change %)
      raceTimeout(
        getShortInterestBulk({
          ticker,
          settlementDateGte: daysAgo(90),
          limit: 2,
          sort: 'settlement_date',
          order: 'desc',
        }).catch(() => []),
        5000, [],
      ),
      // SV: last 10 trading days for this ticker
      raceTimeout(
        getShortVolumeBulk({
          ticker,
          dateGte: daysAgo(14),
          limit: 10,
          sort: 'date',
          order: 'desc',
        }).catch(() => []),
        5000, [],
      ),
      // Swap data for this ticker
      raceTimeout(
        getSwapDataForTicker(ticker).catch(() => null),
        4000, null,
      ),
    ] : [Promise.resolve([]), Promise.resolve([]), Promise.resolve(null)];

    // ── Market-wide data (parallel with ticker data) ──
    const emptySwap = {
      totalMaturitiesToday: 0, totalNotionalToday: 0,
      totalMaturitiesWeek: 0, totalNotionalWeek: 0,
      topMaturities: [] as { symbol: string; count: number; notional: number }[],
      asOf: '',
    };
    const emptyRegSHO = { tickers: new Set<string>(), asOf: '' };
    const emptySI = { data: new Map<string, { daysToCover: number; shortInterest: number; previousShortInterest: number; changePercent: number; avgDailyVolume: number }>(), asOf: '' };
    const emptySV = { data: new Map<string, ShortVolumeData>(), asOf: '' };

    const marketPromises = [
      raceTimeout(getMarketSwapSummary().catch(() => emptySwap), 5000, emptySwap),
      raceTimeout(fetchRegSHOWithDate().catch(() => emptyRegSHO), 4000, emptyRegSHO),
      raceTimeout(fetchShortInterestWithDate().catch(() => emptySI), 5000, emptySI),
      raceTimeout(fetchShortSaleVolumeWithDate().catch(() => emptySV), 5000, emptySV),
    ];

    // Run everything in parallel
    const [tickerSIRaw, tickerSVRaw, tickerSwapsRaw, swapSummary, regSHOResult, siResult, svResult] =
      await Promise.all([...tickerPromises, ...marketPromises]);

    // ── Process per-ticker SI ──
    const tickerSIItems = tickerSIRaw as Awaited<ReturnType<typeof getShortInterestBulk>>;
    let tickerSI = null;
    if (tickerSIItems.length > 0) {
      const current = tickerSIItems[0];
      const previous = tickerSIItems.length > 1 ? tickerSIItems[1] : null;
      const changePercent = previous && previous.short_interest > 0
        ? ((current.short_interest - previous.short_interest) / previous.short_interest) * 100
        : 0;
      tickerSI = {
        shortInterest: current.short_interest,
        daysToCover: current.days_to_cover,
        avgDailyVolume: current.avg_daily_volume,
        settlementDate: current.settlement_date,
        previousSI: previous?.short_interest ?? 0,
        changePercent: Math.round(changePercent * 10) / 10,
      };
    }

    // ── Process per-ticker SV history ──
    const tickerSVItems = tickerSVRaw as Awaited<ReturnType<typeof getShortVolumeBulk>>;
    const tickerSVHistory = tickerSVItems.map(item => ({
      date: item.date,
      shortVolume: item.short_volume,
      totalVolume: item.total_volume,
      shortRatio: Math.round(item.short_volume_ratio * 1000) / 1000,
    }));

    // ── Process per-ticker swaps ──
    const tickerSwaps = tickerSwapsRaw as Awaited<ReturnType<typeof getSwapDataForTicker>>;

    // ── Process market-wide data ──
    const swapSummaryData = swapSummary as Awaited<ReturnType<typeof getMarketSwapSummary>>;
    const regSHO = regSHOResult as Awaited<ReturnType<typeof fetchRegSHOWithDate>>;
    const si = siResult as Awaited<ReturnType<typeof fetchShortInterestWithDate>>;
    const sv = svResult as Awaited<ReturnType<typeof fetchShortSaleVolumeWithDate>>;

    const regSHOList = Array.from(regSHO.tickers).filter(s => /^[A-Z]+$/.test(s)).sort();

    // SI screener
    const siScreener: { symbol: string; daysToCover: number; shortInterest: number; avgDailyVolume: number }[] = [];
    for (const [sym, data] of si.data) {
      if (data.daysToCover >= 3 && data.daysToCover <= 100 && data.shortInterest >= 50000 && data.avgDailyVolume >= 1000) {
        siScreener.push({ symbol: sym, daysToCover: data.daysToCover, shortInterest: data.shortInterest, avgDailyVolume: data.avgDailyVolume });
      }
    }
    siScreener.sort((a, b) => b.daysToCover - a.daysToCover);

    // SV screener
    const svScreener: { symbol: string; shortVolume: number; totalVolume: number; shortRatio: number }[] = [];
    for (const [sym, data] of sv.data) {
      if (data.shortRatio > 0.40 && data.totalVolume > 100000) {
        svScreener.push({ symbol: sym, shortVolume: data.shortVolume, totalVolume: data.totalVolume, shortRatio: data.shortRatio });
      }
    }
    svScreener.sort((a, b) => b.shortRatio - a.shortRatio);

    const swapAvailable = swapSummaryData.asOf !== '' || swapSummaryData.totalMaturitiesToday > 0;

    return NextResponse.json({
      timestamp: Date.now(),
      // Per-ticker
      ticker: ticker || undefined,
      tickerSI: ticker ? tickerSI : undefined,
      tickerSVHistory: ticker ? tickerSVHistory : undefined,
      tickerSwaps: ticker ? tickerSwaps : undefined,
      tickerOnRegSHO: ticker ? regSHOList.includes(ticker) : undefined,
      // Market-wide
      swapSummary: { ...swapSummaryData, available: swapAvailable },
      regSHOList: regSHOList.slice(0, 50),
      regSHOAsOf: regSHO.asOf,
      siScreener: siScreener.slice(0, 25),
      siAsOf: si.asOf,
      svScreener: svScreener.slice(0, 25),
      svAsOf: sv.asOf,
    });
  } catch (error) {
    console.error('[institutional] Error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
