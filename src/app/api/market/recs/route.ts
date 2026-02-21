/**
 * Fresh-path test route — identical logic to /api/market/recommendations
 * but at a different URL path. If this works but /recommendations doesn't,
 * it's a Vercel deployment caching issue.
 *
 * This route incrementally tests each step and returns diagnostics
 * about which step succeeded/failed.
 */
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  const ticker = symbol.toUpperCase();
  const steps: Record<string, { ok: boolean; ms: number; error?: string; data?: unknown }> = {};

  // Step 1: Dynamic imports
  let tradier: Awaited<typeof import('@/lib/providers/tradier')>;
  let bars: Awaited<typeof import('@/lib/providers/equityBars')>;
  let bs: Awaited<typeof import('@/lib/math/blackScholes')>;
  let analytics: Awaited<typeof import('@/lib/math/analytics')>;
  let recs: Awaited<typeof import('@/lib/math/recommendations')>;
  let dtccMod: Awaited<typeof import('@/lib/providers/dtcc')>;
  let finraMod: Awaited<typeof import('@/lib/providers/finra')>;

  const t0 = Date.now();
  try {
    [tradier, bars, bs, analytics, recs, dtccMod, finraMod] = await Promise.all([
      import('@/lib/providers/tradier'),
      import('@/lib/providers/equityBars'),
      import('@/lib/math/blackScholes'),
      import('@/lib/math/analytics'),
      import('@/lib/math/recommendations'),
      import('@/lib/providers/dtcc'),
      import('@/lib/providers/finra'),
    ]);
    steps.imports = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    steps.imports = { ok: false, ms: Date.now() - t0, error: (e as Error).message };
    return NextResponse.json({ steps, completedAt: 'imports' }, { status: 500 });
  }

  // Step 2: getQuote
  let quote: Awaited<ReturnType<typeof tradier.getQuote>>;
  const t1 = Date.now();
  try {
    quote = await tradier.getQuote(ticker);
    steps.quote = { ok: true, ms: Date.now() - t1, data: { last: quote.last } };
  } catch (e) {
    steps.quote = { ok: false, ms: Date.now() - t1, error: (e as Error).message };
    return NextResponse.json({ steps, completedAt: 'quote' }, { status: 500 });
  }

  // Step 3: getExpirations
  let expirations: Awaited<ReturnType<typeof tradier.getExpirations>>;
  const t2 = Date.now();
  try {
    expirations = await tradier.getExpirations(ticker);
    steps.expirations = { ok: true, ms: Date.now() - t2, data: { count: expirations.length } };
  } catch (e) {
    steps.expirations = { ok: false, ms: Date.now() - t2, error: (e as Error).message };
    return NextResponse.json({ steps, completedAt: 'expirations' }, { status: 500 });
  }

  // Step 4: fetchEquityBars
  const t3 = Date.now();
  try {
    const history = await bars.fetchEquityBars(ticker, 400);
    steps.equityBars = { ok: true, ms: Date.now() - t3, data: { bars: history.length } };
  } catch (e) {
    steps.equityBars = { ok: false, ms: Date.now() - t3, error: (e as Error).message };
    return NextResponse.json({ steps, completedAt: 'equityBars' }, { status: 500 });
  }

  // Step 5: getOptionsChain for first expiration
  const t4 = Date.now();
  try {
    if (expirations.length > 0) {
      const chain = await tradier.getOptionsChain(ticker, expirations[0].date);
      steps.chain = { ok: true, ms: Date.now() - t4, data: { calls: chain.calls.length, puts: chain.puts.length } };
    } else {
      steps.chain = { ok: true, ms: 0, data: { skipped: 'no expirations' } };
    }
  } catch (e) {
    steps.chain = { ok: false, ms: Date.now() - t4, error: (e as Error).message };
    return NextResponse.json({ steps, completedAt: 'chain' }, { status: 500 });
  }

  // Step 6: DTCC + FINRA — independent timeouts per provider so slow ones don't block fast ones
  const t5 = Date.now();
  try {
    const raceTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
      Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

    // DTCC swap ZIP skipped — decompressing peaks at 200-400MB, OOM-kills on Vercel
    const swapT = Date.now();
    const swapResult = { _err: 'skipped-oom' };
    const swapMs = Date.now() - swapT;

    const regSHOT = Date.now();
    const regSHOResult = await raceTimeout(finraMod.fetchRegSHOThreshold().catch(() => new Set<string>()), 4000, new Set<string>());
    const regSHOMs = Date.now() - regSHOT;

    const siT = Date.now();
    const siResult = await raceTimeout(finraMod.getShortInterestForTicker(ticker).catch((e: Error) => ({ _err: e.message })), 5000, { _err: 'timeout' });
    const siMs = Date.now() - siT;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const swap = (swapResult as any)?._err ? null : swapResult;
    const regSHO = regSHOResult instanceof Set ? regSHOResult : new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const si = (siResult as any)?._err ? null : siResult;

    steps.institutional = {
      ok: true,
      ms: Date.now() - t5,
      data: {
        swap: !!swap, swapMs,
        regSHO: regSHO.size, regSHOMs,
        si: !!si, siMs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        swapErr: (swapResult as any)?._err || null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        siErr: (siResult as any)?._err || null,
      },
    };
  } catch (e) {
    steps.institutional = { ok: false, ms: Date.now() - t5, error: (e as Error).message };
  }

  // Step 7: blackScholes computation
  const t6 = Date.now();
  try {
    if (expirations.length > 0) {
      const chain = await tradier.getOptionsChain(ticker, expirations[0].date);
      const exposures = bs.computeDealerExposureFromChain(
        chain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest, impliedVolatility: c.impliedVolatility, gamma: c.gamma, delta: c.delta, dte: c.dte })),
        chain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest, impliedVolatility: p.impliedVolatility, gamma: p.gamma, delta: p.delta, dte: p.dte })),
        quote.last,
      );
      steps.blackScholes = { ok: true, ms: Date.now() - t6, data: { exposures: exposures.length } };
    } else {
      steps.blackScholes = { ok: true, ms: 0, data: { skipped: 'no expirations' } };
    }
  } catch (e) {
    steps.blackScholes = { ok: false, ms: Date.now() - t6, error: (e as Error).message };
  }

  // All steps completed
  return NextResponse.json({
    allOk: Object.values(steps).every(s => s.ok),
    steps,
    totalMs: Date.now() - t0,
    ticker,
  });
}
