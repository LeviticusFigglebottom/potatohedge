import { NextRequest } from 'next/server';
import { getQuote, getExpirations, getOptionsChain } from '@/lib/providers/tradier';
import { fetchEquityBars } from '@/lib/providers/equityBars';
import {
  computeDealerExposureFromChain,
  findGammaFlip,
  findCallWall,
  findPutWall,
} from '@/lib/math/blackScholes';
import {
  computeHistoricalVolatility,
  computeIVRankPercentile,
  computeSkew,
  computeStockProfile,
} from '@/lib/math/analytics';
import { generateRecommendations, type RecommendationInput } from '@/lib/math/recommendations';
import { getUniverseSymbols } from '@/lib/stockUniverse';
import type { EquityBar } from '@/lib/providers/equityBars';

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
}

const CONCURRENCY = 8; // parallel stock processing limit

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Lightweight correlation context from equity bars — no extra API calls needed.
 * Computes mean reversion stats and vol regime performance from daily bars.
 */
function computeQuickCorrelationCtx(
  bars: EquityBar[],
  hvCurrent: number,
): RecommendationInput['correlationCtx'] {
  if (bars.length < 60) return undefined;

  // Daily returns
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0) returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c);
  }
  if (returns.length < 40) return undefined;

  // Rolling 20-day HV for vol regime classification
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

  // Vol regime forward returns
  const lowVolRets: number[] = [];
  const highVolRets: number[] = [];
  const lowVolWins5d: boolean[] = [];
  for (let i = 0; i < hvValues.length - 20; i++) {
    const idx = i + 20; // index into returns
    const fwd5 = returns.slice(idx, idx + 5).reduce((s, r) => s + r, 0);
    const fwd20 = returns.slice(idx, idx + 20).reduce((s, r) => s + r, 0);
    if (hvValues[i] <= p33) {
      lowVolRets.push(fwd20);
      lowVolWins5d.push(fwd5 > 0);
    } else if (hvValues[i] >= p66) {
      highVolRets.push(fwd20);
    }
  }

  // Mean reversion: after 2σ+ moves
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
    volOverpricingRate: 0.5, // not computed in lightweight version
    drawdownRatio: 1, // needs SPY data, skip in screener
    alpha30d: 0, // needs SPY data, skip in screener
  };
}

async function analyzeStock(ticker: string): Promise<ScreenerResult | null> {
  try {
    // Fetch core data: quote + expirations + equity bars in parallel
    const [quote, expirations, historyBars] = await Promise.all([
      getQuote(ticker),
      getExpirations(ticker).catch(() => []),
      fetchEquityBars(ticker, 100), // lighter — 100 days is enough for HV20 + ATR14
    ]);

    const spotPrice = quote.last;
    if (!spotPrice || spotPrice <= 0) return null;

    // Only fetch the nearest 2 expirations for speed
    const nearExps = expirations.slice(0, 2);
    if (nearExps.length === 0) return null;

    const chains = await Promise.all(
      nearExps.map(e => getOptionsChain(ticker, e.date).catch(() => null))
    ).then(c => c.filter((x): x is NonNullable<typeof x> => x !== null));

    if (chains.length === 0) return null;

    // Aggregate GEX
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
      } else {
        byStrike.set(e.strike, { ...e });
      }
    }
    const aggExposures = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);

    const totalGEX = aggExposures.reduce((s, e) => s + e.netGEX, 0);
    const totalDEX = aggExposures.reduce((s, e) => s + e.netDEX, 0);
    const gammaFlip = findGammaFlip(aggExposures);
    const callWall = findCallWall(aggExposures);
    const putWall = findPutWall(aggExposures);

    const totalCallVol = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalPutVol = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalCallOI = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const totalPutOI = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const volumePCR = totalCallVol > 0 ? totalPutVol / totalCallVol : 1;
    const oiPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

    // ATM IV — adaptive tolerance for low-priced stocks
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

    // If ATM IV came back as 0 (missing data), fall back to HV * 1.15 as proxy
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

    // Max pain from nearest chain
    const maxPainCalc = (() => {
      const callStrikes = nearChain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest }));
      const putStrikes = nearChain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }));
      if (callStrikes.length === 0 && putStrikes.length === 0) return spotPrice;
      const strikes = [...new Set([...callStrikes.map(s => s.strike), ...putStrikes.map(s => s.strike)])].sort((a, b) => a - b);
      let minPain = Infinity;
      let mpStrike = spotPrice;
      for (const s of strikes) {
        const callPain = callStrikes.reduce((sum, c) => sum + c.openInterest * Math.max(0, s - c.strike) * 100, 0);
        const putPain = putStrikes.reduce((sum, p) => sum + p.openInterest * Math.max(0, p.strike - s) * 100, 0);
        if (callPain + putPain < minPain) {
          minPain = callPain + putPain;
          mpStrike = s;
        }
      }
      return mpStrike;
    })();

    // Lightweight correlation context from existing bars
    const correlationCtx = computeQuickCorrelationCtx(historyBars, hvCurrent);

    const input: RecommendationInput = {
      symbol: ticker,
      spotPrice,
      totalGEX,
      totalDEX,
      gammaFlip,
      callWall,
      putWall,
      maxPain: maxPainCalc,
      volumePCR,
      oiPCR,
      totalCallVol,
      totalPutVol,
      ivRank: ivMetrics.ivRank,
      ivPercentile: ivMetrics.ivPercentile,
      currentIV,
      hvCurrent,
      ivHvRatio,
      skewBias: skew.skewBias,
      skewRatio: skew.skewRatio,
      changePercent: quote.changePct,
      atr14: profile.atr14,
      atrPercent: profile.atrPercent,
      dailySigma: profile.dailySigma,
      avgDailyRangePct: profile.avgDailyRangePct,
      nearestExp: nearExps[0]?.date || '',
      nearestDTE: nearExps[0]?.dte || 0,
      weeklyExp: nearExps.find(e => e.dte >= 5 && e.dte <= 8)?.date,
      monthlyExp: nearExps.find(e => e.dte >= 25 && e.dte <= 45)?.date,
      correlationCtx,
    };

    const rec = generateRecommendations(input);

    // Find top signal by absolute weight
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
      changePercent: quote.changePct,
      topSignal: topSignal ? `${topSignal.name}: ${topSignal.direction}` : 'N/A',
      signalCount: rec.signals.filter(s => s.weight !== 0).length,
      gammaFlip,
      callWall,
      putWall,
      warnings: rec.warnings,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error(`[screener] Failed to analyze ${ticker}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET(request: NextRequest) {
  const symbolsParam = request.nextUrl.searchParams.get('symbols');
  const minScore = parseInt(request.nextUrl.searchParams.get('minScore') || '0');

  const symbols = symbolsParam
    ? symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : getUniverseSymbols();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      send({ type: 'start', total: symbols.length });

      const results: ScreenerResult[] = [];
      let completed = 0;

      // Process in batches with concurrency control
      for (let i = 0; i < symbols.length; i += CONCURRENCY) {
        const batch = symbols.slice(i, i + CONCURRENCY);

        const batchResults = await Promise.all(
          batch.map(async (sym) => {
            const result = await analyzeStock(sym);
            completed++;
            send({
              type: 'progress',
              completed,
              total: symbols.length,
              current: sym,
              result: result ? {
                symbol: result.symbol,
                biasScore: result.biasScore,
                overallBias: result.overallBias,
              } : null,
            });
            return result;
          })
        );

        for (const r of batchResults) {
          if (r) results.push(r);
        }

        // Small delay between batches to avoid rate limit spikes
        if (i + CONCURRENCY < symbols.length) {
          await sleep(200);
        }
      }

      // Sort by absolute bias score descending
      results.sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));

      // Filter by minimum score if specified
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
