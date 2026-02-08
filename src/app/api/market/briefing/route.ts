import { NextResponse } from 'next/server';
import { getQuote } from '@/lib/providers/tradier';
import { fetchSwapData, getMarketSwapSummary } from '@/lib/providers/dtcc';
import { fetchRegSHOThreshold, fetchShortInterest, type ShortInterestData } from '@/lib/providers/finra';

export const maxDuration = 60;

/** Key tickers to include in the briefing snapshot */
const KEY_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIX'];
const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];

export interface BriefingData {
  timestamp: number;
  marketSnapshot: {
    symbol: string;
    price: number;
    changePct: number;
  }[];
  swapSummary: {
    totalMaturitiesToday: number;
    totalNotionalToday: number;
    totalMaturitiesWeek: number;
    totalNotionalWeek: number;
    topMaturities: { symbol: string; count: number; notional: number }[];
  };
  regSHOList: string[];
  shortInterestHighlights: {
    symbol: string;
    daysToCover: number;
    shortInterest: number;
  }[];
  mag7: {
    symbol: string;
    price: number;
    changePct: number;
    swapMaturitiesToday: number;
    swapNotionalToday: number;
    daysToCover: number;
    regSHO: boolean;
  }[];
}

export async function GET() {
  try {
    // Fetch all data sources in parallel
    const [
      swapSummary,
      swapMap,
      regSHOSet,
      siMap,
      ...quoteResults
    ] = await Promise.all([
      getMarketSwapSummary().catch(() => ({
        totalMaturitiesToday: 0,
        totalNotionalToday: 0,
        totalMaturitiesWeek: 0,
        totalNotionalWeek: 0,
        topMaturities: [],
      })),
      fetchSwapData().catch(() => new Map()),
      fetchRegSHOThreshold().catch(() => new Set<string>()),
      fetchShortInterest().catch(() => new Map<string, ShortInterestData>()),
      ...KEY_TICKERS.map(t => getQuote(t).catch(() => null)),
    ]);

    // Market snapshot from key tickers
    const marketSnapshot = KEY_TICKERS.map((sym, i) => {
      const q = quoteResults[i];
      return {
        symbol: sym,
        price: q?.last ?? 0,
        changePct: q?.changePct ?? 0,
      };
    }).filter(s => s.price > 0);

    // Mag7 quotes (parallel)
    const mag7Quotes = await Promise.all(
      MAG7.map(t => getQuote(t).catch(() => null))
    );

    const mag7 = MAG7.map((sym, i) => {
      const q = mag7Quotes[i];
      const swap = swapMap.get(sym);
      const si = siMap.get(sym);
      return {
        symbol: sym,
        price: q?.last ?? 0,
        changePct: q?.changePct ?? 0,
        swapMaturitiesToday: swap?.maturitiesToday ?? 0,
        swapNotionalToday: swap?.notionalToday ?? 0,
        daysToCover: si?.daysToCover ?? 0,
        regSHO: regSHOSet.has(sym),
      };
    });

    // Reg SHO list — just the symbols
    const regSHOList = Array.from(regSHOSet).sort();

    // Top short interest stocks by days-to-cover
    const shortInterestHighlights: BriefingData['shortInterestHighlights'] = [];
    for (const [sym, data] of siMap) {
      if (data.daysToCover > 3) {
        shortInterestHighlights.push({
          symbol: sym,
          daysToCover: data.daysToCover,
          shortInterest: data.shortInterest,
        });
      }
    }
    shortInterestHighlights.sort((a, b) => b.daysToCover - a.daysToCover);

    const briefing: BriefingData = {
      timestamp: Date.now(),
      marketSnapshot,
      swapSummary,
      regSHOList: regSHOList.slice(0, 50),
      shortInterestHighlights: shortInterestHighlights.slice(0, 20),
      mag7,
    };

    return NextResponse.json(briefing);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
