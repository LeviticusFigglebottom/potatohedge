import { NextRequest, NextResponse } from 'next/server';
import { getMarketSwapSummary } from '@/lib/providers/dtcc';
import {
  fetchRegSHOWithDate,
  fetchShortInterestWithDate,
  fetchShortSaleVolumeWithDate,
  type ShortVolumeData,
} from '@/lib/providers/finra';
import { getMarketIndicators, isFREDAvailable } from '@/lib/providers/fred';
import { scanMarketFlow, type FlowResult } from '@/lib/providers/polygonFlow';
import { saveDaily, type HistoryRecord } from '@/lib/persistence';

export const maxDuration = 15;

/** Race a promise against a hard deadline */
function raceTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);
}

export async function GET(_req: NextRequest) {
  try {
    // ── Fallbacks ──
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
    const emptyFlow: FlowResult = {
      flow: { netCallPremium: 0, netPutPremium: 0, netPremium: 0, totalCallVolume: 0, totalPutVolume: 0, putCallRatio: 0, sentiment: 'neutral', tickersScanned: 0, contractsAnalyzed: 0 },
      alerts: [], perTickerFlow: [], isDeveloper: false, asOf: '',
    };

    // ── All data sources in parallel ──
    const [swapSummary, regSHOResult, siResult, svResult, indicators, flowResult] = await Promise.all([
      raceTimeout(getMarketSwapSummary().catch(() => emptySwap), 6000, emptySwap),
      raceTimeout(fetchRegSHOWithDate().catch(() => emptyRegSHO), 5000, emptyRegSHO),
      raceTimeout(fetchShortInterestWithDate().catch(() => emptySI), 6000, emptySI),
      raceTimeout(fetchShortSaleVolumeWithDate().catch(() => emptySV), 6000, emptySV),
      raceTimeout(getMarketIndicators().catch(() => emptyIndicators), 5000, emptyIndicators),
      raceTimeout(scanMarketFlow().catch(() => emptyFlow), 10000, emptyFlow),
    ]);

    // ── Process short data ──
    const regSHOList = Array.from(regSHOResult.tickers).filter(s => /^[A-Z]+$/.test(s)).sort();

    const siScreener: { symbol: string; daysToCover: number; shortInterest: number; avgDailyVolume: number }[] = [];
    for (const [sym, data] of siResult.data) {
      if (data.daysToCover >= 3 && data.daysToCover <= 100 && data.shortInterest >= 50000 && data.avgDailyVolume >= 1000) {
        siScreener.push({ symbol: sym, daysToCover: data.daysToCover, shortInterest: data.shortInterest, avgDailyVolume: data.avgDailyVolume });
      }
    }
    siScreener.sort((a, b) => b.daysToCover - a.daysToCover);

    const svScreener: { symbol: string; shortVolume: number; totalVolume: number; shortRatio: number }[] = [];
    for (const [sym, data] of svResult.data) {
      if (data.shortRatio > 0.40 && data.totalVolume > 100000) {
        svScreener.push({ symbol: sym, shortVolume: data.shortVolume, totalVolume: data.totalVolume, shortRatio: data.shortRatio });
      }
    }
    svScreener.sort((a, b) => b.shortRatio - a.shortRatio);

    const swapAvailable = swapSummary.asOf !== '' || swapSummary.totalMaturitiesToday > 0;

    // ── Sources ──
    const sources: string[] = [];
    if (flowResult.asOf) sources.push(flowResult.isDeveloper ? 'Polygon Flow (Developer)' : 'Polygon Flow');
    sources.push('Polygon SI/SV', 'FINRA Reg SHO', 'DTCC Swaps');
    if (isFREDAvailable() && (indicators.vix || indicators.skew)) sources.push('FRED');

    // ── Fire-and-forget: persist daily flow snapshot ──
    if (flowResult.asOf) {
      const today = new Date().toISOString().slice(0, 10);
      const flowRecord: HistoryRecord = {
        date: today,
        timestamp: Date.now(),
        netPremium: flowResult.flow.netPremium,
        netCallPremium: flowResult.flow.netCallPremium,
        netPutPremium: flowResult.flow.netPutPremium,
        totalCallVolume: flowResult.flow.totalCallVolume,
        totalPutVolume: flowResult.flow.totalPutVolume,
        putCallRatio: flowResult.flow.putCallRatio,
        sentiment: flowResult.flow.sentiment,
        contractsAnalyzed: flowResult.flow.contractsAnalyzed,
        tickersScanned: flowResult.flow.tickersScanned,
        sweepCount: flowResult.alerts.filter(a => a.tradeType === 'sweep').length,
        blockCount: flowResult.alerts.filter(a => a.tradeType === 'block').length,
        topAlertPremium: flowResult.alerts[0]?.premium ?? 0,
        vixPrice: indicators.vix?.current ?? undefined,
        skewValue: indicators.skew?.current ?? undefined,
        perTicker: flowResult.perTickerFlow.slice(0, 10).map(tf => ({
          ticker: tf.ticker,
          netPremium: tf.netPremium,
          callPremium: tf.callPremium,
          putPremium: tf.putPremium,
        })),
      };
      saveDaily('optix:flow:market', flowRecord).catch(() => {});

      // Per-ticker flow
      for (const tf of flowResult.perTickerFlow.slice(0, 10)) {
        const tickerRecord: HistoryRecord = {
          date: today,
          timestamp: Date.now(),
          netPremium: tf.netPremium,
          callPremium: tf.callPremium,
          putPremium: tf.putPremium,
          callVolume: tf.callVolume,
          putVolume: tf.putVolume,
        };
        saveDaily(`optix:flow:${tf.ticker}`, tickerRecord).catch(() => {});
      }
    }

    return NextResponse.json({
      timestamp: Date.now(),
      sources,

      // Market Sentiment
      vix: indicators.vix,
      skew: indicators.skew,

      // Options Flow (DIY from Polygon)
      marketFlow: flowResult.flow,
      flowAlerts: flowResult.alerts.slice(0, 30),
      perTickerFlow: flowResult.perTickerFlow,
      flowDeveloper: flowResult.isDeveloper,

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
