import { NextRequest, NextResponse } from 'next/server';
import { getOptionsChain } from '@/lib/providers/tradier';
import {
  computeDealerExposureFromChain,
  findGammaFlip,
  findCallWall,
  findPutWall,
  computeMaxPain,
  computePCR,
} from '@/lib/math/blackScholes';

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  const expiration = request.nextUrl.searchParams.get('expiration');

  if (!symbol || !expiration) {
    return NextResponse.json({ error: 'symbol and expiration parameters required' }, { status: 400 });
  }

  try {
    const chain = await getOptionsChain(symbol.toUpperCase(), expiration);

    // Compute dealer exposure
    const exposures = computeDealerExposureFromChain(
      chain.calls.map(c => ({
        strike: c.strike,
        openInterest: c.openInterest,
        impliedVolatility: c.impliedVolatility,
        gamma: c.gamma,
        delta: c.delta,
        dte: c.dte,
      })),
      chain.puts.map(p => ({
        strike: p.strike,
        openInterest: p.openInterest,
        impliedVolatility: p.impliedVolatility,
        gamma: p.gamma,
        delta: p.delta,
        dte: p.dte,
      })),
      chain.underlyingPrice
    );

    const totalGEX = exposures.reduce((sum, e) => sum + e.netGEX, 0);
    const gammaFlip = findGammaFlip(exposures);
    const callWall = findCallWall(exposures);
    const putWall = findPutWall(exposures);

    // Max pain
    const maxPain = computeMaxPain(
      chain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest })),
      chain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }))
    );

    // PCR
    const pcr = computePCR(
      chain.calls.map(c => ({ volume: c.volume, openInterest: c.openInterest })),
      chain.puts.map(p => ({ volume: p.volume, openInterest: p.openInterest }))
    );

    // Generate interpretation
    const spot = chain.underlyingPrice;
    const interpretations: string[] = [];

    if (gammaFlip !== null) {
      if (spot > gammaFlip) {
        interpretations.push(`Spot ($${spot.toFixed(2)}) is ABOVE gamma flip ($${gammaFlip.toFixed(2)}) — dealers are long gamma, expect mean-reversion and compressed volatility.`);
      } else {
        interpretations.push(`Spot ($${spot.toFixed(2)}) is BELOW gamma flip ($${gammaFlip.toFixed(2)}) — dealers are short gamma, expect amplified directional moves.`);
      }
    }

    if (callWall) {
      interpretations.push(`Call Wall at $${callWall} — significant resistance from dealer hedging.`);
    }
    if (putWall) {
      interpretations.push(`Put Wall at $${putWall} — significant support from dealer hedging.`);
    }

    if (pcr.volumePCR > 1.2) {
      interpretations.push(`Volume P/C ratio ${pcr.volumePCR.toFixed(2)} — elevated put activity, bearish flow or hedging demand.`);
    } else if (pcr.volumePCR < 0.7) {
      interpretations.push(`Volume P/C ratio ${pcr.volumePCR.toFixed(2)} — elevated call activity, bullish flow.`);
    }

    interpretations.push(`Max Pain at $${maxPain.strike} — expiration magnet for this cycle.`);

    return NextResponse.json({
      gex: {
        totalGEX,
        gammaFlip,
        callWall,
        putWall,
        maxGammaStrike: exposures.reduce((max, e) => Math.abs(e.netGEX) > Math.abs(max.netGEX) ? e : max, exposures[0])?.strike ?? 0,
        exposures,
        spotPrice: spot,
      },
      maxPain,
      pcr,
      interpretations,
      timestamp: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
