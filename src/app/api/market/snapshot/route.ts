import { NextRequest, NextResponse } from 'next/server';
import { getOptionsSnapshot } from '@/lib/providers/polygon';
import { getEquityHistory } from '@/lib/providers/polygon';
import { computeIVRankPercentile, computeHistoricalVolatility, interpretIV, type IVContext } from '@/lib/math/analytics';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  try {
    // Fetch Polygon options snapshot + historical equity data in parallel
    const [snapshot, historyBars] = await Promise.all([
      getOptionsSnapshot(symbol.toUpperCase()).catch(() => []),
      getEquityHistory(
        symbol.toUpperCase(), 1, 'day',
        new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        new Date().toISOString().split('T')[0]
      ).catch(() => []),
    ]);

    const spotPrice = snapshot[0]?.underlying_asset?.price || 0;

    // Compute current ATM IV from snapshot
    const atm = snapshot
      .filter(o => Math.abs(o.details.strike_price - spotPrice) / spotPrice < 0.03 && o.implied_volatility > 0)
      .sort((a, b) => Math.abs(a.details.strike_price - spotPrice) - Math.abs(b.details.strike_price - spotPrice));

    const currentIV = atm.length > 0
      ? atm.slice(0, 4).reduce((s, o) => s + o.implied_volatility, 0) / Math.min(4, atm.length)
      : 0;

    // Extract IV time series from snapshot expirations as proxy
    // For proper IV history we'd need historical chain data; use snapshot variance as approximation
    const ivByExpiration = new Map<string, number[]>();
    for (const opt of snapshot) {
      if (opt.implied_volatility > 0 && opt.implied_volatility < 3) {
        const exp = opt.details.expiration_date;
        if (!ivByExpiration.has(exp)) ivByExpiration.set(exp, []);
        ivByExpiration.get(exp)!.push(opt.implied_volatility);
      }
    }

    // IV term structure (ATM IV per expiration)
    const termStructure: { expiration: string; dte: number; atmIV: number }[] = [];
    const now = new Date();
    for (const [exp, ivs] of ivByExpiration.entries()) {
      const dte = Math.ceil((new Date(exp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (dte <= 0 || dte > 365) continue;

      // Find near-ATM options for this expiration
      const expOpts = snapshot.filter(o =>
        o.details.expiration_date === exp &&
        Math.abs(o.details.strike_price - spotPrice) / spotPrice < 0.05 &&
        o.implied_volatility > 0
      );
      if (expOpts.length === 0) continue;

      const atmIV = expOpts.reduce((s, o) => s + o.implied_volatility, 0) / expOpts.length;
      termStructure.push({ expiration: exp, dte, atmIV });
    }
    termStructure.sort((a, b) => a.dte - b.dte);

    // Historical volatility from equity closes
    const closes = historyBars.map(b => b.c).reverse(); // newest first
    const hv20 = computeHistoricalVolatility(closes, 20);
    const hv60 = computeHistoricalVolatility(closes, 60);

    // Simulate historical IV from HV with a premium (rough approximation)
    // In production, you'd use Polygon historical options data or ORATS
    const historicalIVs = closes.slice(0, 252).map((_, i) => {
      const localHV = computeHistoricalVolatility(closes.slice(i), 20);
      return localHV * 1.15; // typical IV premium over HV
    }).filter(v => v > 0);

    const ivMetrics = computeIVRankPercentile(currentIV, historicalIVs);
    const ivHvRatio = hv20 > 0 ? currentIV / hv20 : 1;

    const ivContext: IVContext = {
      currentIV,
      ivRank: ivMetrics.ivRank,
      ivPercentile: ivMetrics.ivPercentile,
      iv30dMA: ivMetrics.iv30dMA,
      iv52wHigh: ivMetrics.iv52wHigh,
      iv52wLow: ivMetrics.iv52wLow,
      hvCurrent: hv20,
      ivHvRatio,
      interpretation: '',
    };
    ivContext.interpretation = interpretIV(ivContext);

    // Skew surface data (strike vs IV for each expiration)
    const skewSurface: { expiration: string; dte: number; points: { strike: number; iv: number; type: string; delta: number }[] }[] = [];
    for (const [exp, _] of ivByExpiration.entries()) {
      const dte = Math.ceil((new Date(exp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (dte <= 0 || dte > 90) continue;

      const expOpts = snapshot
        .filter(o => o.details.expiration_date === exp && o.implied_volatility > 0 && o.implied_volatility < 3)
        .map(o => ({
          strike: o.details.strike_price,
          iv: o.implied_volatility,
          type: o.details.contract_type,
          delta: o.greeks?.delta ?? 0,
        }))
        .sort((a, b) => a.strike - b.strike);

      if (expOpts.length > 3) {
        skewSurface.push({ expiration: exp, dte, points: expOpts });
      }
    }
    skewSurface.sort((a, b) => a.dte - b.dte);

    return NextResponse.json({
      symbol: symbol.toUpperCase(),
      spotPrice,
      iv: ivContext,
      termStructure,
      skewSurface: skewSurface.slice(0, 6), // Nearest 6 expirations
      historicalVol: { hv20, hv60 },
      snapshotCount: snapshot.length,
      timestamp: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
