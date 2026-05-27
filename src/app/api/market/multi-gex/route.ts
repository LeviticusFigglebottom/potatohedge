import { NextRequest, NextResponse } from 'next/server';
import { getOptionsChain, getExpirations } from '@/lib/providers/tradier';
import type { OptionContract, OptionsChain } from '@/types/market';
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

// ─── Defaults ──────────────────────────────────────────────────────
const DEFAULT_MAX_DTE = 45;
const DEFAULT_MAX_EXPIRATIONS = 30;
const DEFAULT_MIN_OI = 100;
const DEFAULT_MAX_SPREAD_RATIO = 0.30;
const CONCURRENCY = 5;
const CHAIN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── In-memory chain cache ─────────────────────────────────────────
// Module-scoped, process-lifetime, hour-bucketed key. TTL eviction via
// setTimeout on insert. Cold-start wipes; first request after deploy
// pays Tradier latency, subsequent serve from memory.
interface CacheEntry { chain: OptionsChain; ts: number; }
const chainCache = new Map<string, CacheEntry>();

function hourBucket(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}`;
}
function cacheKey(symbol: string, expiry: string): string {
  return `${symbol}:${expiry}:${hourBucket()}`;
}
async function getCachedChain(symbol: string, expiry: string, spot: number): Promise<OptionsChain | null> {
  const key = cacheKey(symbol, expiry);
  const hit = chainCache.get(key);
  if (hit) return hit.chain;
  try {
    const chain = await getOptionsChain(symbol, expiry, spot);
    chainCache.set(key, { chain, ts: Date.now() });
    setTimeout(() => chainCache.delete(key), CHAIN_CACHE_TTL_MS).unref?.();
    return chain;
  } catch {
    return null;
  }
}

// ─── Concurrency-capped async pool ─────────────────────────────────
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Quality filter for exposure inputs ────────────────────────────
// Applied to calls/puts before they enter computeDealerExposureFromChain.
// PCR, max-pain, OI concentration use the UNFILTERED chain — they're
// position aggregates that benefit from full coverage.
function qualityFilterFactory(minOI: number, maxSpreadRatio: number) {
  return (c: OptionContract): boolean => {
    if (c.openInterest < minOI) return false;
    if (c.bid <= 0) return false; // also catches the "no quote" case
    const m = c.mid > 0 ? c.mid : (c.bid + c.ask) / 2;
    if (m <= 0) return false;
    if ((c.ask - c.bid) > maxSpreadRatio * m) return false;
    return true;
  };
}

// ─── Sign-convention dev-mode sanity check ─────────────────────────
// Fires once per process. Catches refactor regressions that flip the
// dealer-positioning sign without updating findCallWall/findPutWall.
// At the call wall the net dealer GEX should be positive (dealers long
// gamma → suppressive); at the put wall it should be negative (dealers
// short gamma → amplifying).
let signCheckDone = false;
function maybeSignConventionCheck(
  exposures: StrikeExposure[],
  callWall: number | null,
  putWall: number | null,
): void {
  if (signCheckDone || process.env.NODE_ENV === 'production') return;
  signCheckDone = true;
  if (callWall != null) {
    const e = exposures.find((x) => x.strike === callWall);
    if (e && e.netGEX < 0) {
      console.warn(
        `[multi-gex] sign-convention warning: callWall=${callWall} has netGEX=${e.netGEX.toFixed(2)} (<0). ` +
        `Dealer-positioning convention expects callWall netGEX >= 0. Check that callGEX/putGEX signs in ` +
        `computeDealerExposureFromChain still match the convention in blackScholes.ts:5-9.`,
      );
    }
  }
  if (putWall != null) {
    const e = exposures.find((x) => x.strike === putWall);
    if (e && e.netGEX > 0) {
      console.warn(
        `[multi-gex] sign-convention warning: putWall=${putWall} has netGEX=${e.netGEX.toFixed(2)} (>0). ` +
        `Dealer-positioning convention expects putWall netGEX <= 0.`,
      );
    }
  }
}

// ─── Handler ───────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  const maxDTE = parseInt(request.nextUrl.searchParams.get('maxDTE') || String(DEFAULT_MAX_DTE));
  const maxExpirations = parseInt(request.nextUrl.searchParams.get('max') || String(DEFAULT_MAX_EXPIRATIONS));
  const minOI = parseInt(request.nextUrl.searchParams.get('minOI') || String(DEFAULT_MIN_OI));
  const maxSpreadRatio = parseFloat(request.nextUrl.searchParams.get('maxSpreadRatio') || String(DEFAULT_MAX_SPREAD_RATIO));

  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const SYMBOL = symbol.toUpperCase();
  const qualityFilter = qualityFilterFactory(minOI, maxSpreadRatio);

  try {
    // Get expirations, filter by DTE bound, apply safety cap.
    // The DTE bound is the operative limit; `max` is a defensive ceiling
    // against pathological Tradier responses (e.g. unbounded LEAPS lists).
    const expirations = await getExpirations(SYMBOL);
    const withinDTE = expirations.filter((e) => e.dte <= maxDTE);
    const eligible = withinDTE.slice(0, Math.min(maxExpirations, withinDTE.length));

    if (eligible.length === 0) {
      return NextResponse.json({ error: 'No expirations found within DTE bound' }, { status: 404 });
    }

    // Concurrency-capped fetch with per-(symbol, expiry, hour) cache.
    const chains = await pMap(
      eligible,
      (exp) => getCachedChain(SYMBOL, exp.date, 0),
      CONCURRENCY,
    );

    const validChains = chains.filter((c): c is NonNullable<typeof c> => c !== null && (c.calls.length > 0 || c.puts.length > 0));
    if (validChains.length === 0) {
      return NextResponse.json({ error: 'No chain data' }, { status: 500 });
    }

    const spotPrice = validChains[0].underlyingPrice;

    // Compute per-expiration analytics
    const perExpiration = validChains.map((chain) => {
      const callsQ = chain.calls.filter(qualityFilter);
      const putsQ = chain.puts.filter(qualityFilter);

      const exposures = computeDealerExposureFromChain(
        callsQ.map((c: OptionContract) => ({ strike: c.strike, openInterest: c.openInterest, impliedVolatility: c.impliedVolatility, gamma: c.gamma, delta: c.delta, dte: c.dte })),
        putsQ.map((p: OptionContract) => ({ strike: p.strike, openInterest: p.openInterest, impliedVolatility: p.impliedVolatility, gamma: p.gamma, delta: p.delta, dte: p.dte })),
        spotPrice,
      );

      const totalGEX = exposures.reduce((s, e) => s + e.netGEX, 0);
      const totalDEX = exposures.reduce((s, e) => s + e.netDEX, 0);
      const totalVanna = exposures.reduce((s, e) => s + e.netVanna, 0);
      const totalCharm = exposures.reduce((s, e) => s + e.netCharm, 0);

      // PCR uses unfiltered chain — position aggregates benefit from full coverage
      const pcr = computePCR(
        chain.calls.map((c: OptionContract) => ({ volume: c.volume, openInterest: c.openInterest })),
        chain.puts.map((p: OptionContract) => ({ volume: p.volume, openInterest: p.openInterest })),
      );

      return {
        expiration: chain.expiration,
        dte: chain.calls[0]?.dte ?? chain.puts[0]?.dte ?? 0,
        totalGEX, totalDEX, totalVanna, totalCharm,
        callVolume: pcr.totalCallVol,
        putVolume: pcr.totalPutVol,
        callOI: pcr.totalCallOI,
        putOI: pcr.totalPutOI,
        volumePCR: pcr.volumePCR,
        oiPCR: pcr.oiPCR,
        exposures,
        // Diagnostics: how aggressive was the quality filter on this expiry?
        contractsRaw: chain.calls.length + chain.puts.length,
        contractsKept: callsQ.length + putsQ.length,
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
    const gammaFlip = findGammaFlip(aggregatedExposures, spotPrice);
    const callWall = findCallWall(aggregatedExposures);
    const putWall = findPutWall(aggregatedExposures);

    maybeSignConventionCheck(aggregatedExposures, callWall, putWall);

    // Max pain for nearest expiration — uses unfiltered chain
    const nearestChain = validChains[0];
    const maxPain = computeMaxPain(
      nearestChain.calls.map((c: OptionContract) => ({ strike: c.strike, openInterest: c.openInterest })),
      nearestChain.puts.map((p: OptionContract) => ({ strike: p.strike, openInterest: p.openInterest })),
    );

    // Volume totals across all exps
    const totalCallVol = perExpiration.reduce((s, e) => s + e.callVolume, 0);
    const totalPutVol = perExpiration.reduce((s, e) => s + e.putVolume, 0);
    const totalCallOI = perExpiration.reduce((s, e) => s + e.callOI, 0);
    const totalPutOI = perExpiration.reduce((s, e) => s + e.putOI, 0);
    const aggPCR = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;
    const aggOIPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    // Skew analysis from nearest expiration (unfiltered — IV needs the wings)
    const skew = computeSkew(nearestChain.calls, nearestChain.puts, spotPrice);

    // OI concentration — unfiltered
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
      symbol: SYMBOL,
      spotPrice,
      expirationsCovered: eligible.map((e) => e.date),

      // Filter / fetch diagnostics for PR audits & future debugging.
      filters: { maxDTE, maxExpirations, minOI, maxSpreadRatio },

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
