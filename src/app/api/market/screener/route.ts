import { NextRequest } from 'next/server';
import { getQuotes } from '@/lib/providers/tradier';
import { getOptionsSnapshotLite, polygonSnapshotToChains, getEquityHistory } from '@/lib/providers/polygon';
import { getMarketIndicators } from '@/lib/providers/fred';
import type { Quote } from '@/types/market';

function isMarketOpenNow(): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  const hours = parseInt(get('hour'), 10) || 0;
  const minutes = parseInt(get('minute'), 10) || 0;
  const dayName = get('weekday');
  if (dayName === 'Sat' || dayName === 'Sun') return false;
  const time = hours * 60 + minutes;
  return time >= 570 && time <= 960;
}
import {
  computeDealerExposureFromChain,
  findGammaFlip,
  findCallWall,
  findPutWall,
  computeMaxPain,
} from '@/lib/math/blackScholes';
import {
  computeHistoricalVolatility,
  computeIVRankPercentile,
  computeSkew,
  computeStockProfile,
} from '@/lib/math/analytics';
import { generateRecommendations, type RecommendationInput } from '@/lib/math/recommendations';
import { getUniverseSymbols, getTop500Symbols } from '@/lib/stockUniverse';
import { fetchSwapData, type SwapData } from '@/lib/providers/dtcc';
import { fetchRegSHOThreshold, fetchShortInterest, type ShortInterestData } from '@/lib/providers/finra';

export const maxDuration = 300;

export interface ScreenerResult {
  symbol: string;
  spotPrice: number;
  biasScore: number;
  overallBias: 'bullish' | 'bearish' | 'neutral';
  volRegime: 'high' | 'mid' | 'low';
  gammaRegime: 'long' | 'short' | 'neutral';
  currentIV: number;
  ivRank: number;
  volumePCR: number;
  changePercent: number;
  topSignal: string;
  signalCount: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  warnings: string[];
  timestamp: number;
  // DTCC + FINRA data
  swapMaturitiesToday: number;
  swapNotionalToday: number;
  daysToCover: number;
  regSHO: boolean;
}

// Polygon snapshot = 1 API call per stock (vs 4 Tradier calls).
// Equity history = 1 Polygon call. Total: 2 Polygon calls/stock.
// Polygon allows ~5 calls/sec. CONCURRENCY=4 with stagger keeps us under that.
const CONCURRENCY = 4;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Lightweight correlation context from equity bars — no extra API calls needed.
 */
function computeQuickCorrelationCtx(
  bars: { o: number; h: number; l: number; c: number; v: number; t: number }[],
  hvCurrent: number,
): RecommendationInput['correlationCtx'] {
  if (bars.length < 60) return undefined;

  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0) returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c);
  }
  if (returns.length < 40) return undefined;

  const hvValues: number[] = [];
  for (let i = 20; i < returns.length; i++) {
    const window = returns.slice(i - 20, i);
    const mean = window.reduce((s, r) => s + r, 0) / window.length;
    const variance = window.reduce((s, r) => s + (r - mean) ** 2, 0) / (window.length - 1);
    hvValues.push(Math.sqrt(variance * 252));
  }

  const sortedHV = [...hvValues].sort((a, b) => a - b);
  const p33 = sortedHV[Math.floor(sortedHV.length * 0.33)] || 0;
  const p66 = sortedHV[Math.floor(sortedHV.length * 0.66)] || 999;

  const lowVolRets: number[] = [];
  const highVolRets: number[] = [];
  const lowVolWins5d: boolean[] = [];
  for (let i = 0; i < hvValues.length - 20; i++) {
    const idx = i + 20;
    const fwd5 = returns.slice(idx, idx + 5).reduce((s, r) => s + r, 0);
    const fwd20 = returns.slice(idx, idx + 20).reduce((s, r) => s + r, 0);
    if (hvValues[i] <= p33) {
      lowVolRets.push(fwd20);
      lowVolWins5d.push(fwd5 > 0);
    } else if (hvValues[i] >= p66) {
      highVolRets.push(fwd20);
    }
  }

  const dailySigma = hvCurrent > 0 ? hvCurrent / Math.sqrt(252) : 0.015;
  const bigUps: { next1d: number }[] = [];
  const bigDowns: { next1d: number; next5d: number }[] = [];
  for (let i = 0; i < returns.length - 5; i++) {
    if (Math.abs(returns[i]) < dailySigma * 2) continue;
    if (returns[i] > 0) {
      bigUps.push({ next1d: returns[i + 1] || 0 });
    } else {
      const fwd5 = returns.slice(i + 1, i + 6).reduce((s, r) => s + r, 0);
      bigDowns.push({ next1d: returns[i + 1] || 0, next5d: fwd5 });
    }
  }

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  return {
    meanReversionBounceRate: bigDowns.length > 3 ? bigDowns.filter(d => d.next1d > 0).length / bigDowns.length : 0.5,
    meanReversionPullbackRate: bigUps.length > 3 ? bigUps.filter(u => u.next1d < 0).length / bigUps.length : 0.5,
    avgRecovery5d: avg(bigDowns.map(d => d.next5d)),
    lowVolWinRate: lowVolWins5d.length > 5 ? lowVolWins5d.filter(Boolean).length / lowVolWins5d.length : 0.5,
    highVolAvg20d: avg(highVolRets),
    lowVolAvg20d: avg(lowVolRets),
    volOverpricingRate: 0.5,
    drawdownRatio: 1,
    alpha30d: 0,
  };
}

async function analyzeStock(
  ticker: string,
  quoteMap: Map<string, Quote>,
  swapMap: Map<string, SwapData>,
  regSHOSet: Set<string>,
  siMap: Map<string, ShortInterestData>,
  vixLevel: number | undefined,
): Promise<ScreenerResult | null> {
  try {
    // Spot price from pre-fetched Tradier batch quote
    const quote = quoteMap.get(ticker);
    const spotPrice = quote?.last || 0;
    if (!spotPrice || spotPrice <= 0) return null;

    // Fetch Polygon snapshot + equity bars SEQUENTIALLY to control burst rate.
    // Sequential = max 1 Polygon call in flight per stock at any time.
    const from = new Date(Date.now() - 260 * 86400000).toISOString().split('T')[0];
    const to = new Date().toISOString().split('T')[0];

    const snapshots = await getOptionsSnapshotLite(ticker).catch(() => []);
    const rawBars = await getEquityHistory(ticker, 1, 'day', from, to).catch(() => []);

    const historyBars = rawBars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: b.t }));

    // Convert Polygon snapshots to OptionsChain format (3 nearest expirations)
    const chains = polygonSnapshotToChains(snapshots, ticker, spotPrice, 3);
    if (chains.length === 0) return null;

    // ─── Aggregate dealer exposure (GEX + DEX + Vanna + Charm) ───
    // computeDealerExposureFromChain computes vanna/charm via Black-Scholes internally
    const allExposures = chains.flatMap(chain =>
      computeDealerExposureFromChain(
        chain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest, impliedVolatility: c.impliedVolatility, gamma: c.gamma, delta: c.delta, dte: c.dte })),
        chain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest, impliedVolatility: p.impliedVolatility, gamma: p.gamma, delta: p.delta, dte: p.dte })),
        spotPrice
      )
    );

    const byStrike = new Map<number, typeof allExposures[0]>();
    for (const e of allExposures) {
      const existing = byStrike.get(e.strike);
      if (existing) {
        existing.netGEX += e.netGEX;
        existing.netDEX += e.netDEX;
        existing.callGEX += e.callGEX;
        existing.putGEX += e.putGEX;
        existing.netVanna += e.netVanna;
        existing.callVanna += e.callVanna;
        existing.putVanna += e.putVanna;
        existing.netCharm += e.netCharm;
        existing.callCharm += e.callCharm;
        existing.putCharm += e.putCharm;
      } else {
        byStrike.set(e.strike, { ...e });
      }
    }
    const aggExposures = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);

    const totalGEX = aggExposures.reduce((s, e) => s + e.netGEX, 0);
    const totalDEX = aggExposures.reduce((s, e) => s + e.netDEX, 0);
    const totalVanna = aggExposures.reduce((s, e) => s + e.netVanna, 0);
    const totalCharm = aggExposures.reduce((s, e) => s + e.netCharm, 0);
    const gammaFlip = findGammaFlip(aggExposures, spotPrice);
    const callWall = findCallWall(aggExposures);
    const putWall = findPutWall(aggExposures);

    const totalCallVol = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalPutVol = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalCallOI = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const totalPutOI = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const volumePCR = totalCallVol > 0 ? totalPutVol / totalCallVol : 1;
    const oiPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

    // ATM IV
    const nearChain = chains[0];
    const atmTolerance = spotPrice < 20 ? 0.10 : spotPrice < 50 ? 0.05 : 0.02;
    const atmOpts = [...nearChain.calls, ...nearChain.puts]
      .filter(o => Math.abs(o.strike - spotPrice) / spotPrice < atmTolerance && o.impliedVolatility > 0.01)
      .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
    let currentIV = atmOpts.length > 0
      ? atmOpts.slice(0, 4).reduce((s, o) => s + o.impliedVolatility, 0) / Math.min(4, atmOpts.length)
      : 0;

    // HV + IV Rank
    const closes = historyBars.map(b => b.c).reverse();
    const hvCurrent = computeHistoricalVolatility(closes, 20);

    if (currentIV === 0 && hvCurrent > 0) {
      currentIV = hvCurrent * 1.15;
    }

    const historicalIVs = closes.slice(0, 252).map((_, i) => {
      const hv = computeHistoricalVolatility(closes.slice(i), 20);
      return hv > 0 ? hv * 1.15 : 0;
    }).filter(v => v > 0);
    const ivMetrics = computeIVRankPercentile(currentIV, historicalIVs);
    const ivHvRatio = hvCurrent > 0 ? currentIV / hvCurrent : 1;

    const skew = computeSkew(nearChain.calls, nearChain.puts, spotPrice);

    // Stock Profile
    const profile = computeStockProfile(
      historyBars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
      spotPrice,
      hvCurrent
    );

    // Max pain
    const maxPainResult = computeMaxPain(
      nearChain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest })),
      nearChain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }))
    );

    const correlationCtx = computeQuickCorrelationCtx(historyBars, hvCurrent);

    // ─── Signals that match recommendations route ───

    // IV term structure (near vs next expiration)
    let nearTermIV: number | undefined;
    let nextTermIV: number | undefined;
    if (chains.length >= 2) {
      const getATMIV = (chain: typeof chains[0]) => {
        const atm = [...chain.calls, ...chain.puts]
          .filter(o => Math.abs(o.strike - spotPrice) / spotPrice < atmTolerance && o.impliedVolatility > 0.01)
          .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
        return atm.length > 0 ? atm.slice(0, 4).reduce((s, o) => s + o.impliedVolatility, 0) / Math.min(4, atm.length) : 0;
      };
      nearTermIV = getATMIV(chains[0]);
      nextTermIV = getATMIV(chains[1]);
      if (nearTermIV === 0) nearTermIV = undefined;
      if (nextTermIV === 0) nextTermIV = undefined;
    }

    // OI Concentration (top 3 call + put strikes as % of total)
    const callsByOI = [...nearChain.calls].sort((a, b) => b.openInterest - a.openInterest);
    const putsByOI = [...nearChain.puts].sort((a, b) => b.openInterest - a.openInterest);
    const top3CallOI = callsByOI.slice(0, 3).reduce((s, c) => s + c.openInterest, 0);
    const top3PutOI = putsByOI.slice(0, 3).reduce((s, p) => s + p.openInterest, 0);
    const totalCallOIForConc = nearChain.calls.reduce((s, c) => s + c.openInterest, 0);
    const totalPutOIForConc = nearChain.puts.reduce((s, p) => s + p.openInterest, 0);
    const oiConcentration = (totalCallOIForConc + totalPutOIForConc) > 0
      ? ((top3CallOI / Math.max(1, totalCallOIForConc)) * 100 + (top3PutOI / Math.max(1, totalPutOIForConc)) * 100) / 2
      : undefined;

    // Expiration DTE for nearest chains
    const chainExps = chains.map(c => {
      const expDate = new Date(c.expiration + 'T16:00:00-05:00');
      const dte = Math.max(0, Math.ceil((expDate.getTime() - Date.now()) / 86400000));
      return { date: c.expiration, dte };
    });

    const input: RecommendationInput = {
      symbol: ticker,
      spotPrice,
      totalGEX,
      totalDEX,
      gammaFlip,
      callWall,
      putWall,
      maxPain: maxPainResult.strike,
      volumePCR,
      oiPCR,
      totalCallVol,
      totalPutVol,
      totalCallOI,
      totalPutOI,
      ivRank: ivMetrics.ivRank,
      ivPercentile: ivMetrics.ivPercentile,
      currentIV,
      hvCurrent,
      ivHvRatio,
      skewBias: skew.skewBias,
      skewRatio: skew.skewRatio,
      changePercent: quote?.changePct ?? 0,
      atr14: profile.atr14,
      atrPercent: profile.atrPercent,
      dailySigma: profile.dailySigma,
      avgDailyRangePct: profile.avgDailyRangePct,
      nearestExp: chainExps[0]?.date || '',
      nearestDTE: chainExps[0]?.dte || 0,
      weeklyExp: chainExps.find(e => e.dte >= 5 && e.dte <= 8)?.date,
      monthlyExp: chainExps.find(e => e.dte >= 25 && e.dte <= 45)?.date,
      correlationCtx,
      // DTCC swap data
      swapMaturitiesToday: swapMap.get(ticker)?.maturitiesToday,
      swapNotionalToday: swapMap.get(ticker)?.notionalToday,
      swapMaturitiesWeek: swapMap.get(ticker)?.maturitiesWeek,
      swapNotionalWeek: swapMap.get(ticker)?.notionalWeek,
      // FINRA data
      shortInterest: siMap.get(ticker)?.shortInterest,
      daysToCover: siMap.get(ticker)?.daysToCover,
      regSHOThreshold: regSHOSet.has(ticker),
      // Signals matching recommendations route
      totalVanna: totalVanna || undefined,
      totalCharm: totalCharm || undefined,
      nearTermIV,
      nextTermIV,
      oiConcentration,
      vixLevel,
      isMarketOpen: isMarketOpenNow(),
    };

    const rec = generateRecommendations(input);

    const topSignal = rec.signals.length > 0
      ? rec.signals.reduce((top, s) => Math.abs(s.weight) > Math.abs(top.weight) ? s : top, rec.signals[0])
      : null;

    return {
      symbol: ticker,
      spotPrice,
      biasScore: rec.biasScore,
      overallBias: rec.overallBias,
      volRegime: rec.volRegime,
      gammaRegime: rec.gammaRegime,
      currentIV,
      ivRank: ivMetrics.ivRank,
      volumePCR,
      changePercent: quote?.changePct ?? 0,
      topSignal: topSignal ? `${topSignal.name}: ${topSignal.direction}` : 'N/A',
      signalCount: rec.signals.filter(s => s.weight !== 0).length,
      gammaFlip,
      callWall,
      putWall,
      warnings: rec.warnings,
      timestamp: Date.now(),
      swapMaturitiesToday: swapMap.get(ticker)?.maturitiesToday || 0,
      swapNotionalToday: swapMap.get(ticker)?.notionalToday || 0,
      daysToCover: siMap.get(ticker)?.daysToCover || 0,
      regSHO: regSHOSet.has(ticker),
    };
  } catch (err) {
    console.error(`[screener] Failed to analyze ${ticker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Pre-fetch all quotes in bulk via Tradier batch API.
 * 380 stocks → ~10 batch calls (40 per batch). Much lighter than per-stock quotes.
 */
async function prefetchQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const BATCH_SIZE = 40;
  const quoteMap = new Map<string, Quote>();

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    try {
      const quotes = await getQuotes(batch);
      for (const q of quotes) {
        if (q.symbol && q.last > 0) quoteMap.set(q.symbol, q);
      }
    } catch (err) {
      console.warn(`[screener] Batch quote fetch failed for chunk ${i}-${i + BATCH_SIZE}:`, err instanceof Error ? err.message : err);
    }
    if (i + BATCH_SIZE < symbols.length) await sleep(500);
  }

  return quoteMap;
}

export async function GET(request: NextRequest) {
  const symbolsParam = request.nextUrl.searchParams.get('symbols');
  const minScore = parseInt(request.nextUrl.searchParams.get('minScore') || '0');

  const tierParam = request.nextUrl.searchParams.get('tier');
  const symbols = symbolsParam
    ? symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : tierParam === 'all' ? getUniverseSymbols() : getTop500Symbols();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: 'start', total: symbols.length });
      send({ type: 'progress', completed: 0, total: symbols.length, current: 'Loading market data...' });

      // Pre-fetch shared data in parallel:
      // - Tradier batch quotes (~10 calls for all 380 stocks) with 8s cap
      // - DTCC swaps, FINRA short data
      // - VIX level from FRED (1 call, cached)
      const quotesWithTimeout = Promise.race([
        prefetchQuotes(symbols),
        sleep(8000).then(() => new Map<string, Quote>()),
      ]);

      const [swapMap, regSHOSet, siMap, quoteMap, indicators] = await Promise.all([
        fetchSwapData().then(r => r.data).catch(() => new Map<string, SwapData>()),
        fetchRegSHOThreshold().catch(() => new Set<string>()),
        fetchShortInterest().catch(() => new Map<string, ShortInterestData>()),
        quotesWithTimeout,
        getMarketIndicators().catch(() => ({ vix: null, skew: null })),
      ]);

      const vixLevel = indicators.vix?.current ?? undefined;

      send({
        type: 'meta',
        swapData: swapMap.size > 0,
        regSHOCount: regSHOSet.size,
        shortInterestCount: siMap.size,
        quotesLoaded: quoteMap.size,
      });

      const results: ScreenerResult[] = [];
      let completed = 0;

      // Process stocks with staggered starts.
      // Each stock: 2 SEQUENTIAL Polygon calls (snapshot + bars).
      // CONCURRENCY=4 with 300ms stagger = max ~4 Polygon calls in flight.
      // Polygon rate limit ~5 calls/sec → comfortably under limit.
      for (let i = 0; i < symbols.length; i += CONCURRENCY) {
        const batch = symbols.slice(i, i + CONCURRENCY);

        const batchResults = await Promise.all(
          batch.map(async (sym, idx) => {
            // Stagger starts within batch
            if (idx > 0) await sleep(idx * 300);
            const result = await analyzeStock(sym, quoteMap, swapMap, regSHOSet, siMap, vixLevel);
            completed++;
            send({
              type: 'progress',
              completed,
              total: symbols.length,
              current: sym,
              result: result || null,
            });
            return result;
          })
        );

        for (const r of batchResults) {
          if (r) results.push(r);
        }

        // Brief pause between batches
        if (i + CONCURRENCY < symbols.length) {
          await sleep(200);
        }
      }

      results.sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));

      const filtered = minScore > 0
        ? results.filter(r => Math.abs(r.biasScore) >= minScore)
        : results;

      send({ type: 'done', results: filtered, totalAnalyzed: symbols.length, totalPassed: filtered.length });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
