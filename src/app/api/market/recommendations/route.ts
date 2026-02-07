import { NextRequest, NextResponse } from 'next/server';
import { getQuote, getExpirations, getOptionsChain } from '@/lib/providers/tradier';
import { getEquityHistory } from '@/lib/providers/polygon';
import {
  computeDealerExposureFromChain,
  findGammaFlip,
  findCallWall,
  findPutWall,
  computeMaxPain,
  computePCR,
} from '@/lib/math/blackScholes';
import {
  computeHistoricalVolatility,
  computeIVRankPercentile,
  computeSkew,
} from '@/lib/math/analytics';
import {
  generateRecommendations,
  type RecommendationInput,
} from '@/lib/math/recommendations';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const ticker = symbol.toUpperCase();

  try {
    // Fetch all data in parallel
    const [quote, expirations, historyBars] = await Promise.all([
      getQuote(ticker),
      getExpirations(ticker),
      getEquityHistory(
        ticker, 1, 'day',
        new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        new Date().toISOString().split('T')[0]
      ).catch(() => []),
    ]);

    const spotPrice = quote.last;
    const nearExps = expirations.slice(0, 4);

    // Fetch chains for nearest expirations
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

    // Aggregate by strike
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

    // Max pain from nearest expiration
    const nearChain = chains[0];
    const maxPain = computeMaxPain(
      nearChain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest })),
      nearChain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }))
    );

    // PCR across all expirations
    const totalCallVol = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalPutVol = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalCallOI = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const totalPutOI = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const volumePCR = totalCallVol > 0 ? totalPutVol / totalCallVol : 1;
    const oiPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

    // IV from nearest chain ATM options
    const atmOpts = [...nearChain.calls, ...nearChain.puts]
      .filter(o => Math.abs(o.strike - spotPrice) / spotPrice < 0.02 && o.impliedVolatility > 0.01)
      .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
    const currentIV = atmOpts.length > 0
      ? atmOpts.slice(0, 4).reduce((s, o) => s + o.impliedVolatility, 0) / Math.min(4, atmOpts.length)
      : 0;

    // HV from Polygon equity history
    const closes = historyBars.map(b => b.c).reverse();
    const hvCurrent = computeHistoricalVolatility(closes, 20);

    // IV Rank
    const historicalIVs = closes.slice(0, 252).map((_, i) => {
      const hv = computeHistoricalVolatility(closes.slice(i), 20);
      return hv > 0 ? hv * 1.15 : 0;
    }).filter(v => v > 0);
    const ivMetrics = computeIVRankPercentile(currentIV, historicalIVs);
    const ivHvRatio = hvCurrent > 0 ? currentIV / hvCurrent : 1;

    // Skew
    const skew = computeSkew(nearChain.calls, nearChain.puts, spotPrice);

    // Build input
    const input: RecommendationInput = {
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
      ivRank: ivMetrics.ivRank,
      ivPercentile: ivMetrics.ivPercentile,
      currentIV,
      hvCurrent,
      ivHvRatio,
      skewBias: skew.skewBias,
      skewRatio: skew.skewRatio,
      changePercent: quote.changePct,
      nearestExp: nearExps[0]?.date || '',
      nearestDTE: nearExps[0]?.dte || 0,
      weeklyExp: nearExps.find(e => e.dte >= 5 && e.dte <= 8)?.date,
      monthlyExp: nearExps.find(e => e.dte >= 25 && e.dte <= 45)?.date,
    };

    const recommendations = generateRecommendations(input);

    return NextResponse.json(recommendations);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
