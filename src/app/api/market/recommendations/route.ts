import { NextRequest, NextResponse } from 'next/server';
import { getQuote, getExpirations, getOptionsChain } from '@/lib/providers/tradier';
import { fetchEquityBars } from '@/lib/providers/equityBars';

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
import { generateRecommendations } from '@/lib/math/recommendations';
import { getSwapDataForTicker } from '@/lib/providers/dtcc';
import { fetchRegSHOThreshold, getShortInterestForTicker } from '@/lib/providers/finra';
import { scanTickerFlow } from '@/lib/providers/polygonFlow';
import { getMarketIndicators } from '@/lib/providers/fred';

export const maxDuration = 30;

interface EquityBar {
  o: number; h: number; l: number; c: number; v: number; t: number;
}

/**
 * Lightweight correlation context from equity bars — no extra API calls needed.
 */
function computeQuickCorrelationCtx(
  bars: EquityBar[],
  hvCurrent: number,
) {
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

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const ticker = symbol.toUpperCase();

  try {
    const [quote, expirations, historyBars] = await Promise.all([
      getQuote(ticker),
      getExpirations(ticker),
      fetchEquityBars(ticker, 250),
    ]);

    const spotPrice = quote.last;
    const nearExps = expirations.slice(0, 3); // 3 expirations max (was 4) to reduce API calls

    const chains = await Promise.all(
      nearExps.map(e => getOptionsChain(ticker, e.date).catch(() => null))
    ).then(c => c.filter((x): x is NonNullable<typeof x> => x !== null));

    if (chains.length === 0) {
      return NextResponse.json({ error: 'No chain data available' }, { status: 500 });
    }

    // Aggregate GEX across expirations
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
    const gammaFlip = findGammaFlip(aggExposures, spotPrice);
    const callWall = findCallWall(aggExposures);
    const putWall = findPutWall(aggExposures);

    const nearChain = chains[0];
    const maxPain = computeMaxPain(
      nearChain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest })),
      nearChain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }))
    );

    const totalCallVol = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalPutVol = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalCallOI = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const totalPutOI = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const volumePCR = totalCallVol > 0 ? totalPutVol / totalCallVol : 1;
    const oiPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

    // ATM IV from nearest chain
    const atmTolerance = spotPrice < 20 ? 0.10 : spotPrice < 50 ? 0.05 : 0.02;
    const atmOpts = [...nearChain.calls, ...nearChain.puts]
      .filter(o => Math.abs(o.strike - spotPrice) / spotPrice < atmTolerance && o.impliedVolatility > 0.01)
      .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
    let currentIV = atmOpts.length > 0
      ? atmOpts.slice(0, 4).reduce((s, o) => s + o.impliedVolatility, 0) / Math.min(4, atmOpts.length)
      : 0;

    const closes = historyBars.map((b: EquityBar) => b.c).reverse();
    const hvCurrent = computeHistoricalVolatility(closes, 20);

    if (currentIV === 0 && hvCurrent > 0) {
      currentIV = hvCurrent * 1.15;
    }

    const historicalIVs = closes.slice(0, 252).map((_: number, i: number) => {
      const hv = computeHistoricalVolatility(closes.slice(i), 20);
      return hv > 0 ? hv * 1.15 : 0;
    }).filter((v: number) => v > 0);
    const ivMetrics = computeIVRankPercentile(currentIV, historicalIVs);
    const ivHvRatio = hvCurrent > 0 ? currentIV / hvCurrent : 1;

    const skew = computeSkew(nearChain.calls, nearChain.puts, spotPrice);

    const profile = computeStockProfile(
      historyBars.map((b: EquityBar) => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
      spotPrice,
      hvCurrent
    );

    const correlationCtx = computeQuickCorrelationCtx(historyBars, hvCurrent);

    // Fetch DTCC + FINRA data — independent per-provider timeouts so slow ones don't block fast ones
    const raceTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
      Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

    // Compute aggregate vanna & charm from exposure data (already calculated above)
    const totalVanna = aggExposures.reduce((s, e) => s + e.netVanna, 0);
    const totalCharm = aggExposures.reduce((s, e) => s + e.netCharm, 0);

    // IV term structure: compare ATM IV of nearest expiration vs next
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

    // OI Concentration — top 3 call + put strikes as % of total
    const callsByOI = [...nearChain.calls].sort((a, b) => b.openInterest - a.openInterest);
    const putsByOI = [...nearChain.puts].sort((a, b) => b.openInterest - a.openInterest);
    const top3CallOI = callsByOI.slice(0, 3).reduce((s, c) => s + c.openInterest, 0);
    const top3PutOI = putsByOI.slice(0, 3).reduce((s, p) => s + p.openInterest, 0);
    const totalCallOIForConc = nearChain.calls.reduce((s, c) => s + c.openInterest, 0);
    const totalPutOIForConc = nearChain.puts.reduce((s, p) => s + p.openInterest, 0);
    const oiConcentration = (totalCallOIForConc + totalPutOIForConc) > 0
      ? ((top3CallOI / Math.max(1, totalCallOIForConc)) * 100 + (top3PutOI / Math.max(1, totalPutOIForConc)) * 100) / 2
      : undefined;

    const emptyFlow = { tickerFlow: { ticker, netPremium: 0, callPremium: 0, putPremium: 0, callVolume: 0, putVolume: 0, contractsActive: 0 }, alerts: [] as { tradeType: string; sentiment: string }[] };
    const emptyIndicators = { vix: null, skew: null };
    // DTCC swap ZIP skipped — decompressing peaks at 200-400MB, OOM-kills on Vercel
    const [swapData, regSHOSet, siData, flowData, indicators] = await Promise.all([
      Promise.resolve(null as Awaited<ReturnType<typeof getSwapDataForTicker>>),
      raceTimeout(fetchRegSHOThreshold().catch(() => new Set<string>()), 4000, new Set<string>()),
      raceTimeout(getShortInterestForTicker(ticker).catch(() => null), 5000, null),
      raceTimeout(scanTickerFlow(ticker).catch(() => emptyFlow), 5000, emptyFlow),
      raceTimeout(getMarketIndicators().catch(() => emptyIndicators), 3000, emptyIndicators),
    ]);

    const input = {
      symbol: ticker,
      spotPrice,
      totalGEX,
      totalDEX,
      gammaFlip,
      callWall,
      putWall,
      maxPain: maxPain.strike,
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
      swapMaturitiesToday: swapData?.maturitiesToday,
      swapNotionalToday: swapData?.notionalToday,
      swapMaturitiesWeek: swapData?.maturitiesWeek,
      swapNotionalWeek: swapData?.notionalWeek,
      shortInterest: siData?.shortInterest,
      daysToCover: siData?.daysToCover,
      regSHOThreshold: regSHOSet.has(ticker),
      // Options flow data
      flowNetPremium: flowData.tickerFlow.netPremium || undefined,
      flowCallPremium: flowData.tickerFlow.callPremium || undefined,
      flowPutPremium: flowData.tickerFlow.putPremium || undefined,
      flowSentiment: flowData.tickerFlow.netPremium > 0 ? 'bullish' as const : flowData.tickerFlow.netPremium < 0 ? 'bearish' as const : undefined,
      flowAlertCount: flowData.alerts.length || undefined,
      flowSweepCount: flowData.alerts.filter(a => a.tradeType === 'sweep').length || undefined,
      flowBlockCount: flowData.alerts.filter(a => a.tradeType === 'block').length || undefined,
      // Greeks-derived dealer flow
      totalVanna: totalVanna || undefined,
      totalCharm: totalCharm || undefined,
      // IV term structure
      nearTermIV,
      nextTermIV,
      // OI concentration
      oiConcentration,
      // VIX level
      vixLevel: indicators.vix?.current ?? undefined,
      isMarketOpen: isMarketOpenNow(),
    };

    const recommendations = generateRecommendations(input);
    return NextResponse.json(recommendations);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[recommendations] Error:', error);
    return NextResponse.json({
      error: message,
      stack: stack?.split('\n').slice(0, 10),
      route: '/api/market/recommendations',
    }, { status: 500 });
  }
}
