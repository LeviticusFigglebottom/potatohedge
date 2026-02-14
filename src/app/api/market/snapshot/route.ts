import { NextRequest, NextResponse } from 'next/server';
import { getOptionsSnapshot } from '@/lib/providers/polygon';
import { fetchEquityBars } from '@/lib/providers/equityBars';
import { getOptionsChain, getExpirations, getQuote } from '@/lib/providers/tradier';
import { getVIXHistory, getMarketIndicators } from '@/lib/providers/fred';
import {
  computeIVRankPercentile,
  computeHistoricalVolatility,
  interpretIV,
  type IVContext,
} from '@/lib/math/analytics';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const ticker = symbol.toUpperCase();

  try {
    // Fetch all data sources in parallel:
    // 1. Tradier nearest chain (reliable ORATS IV)
    // 2. Polygon equity history (for HV computation)
    // 3. Polygon options snapshot (for term structure + skew surface)
    // 4. VIX real-time quote (for market vol context)
    // 5. VIX history from FRED (for time-series overlay)
    const [expirations, historyBars, polygonSnapshot, vixQuote, vixHistory, fredIndicators] = await Promise.all([
      getExpirations(ticker).catch(() => []),
      fetchEquityBars(ticker, 400),
      getOptionsSnapshot(ticker).catch(() => []),
      getQuote('VIX').catch(() => null),
      getVIXHistory(400).catch(() => []),
      getMarketIndicators().catch(() => ({ vix: null, skew: null })),
    ]);

    // Fetch nearest 3 Tradier chains for ATM IV across expirations
    const nearExps = expirations.slice(0, 3);
    const tradierChains = await Promise.all(
      nearExps.map(e => getOptionsChain(ticker, e.date).catch(() => null))
    ).then(chains => chains.filter((c): c is NonNullable<typeof c> => c !== null));

    const spotPrice = tradierChains[0]?.underlyingPrice ||
      polygonSnapshot[0]?.underlying_asset?.price || 0;

    // ── Current ATM IV from Tradier (primary, reliable) ──
    let currentIV = 0;
    const tradierATMIVs: number[] = [];

    for (const chain of tradierChains.slice(0, 1)) { // nearest expiration only
      const allOpts = [...chain.calls, ...chain.puts];
      const atm = allOpts
        .filter(o =>
          Math.abs(o.strike - spotPrice) / spotPrice < 0.02 &&
          o.impliedVolatility > 0.01 &&
          o.impliedVolatility < 3
        )
        .sort((a, b) =>
          Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice)
        );
      for (const o of atm.slice(0, 6)) {
        tradierATMIVs.push(o.impliedVolatility);
      }
    }

    if (tradierATMIVs.length > 0) {
      currentIV = tradierATMIVs.reduce((s, v) => s + v, 0) / tradierATMIVs.length;
    }

    // ── IV Term Structure from Tradier chains ──
    const termStructure: { expiration: string; dte: number; atmIV: number }[] = [];
    for (const chain of tradierChains) {
      const allOpts = [...chain.calls, ...chain.puts];
      const atm = allOpts
        .filter(o =>
          Math.abs(o.strike - spotPrice) / spotPrice < 0.03 &&
          o.impliedVolatility > 0.01
        )
        .sort((a, b) =>
          Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice)
        );
      if (atm.length > 0) {
        const atmIV = atm.slice(0, 4).reduce((s, o) => s + o.impliedVolatility, 0) / Math.min(4, atm.length);
        const dte = atm[0].dte;
        termStructure.push({ expiration: chain.expiration, dte, atmIV });
      }
    }

    // Supplement term structure from Polygon snapshot for longer-dated
    if (polygonSnapshot.length > 0) {
      const coveredExps = new Set(termStructure.map(t => t.expiration));
      const now = new Date();
      const ivByExp = new Map<string, { ivs: number[]; dte: number }>();

      for (const opt of polygonSnapshot) {
        if (opt.implied_volatility > 0.01 && opt.implied_volatility < 3) {
          const exp = opt.details.expiration_date;
          if (coveredExps.has(exp)) continue;
          if (Math.abs(opt.details.strike_price - spotPrice) / spotPrice > 0.05) continue;

          const dte = Math.ceil((new Date(exp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          if (dte <= 0 || dte > 365) continue;

          if (!ivByExp.has(exp)) ivByExp.set(exp, { ivs: [], dte });
          ivByExp.get(exp)!.ivs.push(opt.implied_volatility);
        }
      }

      for (const [exp, data] of ivByExp.entries()) {
        if (data.ivs.length > 0) {
          const atmIV = data.ivs.reduce((s, v) => s + v, 0) / data.ivs.length;
          termStructure.push({ expiration: exp, dte: data.dte, atmIV });
        }
      }
    }
    termStructure.sort((a, b) => a.dte - b.dte);

    // ── Historical Volatility from Polygon equity bars ──
    const closes = historyBars.map(b => b.c).reverse(); // newest first
    const hv20 = computeHistoricalVolatility(closes, 20);
    const hv60 = computeHistoricalVolatility(closes, 60);

    // ── IV Rank/Percentile ──
    // Build historical IV proxy from HV with typical premium
    const historicalIVs = closes.slice(0, 252).map((_, i) => {
      const localHV = computeHistoricalVolatility(closes.slice(i), 20);
      return localHV > 0 ? localHV * 1.15 : 0; // typical IV premium
    }).filter(v => v > 0);

    const ivMetrics = computeIVRankPercentile(currentIV, historicalIVs);
    const ivHvRatio = hv20 > 0 ? currentIV / hv20 : 1;

    const vixPrice = vixQuote?.last ?? 0;

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
    ivContext.interpretation = interpretIV(ivContext, vixPrice);

    // ── Skew Surface from Tradier chains (reliable) + Polygon supplement ──
    // Key: filter out garbage IVs that create spikes
    // - Cap at 2.5x ATM IV (was 3x) with lower floor
    // - Delta filter scales with DTE (near-term options need stricter filter)
    // - Skip 0-1 DTE (too noisy for meaningful skew)
    const maxSkewIV = currentIV > 0 ? Math.max(currentIV * 2.5, 0.40) : 1.5;

    function minDeltaForDTE(dte: number): number {
      if (dte <= 3) return 0.10;  // Very near-term: only keep 10%+ delta
      if (dte <= 7) return 0.07;  // Weekly: 7%+
      if (dte <= 21) return 0.05; // Monthly: 5%+
      return 0.04;                // Longer: 4%+
    }

    const skewSurface: {
      expiration: string; dte: number;
      points: { strike: number; iv: number; type: string; delta: number }[];
    }[] = [];

    // Primary: Tradier chains
    for (const chain of tradierChains) {
      const dte = chain.calls[0]?.dte ?? chain.puts[0]?.dte ?? 0;
      if (dte < 2) continue; // skip 0-1 DTE (too noisy for skew)

      const minDelta = minDeltaForDTE(dte);
      const points: { strike: number; iv: number; type: string; delta: number }[] = [];
      for (const c of chain.calls) {
        if (c.impliedVolatility > 0.01 && c.impliedVolatility < maxSkewIV &&
            Math.abs(c.delta) > minDelta &&
            c.strike >= spotPrice * 0.88 && c.strike <= spotPrice * 1.12) {
          points.push({ strike: c.strike, iv: c.impliedVolatility, type: 'call', delta: c.delta });
        }
      }
      for (const p of chain.puts) {
        if (p.impliedVolatility > 0.01 && p.impliedVolatility < maxSkewIV &&
            Math.abs(p.delta) > minDelta &&
            p.strike >= spotPrice * 0.88 && p.strike <= spotPrice * 1.12) {
          points.push({ strike: p.strike, iv: p.impliedVolatility, type: 'put', delta: p.delta });
        }
      }
      if (points.length > 3) {
        points.sort((a, b) => a.strike - b.strike);
        skewSurface.push({
          expiration: chain.expiration,
          dte,
          points,
        });
      }
    }

    // Supplement: Polygon snapshot for additional expirations
    if (polygonSnapshot.length > 0) {
      const coveredExps = new Set(skewSurface.map(s => s.expiration));
      const now = new Date();
      const byExp = new Map<string, { points: typeof skewSurface[0]['points']; dte: number }>();

      for (const opt of polygonSnapshot) {
        const exp = opt.details.expiration_date;
        if (coveredExps.has(exp)) continue;
        if (opt.implied_volatility <= 0.01 || opt.implied_volatility >= maxSkewIV) continue;
        if (opt.details.strike_price < spotPrice * 0.88 || opt.details.strike_price > spotPrice * 1.12) continue;

        const dte = Math.ceil((new Date(exp).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        if (dte < 2 || dte > 90) continue; // skip 0-1 DTE

        const minDelta = minDeltaForDTE(dte);
        if (opt.greeks?.delta !== undefined && Math.abs(opt.greeks.delta) < minDelta) continue;

        if (!byExp.has(exp)) byExp.set(exp, { points: [], dte });
        byExp.get(exp)!.points.push({
          strike: opt.details.strike_price,
          iv: opt.implied_volatility,
          type: opt.details.contract_type,
          delta: opt.greeks?.delta ?? 0,
        });
      }

      for (const [exp, data] of byExp.entries()) {
        if (data.points.length > 3) {
          data.points.sort((a, b) => a.strike - b.strike);
          skewSurface.push({ expiration: exp, dte: data.dte, points: data.points });
        }
      }
    }

    skewSurface.sort((a, b) => a.dte - b.dte);

    // ── Historical IV/HV time series for Analytics tab ──
    // Walk forward through chronological bars computing rolling HV20 and IV proxy
    const ivTimeSeries: { time: number; hv20: number; ivProxy: number; ivRank: number }[] = [];
    const barChronological = [...historyBars].sort((a, b) => a.t - b.t);
    const closesChron = barChronological.map(b => b.c);
    if (closesChron.length > 25) {
      for (let i = 21; i < closesChron.length; i++) {
        const window = closesChron.slice(i - 20, i + 1);
        const returns: number[] = [];
        for (let j = 1; j < window.length; j++) {
          if (window[j - 1] > 0 && window[j] > 0) {
            returns.push(Math.log(window[j] / window[j - 1]));
          }
        }
        if (returns.length < 2) continue;
        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
        const localHV = Math.sqrt(variance * 252);
        const localIVProxy = localHV * 1.15;

        // IV rank at this point: compare to all prior IV proxies
        const priorIVs = ivTimeSeries.map(p => p.ivProxy);
        let rank = 50;
        if (priorIVs.length >= 20) {
          const recent252 = priorIVs.slice(-252);
          const high = Math.max(...recent252);
          const low = Math.min(...recent252);
          rank = high > low ? Math.round(((localIVProxy - low) / (high - low)) * 100) : 50;
          rank = Math.max(0, Math.min(100, rank));
        }

        ivTimeSeries.push({
          time: Math.floor(barChronological[i].t / 1000),
          hv20: localHV,
          ivProxy: localIVProxy,
          ivRank: rank,
        });
      }
    }

    // ── VIX context ──
    const vixData = vixPrice > 0 ? {
      price: vixPrice,
      change: vixQuote?.change ?? 0,
      changePct: vixQuote?.changePct ?? 0,
    } : null;

    // Build VIX time series aligned with ivTimeSeries timestamps
    // FRED dates are YYYY-MM-DD strings, ivTimeSeries times are epoch seconds
    const vixTimeSeries: { time: number; vix: number }[] = [];
    if (vixHistory.length > 0) {
      for (const v of vixHistory) {
        const t = Math.floor(new Date(v.date + 'T16:00:00-05:00').getTime() / 1000);
        vixTimeSeries.push({ time: t, vix: v.value / 100 }); // Convert VIX to decimal like IV
      }
      vixTimeSeries.sort((a, b) => a.time - b.time);
    }

    return NextResponse.json({
      symbol: ticker,
      spotPrice,
      iv: ivContext,
      termStructure,
      skewSurface: skewSurface.slice(0, 8),
      historicalVol: { hv20, hv60 },
      ivTimeSeries: ivTimeSeries.slice(-252),
      vix: vixData,
      vixTimeSeries: vixTimeSeries.slice(-252),
      skew: fredIndicators.skew,
      snapshotCount: polygonSnapshot.length,
      tradierChainsUsed: tradierChains.length,
      timestamp: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
