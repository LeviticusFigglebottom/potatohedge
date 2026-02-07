import { NextRequest, NextResponse } from 'next/server';
import { getOptionsChain, getExpirations } from '@/lib/providers/tradier';
import {
  computeDealerExposureFromChain,
  findGammaFlip,
  findCallWall,
  findPutWall,
  computeMaxPain,
  computePCR,
  type StrikeExposure,
} from '@/lib/math/blackScholes';
import { interpretDealerPositioning, computeSkew, analyzeOIConcentration, interpretVolume } from '@/lib/math/analytics';

export const maxDuration = 30; // Vercel function timeout

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  const maxExpirations = parseInt(request.nextUrl.searchParams.get('max') || '4');

  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  try {
    // Get expirations and fetch chains for nearest N
    const expirations = await getExpirations(symbol.toUpperCase());
    const nearTerm = expirations.slice(0, Math.min(maxExpirations, expirations.length));

    if (nearTerm.length === 0) {
      return NextResponse.json({ error: 'No expirations found' }, { status: 404 });
    }

    // Fetch chains in parallel
    const chains = await Promise.all(
      nearTerm.map(exp => getOptionsChain(symbol.toUpperCase(), exp.date).catch(() => null))
    );

    const validChains = chains.filter((c): c is NonNullable<typeof c> => c !== null);
    if (validChains.length === 0) {
      return NextResponse.json({ error: 'No chain data' }, { status: 500 });
    }

    const spotPrice = validChains[0].underlyingPrice;

    // Compute per-expiration analytics
    const perExpiration = validChains.map(chain => {
      const exposures = computeDealerExposureFromChain(
        chain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest, impliedVolatility: c.impliedVolatility, gamma: c.gamma, delta: c.delta, dte: c.dte })),
        chain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest, impliedVolatility: p.impliedVolatility, gamma: p.gamma, delta: p.delta, dte: p.dte })),
        spotPrice
      );

      const totalGEX = exposures.reduce((s, e) => s + e.netGEX, 0);
      const totalDEX = exposures.reduce((s, e) => s + e.netDEX, 0);
      const totalVanna = exposures.reduce((s, e) => s + e.netVanna, 0);
      const totalCharm = exposures.reduce((s, e) => s + e.netCharm, 0);

      const pcr = computePCR(
        chain.calls.map(c => ({ volume: c.volume, openInterest: c.openInterest })),
        chain.puts.map(p => ({ volume: p.volume, openInterest: p.openInterest }))
      );

      return {
        expiration: chain.expiration,
        dte: chain.calls[0]?.dte ?? 0,
        totalGEX, totalDEX, totalVanna, totalCharm,
        callVolume: pcr.totalCallVol,
        putVolume: pcr.totalPutVol,
        callOI: pcr.totalCallOI,
        putOI: pcr.totalPutOI,
        volumePCR: pcr.volumePCR,
        oiPCR: pcr.oiPCR,
        exposures,
      };
    });

    // Aggregate GEX across all expirations
    const aggregatedMap = new Map<number, StrikeExposure>();
    for (const exp of perExpiration) {
      for (const e of exp.exposures) {
        const existing = aggregatedMap.get(e.strike);
        if (existing) {
          existing.callGEX += e.callGEX;
          existing.putGEX += e.putGEX;
          existing.netGEX += e.netGEX;
          existing.callDEX += e.callDEX;
          existing.putDEX += e.putDEX;
          existing.netDEX += e.netDEX;
          existing.callVanna += e.callVanna;
          existing.putVanna += e.putVanna;
          existing.netVanna += e.netVanna;
          existing.callCharm += e.callCharm;
          existing.putCharm += e.putCharm;
          existing.netCharm += e.netCharm;
        } else {
          aggregatedMap.set(e.strike, { ...e });
        }
      }
    }

    const aggregatedExposures = Array.from(aggregatedMap.values()).sort((a, b) => a.strike - b.strike);
    const totalGEX = aggregatedExposures.reduce((s, e) => s + e.netGEX, 0);
    const totalDEX = aggregatedExposures.reduce((s, e) => s + e.netDEX, 0);
    const totalVanna = aggregatedExposures.reduce((s, e) => s + e.netVanna, 0);
    const totalCharm = aggregatedExposures.reduce((s, e) => s + e.netCharm, 0);
    const gammaFlip = findGammaFlip(aggregatedExposures);
    const callWall = findCallWall(aggregatedExposures);
    const putWall = findPutWall(aggregatedExposures);

    // Max pain for nearest expiration
    const nearestChain = validChains[0];
    const maxPain = computeMaxPain(
      nearestChain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest })),
      nearestChain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }))
    );

    // Volume totals across all exps
    const totalCallVol = perExpiration.reduce((s, e) => s + e.callVolume, 0);
    const totalPutVol = perExpiration.reduce((s, e) => s + e.putVolume, 0);
    const totalCallOI = perExpiration.reduce((s, e) => s + e.callOI, 0);
    const totalPutOI = perExpiration.reduce((s, e) => s + e.putOI, 0);
    const aggPCR = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;
    const aggOIPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Skew analysis from nearest expiration
    const skew = computeSkew(nearestChain.calls, nearestChain.puts, spotPrice);

    // OI concentration
    const oiAnalysis = analyzeOIConcentration(nearestChain.calls, nearestChain.puts);

    // Volume context — we don't have historical daily options volume averages,
    // so we pass today=avg (ratio=1, honest). The meaningful signal is PCR
    // divergence (today's volume PCR vs accumulated OI PCR).
    const volumeCtx = interpretVolume(totalCallVol, totalPutVol, totalCallVol, totalPutVol, aggOIPCR);

    // Dealer positioning interpretation
    const dealerCtx = interpretDealerPositioning(
      spotPrice, totalGEX, totalDEX, gammaFlip, callWall, putWall, maxPain.strike, aggregatedExposures
    );

    return NextResponse.json({
      symbol: symbol.toUpperCase(),
      spotPrice,
      expirationsCovered: nearTerm.map(e => e.date),

      // Aggregated metrics
      aggregated: {
        totalGEX, totalDEX, totalVanna, totalCharm,
        gammaFlip, callWall, putWall,
        exposures: aggregatedExposures,
      },

      // Per-expiration breakdown
      perExpiration,

      // Volume & PCR
      volume: {
        totalCallVol, totalPutVol, totalCallOI, totalPutOI,
        volumePCR: aggPCR,
        oiPCR: aggOIPCR,
      },

      maxPain,
      skew,
      oiAnalysis,

      // Contextual interpretations
      context: {
        dealer: dealerCtx,
        volume: volumeCtx,
        skew,
        oi: oiAnalysis,
      },

      timestamp: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
