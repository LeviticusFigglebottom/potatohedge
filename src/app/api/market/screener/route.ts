import { NextRequest } from 'next/server';
import { getQuotes } from '@/lib/providers/tradier';
import { getOptionsSnapshotLite, getEquityHistory, type PolygonOptionSnapshot } from '@/lib/providers/polygon';
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
import type { OptionContract, OptionsChain, OptionExpiration } from '@/types/market';
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

// Polygon has much higher rate limits than Tradier — can run 8 stocks in parallel
// Each stock makes 2 Polygon calls: 1 snapshot + 1 equity history (max 8s each)
// Keep under Vercel 60s timeout: 4 waves × 8s = 32s + overhead ≈ 38s
const CONCURRENCY = 8;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convert Polygon options snapshot into the same OptionsChain format
 * used by the rest of the analysis pipeline. This replaces the
 * per-stock Tradier getExpirations + getOptionsChain calls.
 */
function polygonSnapshotToChains(
  ticker: string,
  snapshots: PolygonOptionSnapshot[],
  spotPrice: number,
): { expirations: OptionExpiration[]; chains: OptionsChain[] } {
  if (snapshots.length === 0) return { expirations: [], chains: [] };

  const now = new Date();

  // Group by expiration date
  const byExp = new Map<string, PolygonOptionSnapshot[]>();
  for (const opt of snapshots) {
    const exp = opt.details.expiration_date;
    if (!exp) continue;
    const dte = Math.ceil((new Date(exp + 'T16:00:00').getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (dte < 0) continue; // skip expired
    if (!byExp.has(exp)) byExp.set(exp, []);
    byExp.get(exp)!.push(opt);
  }

  // Sort expirations chronologically
  const expDates = [...byExp.keys()].sort();

  const expirations: OptionExpiration[] = expDates.map(date => {
    const dte = Math.max(0, Math.ceil((new Date(date + 'T16:00:00').getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    const strikes = [...new Set(byExp.get(date)!.map(o => o.details.strike_price))].sort((a, b) => a - b);
    return { date, dte, strikes };
  });

  // Build OptionsChain for nearest 3 expirations (same as before)
  const nearExps = expirations.slice(0, 3);
  const chains: OptionsChain[] = nearExps.map(exp => {
    const opts = byExp.get(exp.date) || [];
    const calls: OptionContract[] = [];
    const puts: OptionContract[] = [];

    for (const opt of opts) {
      const type: 'call' | 'put' = opt.details.contract_type === 'call' ? 'call' : 'put';
      const lastPrice = opt.day?.close ?? 0;

      const contract: OptionContract = {
        symbol: opt.details.ticker || '',
        underlying: ticker,
        strike: opt.details.strike_price,
        expiration: exp.date,
        type,
        last: lastPrice,
        bid: 0,
        ask: 0,
        mid: lastPrice,
        volume: opt.day?.volume ?? 0,
        openInterest: opt.open_interest ?? 0,
        impliedVolatility: opt.implied_volatility ?? 0,
        delta: opt.greeks?.delta ?? 0,
        gamma: opt.greeks?.gamma ?? 0,
        theta: opt.greeks?.theta ?? 0,
        vega: opt.greeks?.vega ?? 0,
        rho: 0,
        dte: exp.dte,
        inTheMoney: type === 'call' ? spotPrice > opt.details.strike_price : spotPrice < opt.details.strike_price,
        intrinsicValue: type === 'call'
          ? Math.max(0, spotPrice - opt.details.strike_price)
          : Math.max(0, opt.details.strike_price - spotPrice),
        extrinsicValue: Math.max(0, lastPrice - (type === 'call'
          ? Math.max(0, spotPrice - opt.details.strike_price)
          : Math.max(0, opt.details.strike_price - spotPrice))),
        bidAskSpread: 0,
        volumeOiRatio: (opt.open_interest ?? 0) > 0
          ? (opt.day?.volume ?? 0) / (opt.open_interest ?? 1)
          : 0,
      };

      if (type === 'call') calls.push(contract);
      else puts.push(contract);
    }

    calls.sort((a, b) => a.strike - b.strike);
    puts.sort((a, b) => a.strike - b.strike);

    return {
      underlying: ticker,
      underlyingPrice: spotPrice,
      expiration: exp.date,
      calls,
      puts,
      timestamp: Date.now(),
    };
  });

  return { expirations, chains };
}

/**
 * Lightweight correlation context from equity bars — no extra API calls needed.
 * Computes mean reversion stats and vol regime performance from daily bars.
 */
function computeQuickCorrelationCtx(
  bars: { o: number; h: number; l: number; c: number; v: number; t: number }[],
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

async function analyzeStock(
  ticker: string,
  quoteMap: Map<string, Quote>,
  swapMap: Map<string, SwapData>,
  regSHOSet: Set<string>,
  siMap: Map<string, ShortInterestData>,
): Promise<ScreenerResult | null> {
  try {
    // Fetch Polygon options snapshot + equity bars in parallel
    // Uses Polygon directly (NOT fetchEquityBars which falls back to Tradier,
    // adding up to 8s extra per stock and risking Vercel 60s timeout)
    const from = new Date(Date.now() - 260 * 86400000).toISOString().split('T')[0];
    const to = new Date().toISOString().split('T')[0];
    const [polygonSnapshot, rawBars] = await Promise.all([
      getOptionsSnapshotLite(ticker).catch(() => [] as PolygonOptionSnapshot[]),
      getEquityHistory(ticker, 1, 'day', from, to).catch(() => []),
    ]);
    const historyBars = rawBars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: b.t }));

    // Spot price: prefer pre-fetched Tradier quote (most fresh),
    // fall back to Polygon snapshot's underlying price
    const quote = quoteMap.get(ticker);
    const spotPrice = quote?.last
      || (polygonSnapshot.length > 0 ? polygonSnapshot[0].underlying_asset?.price : 0)
      || 0;
    if (!spotPrice || spotPrice <= 0) return null;

    const changePct = quote?.changePct ?? 0;

    // Convert Polygon snapshot to OptionsChain format
    const { expirations, chains } = polygonSnapshotToChains(ticker, polygonSnapshot, spotPrice);

    const nearExps = expirations.slice(0, 3);
    if (nearExps.length === 0 || chains.length === 0) return null;

    // ─── Everything below is IDENTICAL to before ───
    // Same GEX/DEX, same IV, same scoring, same recommendations

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
    const gammaFlip = findGammaFlip(aggExposures, spotPrice);
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
    const maxPainResult = computeMaxPain(
      nearChain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest })),
      nearChain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }))
    );

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
      changePercent: changePct,
      atr14: profile.atr14,
      atrPercent: profile.atrPercent,
      dailySigma: profile.dailySigma,
      avgDailyRangePct: profile.avgDailyRangePct,
      nearestExp: nearExps[0]?.date || '',
      nearestDTE: nearExps[0]?.dte || 0,
      weeklyExp: nearExps.find(e => e.dte >= 5 && e.dte <= 8)?.date,
      monthlyExp: nearExps.find(e => e.dte >= 25 && e.dte <= 45)?.date,
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
      isMarketOpen: isMarketOpenNow(),
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
      changePercent: changePct,
      topSignal: topSignal ? `${topSignal.name}: ${topSignal.direction}` : 'N/A',
      signalCount: rec.signals.filter(s => s.weight !== 0).length,
      gammaFlip,
      callWall,
      putWall,
      warnings: rec.warnings,
      timestamp: Date.now(),
      // DTCC + FINRA data
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
 * This replaces 380 individual getQuote() calls with ~10 batch calls.
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
    // Small delay between batch quote fetches to be safe
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

      // Pre-fetch shared data: DTCC + FINRA + quotes (with 8s cap on quotes)
      // Quotes use Tradier batch API — if slow, fall back to Polygon prices
      const quotesWithTimeout = Promise.race([
        prefetchQuotes(symbols),
        sleep(8000).then(() => new Map<string, Quote>()),
      ]);

      const [swapMap, regSHOSet, siMap, quoteMap] = await Promise.all([
        fetchSwapData().then(r => r.data).catch(() => new Map<string, SwapData>()),
        fetchRegSHOThreshold().catch(() => new Set<string>()),
        fetchShortInterest().catch(() => new Map<string, ShortInterestData>()),
        quotesWithTimeout,
      ]);

      send({
        type: 'meta',
        swapData: swapMap.size > 0,
        regSHOCount: regSHOSet.size,
        shortInterestCount: siMap.size,
        quotesLoaded: quoteMap.size,
      });

      const results: ScreenerResult[] = [];
      let completed = 0;

      // Process in batches with concurrency control
      // Polygon handles 10 concurrent requests easily (unlike Tradier's ~3)
      for (let i = 0; i < symbols.length; i += CONCURRENCY) {
        const batch = symbols.slice(i, i + CONCURRENCY);

        const batchResults = await Promise.all(
          batch.map(async (sym) => {
            const result = await analyzeStock(sym, quoteMap, swapMap, regSHOSet, siMap);
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

        // Light delay between batches — Polygon is generous but be a good citizen
        if (i + CONCURRENCY < symbols.length) {
          await sleep(300);
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
