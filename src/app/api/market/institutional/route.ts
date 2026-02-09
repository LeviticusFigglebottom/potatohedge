import { NextRequest, NextResponse } from 'next/server';
import { getMarketSwapSummary } from '@/lib/providers/dtcc';
import {
  fetchRegSHOWithDate,
  fetchShortInterestWithDate,
  fetchShortSaleVolumeWithDate,
  type ShortVolumeData,
} from '@/lib/providers/finra';
import { getMarketIndicators, isFREDAvailable } from '@/lib/providers/fred';
import {
  getAllUWData,
  isUWAvailable,
  type MarketTide,
  type FlowAlert,
  type DarkPoolPrint,
  type CongressTrade,
} from '@/lib/providers/unusualWhales';

export const maxDuration = 15;

/** Race a promise against a hard deadline */
function raceTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);
}

export async function GET(_req: NextRequest) {
  try {
    // ── All data sources in parallel ──
    const emptySwap = {
      totalMaturitiesToday: 0, totalNotionalToday: 0,
      totalMaturitiesWeek: 0, totalNotionalWeek: 0,
      topMaturities: [] as { symbol: string; count: number; notional: number }[],
      asOf: '',
    };
    const emptyRegSHO = { tickers: new Set<string>(), asOf: '' };
    const emptySI = { data: new Map<string, { daysToCover: number; shortInterest: number; previousShortInterest: number; changePercent: number; avgDailyVolume: number }>(), asOf: '' };
    const emptySV = { data: new Map<string, ShortVolumeData>(), asOf: '' };
    const emptyIndicators = { vix: null, skew: null };
    const emptyUW = { tide: null as MarketTide | null, flow: [] as FlowAlert[], darkPool: [] as DarkPoolPrint[], congress: [] as CongressTrade[] };

    const [swapSummary, regSHOResult, siResult, svResult, indicators, uwData] = await Promise.all([
      raceTimeout(getMarketSwapSummary().catch(() => emptySwap), 6000, emptySwap),
      raceTimeout(fetchRegSHOWithDate().catch(() => emptyRegSHO), 5000, emptyRegSHO),
      raceTimeout(fetchShortInterestWithDate().catch(() => emptySI), 6000, emptySI),
      raceTimeout(fetchShortSaleVolumeWithDate().catch(() => emptySV), 6000, emptySV),
      raceTimeout(getMarketIndicators().catch(() => emptyIndicators), 5000, emptyIndicators),
      raceTimeout(getAllUWData().catch(() => emptyUW), 8000, emptyUW),
    ]);

    // ── Process market-wide data ──
    const regSHOList = Array.from(regSHOResult.tickers).filter(s => /^[A-Z]+$/.test(s)).sort();

    // SI screener — top short interest by DTC
    const siScreener: { symbol: string; daysToCover: number; shortInterest: number; avgDailyVolume: number }[] = [];
    for (const [sym, data] of siResult.data) {
      if (data.daysToCover >= 3 && data.daysToCover <= 100 && data.shortInterest >= 50000 && data.avgDailyVolume >= 1000) {
        siScreener.push({ symbol: sym, daysToCover: data.daysToCover, shortInterest: data.shortInterest, avgDailyVolume: data.avgDailyVolume });
      }
    }
    siScreener.sort((a, b) => b.daysToCover - a.daysToCover);

    // SV screener — top short volume ratio
    const svScreener: { symbol: string; shortVolume: number; totalVolume: number; shortRatio: number }[] = [];
    for (const [sym, data] of svResult.data) {
      if (data.shortRatio > 0.40 && data.totalVolume > 100000) {
        svScreener.push({ symbol: sym, shortVolume: data.shortVolume, totalVolume: data.totalVolume, shortRatio: data.shortRatio });
      }
    }
    svScreener.sort((a, b) => b.shortRatio - a.shortRatio);

    const swapAvailable = swapSummary.asOf !== '' || swapSummary.totalMaturitiesToday > 0;

    // Track which data sources are active
    const sources: string[] = ['Polygon SI/SV', 'FINRA Reg SHO', 'DTCC Swaps'];
    if (isFREDAvailable() && (indicators.vix || indicators.skew)) sources.push('FRED (VIX/SKEW)');
    if (isUWAvailable()) sources.push('Unusual Whales');

    return NextResponse.json({
      timestamp: Date.now(),
      sources,

      // Market Sentiment
      vix: indicators.vix,
      skew: indicators.skew,

      // Unusual Whales
      uwAvailable: isUWAvailable(),
      marketTide: uwData.tide,
      flowAlerts: uwData.flow.slice(0, 30),
      darkPool: uwData.darkPool.slice(0, 30),
      congressTrades: uwData.congress.slice(0, 20),

      // Short Pressure
      siScreener: siScreener.slice(0, 20),
      siAsOf: siResult.asOf,
      svScreener: svScreener.slice(0, 20),
      svAsOf: svResult.asOf,

      // Reg SHO
      regSHOList: regSHOList.slice(0, 50),
      regSHOAsOf: regSHOResult.asOf,

      // DTCC Swaps
      swapSummary: { ...swapSummary, available: swapAvailable },
    });
  } catch (error) {
    console.error('[institutional] Error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
