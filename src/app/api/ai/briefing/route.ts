import { NextResponse } from 'next/server';
import { getQuote, getExpirations, getOptionsChain } from '@/lib/providers/tradier';
import { fetchEquityBars } from '@/lib/providers/equityBars';
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
import type { EquityBar } from '@/lib/providers/equityBars';
import { getMarketSwapSummary } from '@/lib/providers/dtcc';
import { fetchRegSHOThreshold, fetchShortInterest } from '@/lib/providers/finra';

export const maxDuration = 120;

// Stocks to analyze for the briefing
const INDICES = ['SPY', 'QQQ', 'IWM'];
const SECTOR_ETFS = ['XLF', 'XLE', 'XLK', 'XLV', 'XLI', 'XLRE', 'XLU', 'XLC', 'XLB', 'XLP', 'XLY'];
const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
const ALL_TICKERS = [...INDICES, ...SECTOR_ETFS, ...MAG7];
const CONCURRENCY = 5;

interface StockScan {
  symbol: string;
  price: number;
  changePct: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  biasScore: number;
  volRegime: 'high' | 'mid' | 'low';
  gammaRegime: 'long' | 'short' | 'neutral';
  ivRank: number;
  currentIV: number;
  hvCurrent: number;
  volumePCR: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number;
  topSignals: string[];
  warnings: string[];
}

function computeQuickCorrelationCtx(
  bars: EquityBar[], hvCurrent: number,
): RecommendationInput['correlationCtx'] {
  if (bars.length < 60) return undefined;
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0) returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c);
  }
  if (returns.length < 40) return undefined;
  const hvValues: number[] = [];
  for (let i = 20; i < returns.length; i++) {
    const w = returns.slice(i - 20, i);
    const mean = w.reduce((s, r) => s + r, 0) / w.length;
    const variance = w.reduce((s, r) => s + (r - mean) ** 2, 0) / (w.length - 1);
    hvValues.push(Math.sqrt(variance * 252));
  }
  const sorted = [...hvValues].sort((a, b) => a - b);
  const p33 = sorted[Math.floor(sorted.length * 0.33)] || 0;
  const lowVolWins5d: boolean[] = [];
  const lowVolRets: number[] = [];
  const highVolRets: number[] = [];
  for (let i = 0; i < hvValues.length - 20; i++) {
    const idx = i + 20;
    const fwd5 = returns.slice(idx, idx + 5).reduce((s, r) => s + r, 0);
    const fwd20 = returns.slice(idx, idx + 20).reduce((s, r) => s + r, 0);
    if (hvValues[i] <= p33) { lowVolRets.push(fwd20); lowVolWins5d.push(fwd5 > 0); }
    else if (hvValues[i] >= sorted[Math.floor(sorted.length * 0.66)] || 999) { highVolRets.push(fwd20); }
  }
  const dailySigma = hvCurrent > 0 ? hvCurrent / Math.sqrt(252) : 0.015;
  const bigUps: { next1d: number }[] = [];
  const bigDowns: { next1d: number; next5d: number }[] = [];
  for (let i = 0; i < returns.length - 5; i++) {
    if (Math.abs(returns[i]) < dailySigma * 2) continue;
    if (returns[i] > 0) bigUps.push({ next1d: returns[i + 1] || 0 });
    else bigDowns.push({ next1d: returns[i + 1] || 0, next5d: returns.slice(i + 1, i + 6).reduce((s, r) => s + r, 0) });
  }
  const avg = (a: number[]) => a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  return {
    meanReversionBounceRate: bigDowns.length > 3 ? bigDowns.filter(d => d.next1d > 0).length / bigDowns.length : 0.5,
    meanReversionPullbackRate: bigUps.length > 3 ? bigUps.filter(u => u.next1d < 0).length / bigUps.length : 0.5,
    avgRecovery5d: avg(bigDowns.map(d => d.next5d)),
    lowVolWinRate: lowVolWins5d.length > 5 ? lowVolWins5d.filter(Boolean).length / lowVolWins5d.length : 0.5,
    highVolAvg20d: avg(highVolRets), lowVolAvg20d: avg(lowVolRets),
    volOverpricingRate: 0.5, drawdownRatio: 1, alpha30d: 0,
  };
}

async function scanStock(ticker: string): Promise<StockScan | null> {
  try {
    const [quote, expirations, historyBars] = await Promise.all([
      getQuote(ticker),
      getExpirations(ticker),
      fetchEquityBars(ticker, 400),
    ]);
    const spotPrice = quote.last;
    if (!spotPrice || spotPrice <= 0) return null;
    const nearExps = expirations.slice(0, 4);
    if (nearExps.length === 0) return null;

    const chains = await Promise.all(
      nearExps.map(e => getOptionsChain(ticker, e.date).catch(() => null))
    ).then(c => c.filter((x): x is NonNullable<typeof x> => x !== null));
    if (chains.length === 0) return null;

    const allExposures = chains.flatMap(chain =>
      computeDealerExposureFromChain(
        chain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest, impliedVolatility: c.impliedVolatility, gamma: c.gamma, delta: c.delta, dte: c.dte })),
        chain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest, impliedVolatility: p.impliedVolatility, gamma: p.gamma, delta: p.delta, dte: p.dte })),
        spotPrice
      )
    );
    const byStrike = new Map<number, typeof allExposures[0]>();
    for (const e of allExposures) {
      const ex = byStrike.get(e.strike);
      if (ex) { ex.netGEX += e.netGEX; ex.netDEX += e.netDEX; ex.callGEX += e.callGEX; ex.putGEX += e.putGEX; }
      else byStrike.set(e.strike, { ...e });
    }
    const agg = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
    const totalGEX = agg.reduce((s, e) => s + e.netGEX, 0);
    const totalDEX = agg.reduce((s, e) => s + e.netDEX, 0);
    const gammaFlip = findGammaFlip(agg, spotPrice);
    const callWall = findCallWall(agg);
    const putWall = findPutWall(agg);
    const nearChain = chains[0];
    const maxPainResult = computeMaxPain(
      nearChain.calls.map(c => ({ strike: c.strike, openInterest: c.openInterest })),
      nearChain.puts.map(p => ({ strike: p.strike, openInterest: p.openInterest }))
    );
    const totalCallVol = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalPutVol = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.volume, 0), 0);
    const totalCallOI = chains.reduce((s, c) => s + c.calls.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const totalPutOI = chains.reduce((s, c) => s + c.puts.reduce((sv, o) => sv + o.openInterest, 0), 0);
    const volumePCR = totalCallVol > 0 ? totalPutVol / totalCallVol : 1;
    const oiPCR = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

    const atmTolerance = spotPrice < 20 ? 0.10 : spotPrice < 50 ? 0.05 : 0.02;
    const atmOpts = [...nearChain.calls, ...nearChain.puts]
      .filter(o => Math.abs(o.strike - spotPrice) / spotPrice < atmTolerance && o.impliedVolatility > 0.01)
      .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
    let currentIV = atmOpts.length > 0
      ? atmOpts.slice(0, 4).reduce((s, o) => s + o.impliedVolatility, 0) / Math.min(4, atmOpts.length)
      : 0;
    const closes = historyBars.map(b => b.c).reverse();
    const hvCurrent = computeHistoricalVolatility(closes, 20);
    if (currentIV === 0 && hvCurrent > 0) currentIV = hvCurrent * 1.15;
    const historicalIVs = closes.slice(0, 252).map((_, i) => {
      const hv = computeHistoricalVolatility(closes.slice(i), 20);
      return hv > 0 ? hv * 1.15 : 0;
    }).filter(v => v > 0);
    const ivMetrics = computeIVRankPercentile(currentIV, historicalIVs);
    const ivHvRatio = hvCurrent > 0 ? currentIV / hvCurrent : 1;
    const skew = computeSkew(nearChain.calls, nearChain.puts, spotPrice);
    const profile = computeStockProfile(historyBars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c })), spotPrice, hvCurrent);
    const correlationCtx = computeQuickCorrelationCtx(historyBars, hvCurrent);

    const input: RecommendationInput = {
      symbol: ticker, spotPrice, totalGEX, totalDEX, gammaFlip, callWall, putWall,
      maxPain: maxPainResult.strike, volumePCR, oiPCR,
      totalCallVol, totalPutVol, totalCallOI, totalPutOI,
      ivRank: ivMetrics.ivRank, ivPercentile: ivMetrics.ivPercentile,
      currentIV, hvCurrent, ivHvRatio,
      skewBias: skew.skewBias, skewRatio: skew.skewRatio,
      changePercent: quote.changePct,
      atr14: profile.atr14, atrPercent: profile.atrPercent,
      dailySigma: profile.dailySigma, avgDailyRangePct: profile.avgDailyRangePct,
      nearestExp: nearExps[0]?.date || '', nearestDTE: nearExps[0]?.dte || 0,
      weeklyExp: nearExps.find(e => e.dte >= 5 && e.dte <= 8)?.date,
      monthlyExp: nearExps.find(e => e.dte >= 25 && e.dte <= 45)?.date,
      correlationCtx,
    };
    const rec = generateRecommendations(input);

    return {
      symbol: ticker, price: spotPrice, changePct: quote.changePct,
      bias: rec.overallBias, biasScore: rec.biasScore,
      volRegime: rec.volRegime, gammaRegime: rec.gammaRegime,
      ivRank: ivMetrics.ivRank, currentIV, hvCurrent, volumePCR,
      gammaFlip, callWall, putWall, maxPain: maxPainResult.strike,
      topSignals: rec.signals.filter(s => s.weight !== 0).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 3).map(s => `[${s.direction}] ${s.name}: ${s.description}`),
      warnings: rec.warnings,
    };
  } catch {
    return null;
  }
}

function buildBriefingPrompt(
  stocks: StockScan[],
  vixPrice: number,
  swapSummary: { totalMaturitiesToday: number; totalNotionalToday: number; topMaturities: { symbol: string; count: number; notional: number }[]; asOf: string },
  regSHOList: string[],
): string {
  const indices = stocks.filter(s => INDICES.includes(s.symbol));
  const sectors = stocks.filter(s => SECTOR_ETFS.includes(s.symbol));
  const mag7 = stocks.filter(s => MAG7.includes(s.symbol));

  const fmtStock = (s: StockScan) => {
    const lines = [
      `${s.symbol}: $${s.price.toFixed(2)} (${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%) | Bias: ${s.biasScore > 0 ? '+' : ''}${s.biasScore} ${s.bias} | Gamma: ${s.gammaRegime} | IV: ${s.volRegime} (rank ${s.ivRank}) | PCR: ${s.volumePCR.toFixed(2)}`,
      `  Levels: γFlip=${s.gammaFlip ? '$' + s.gammaFlip.toFixed(0) : 'N/A'} CW=${s.callWall ? '$' + s.callWall.toFixed(0) : 'N/A'} PW=${s.putWall ? '$' + s.putWall.toFixed(0) : 'N/A'} MaxPain=$${s.maxPain.toFixed(0)}`,
      `  Top signals: ${s.topSignals.join(' | ') || 'none'}`,
    ];
    if (s.warnings.length > 0) lines.push(`  Warnings: ${s.warnings.join(', ')}`);
    return lines.join('\n');
  };

  let prompt = `You are a senior market strategist at a quantitative options desk. Generate a comprehensive DAILY MARKET BRIEFING based on live data analyzed across ${stocks.length} securities.

Write a professional, insightful analysis that a trader would read before the market opens. Be specific with numbers. Identify non-obvious patterns — sector rotations, divergences, unusual positioning, and regime changes.

═══════════════════════════════════════════
LIVE MARKET DATA — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
═══════════════════════════════════════════

VIX: ${vixPrice.toFixed(2)}

─── INDEX ANALYSIS ───
${indices.map(fmtStock).join('\n\n')}

─── SECTOR ETFs ───
${sectors.map(fmtStock).join('\n\n')}

─── MAGNIFICENT 7 ───
${mag7.map(fmtStock).join('\n\n')}`;

  if (swapSummary.totalMaturitiesToday > 0 || swapSummary.asOf) {
    const dateNote = swapSummary.asOf ? ` (report date: ${swapSummary.asOf})` : '';
    prompt += `\n\n─── DTCC SWAP MATURITIES${dateNote} ───`;
    if (swapSummary.totalMaturitiesToday > 0) {
      prompt += `\nTotal today: ${swapSummary.totalMaturitiesToday.toLocaleString()} swaps ($${(swapSummary.totalNotionalToday / 1e6).toFixed(0)}M notional)`;
      prompt += `\nTop: ${swapSummary.topMaturities.slice(0, 5).map(m => `${m.symbol}(${m.count},$${(m.notional / 1e6).toFixed(0)}M)`).join(', ')}`;
    } else {
      prompt += `\nNo swaps maturing today — report contains open positions only.`;
    }
  }

  if (regSHOList.length > 0) {
    prompt += `\n\n─── REG SHO THRESHOLD LIST ───
${regSHOList.length} securities: ${regSHOList.slice(0, 20).join(', ')}${regSHOList.length > 20 ? ` +${regSHOList.length - 20} more` : ''}`;
  }

  prompt += `\n\n═══════════════════════════════════════════
YOUR TASK — Write the daily briefing covering:

## MARKET REGIME & OUTLOOK
Overall market read. What's the gamma regime across indices? Are dealers long or short gamma? What does VIX tell us? Is the market in risk-on or risk-off mode? Reference the actual SPY/QQQ/IWM gamma flip levels, call/put walls, and bias scores.

## SECTOR ROTATION ANALYSIS
Compare all 11 sector ETFs. Which sectors are leading? Which are lagging? Identify rotation patterns (e.g., defensive→cyclical, tech→value). Flag any sectors with unusual gamma positioning, extreme IV ranks, or divergent PCR readings.

## NOTABLE DIVERGENCES & IMBALANCES
Cross-reference all data points to find non-obvious signals:
- Gamma regime divergences between indices (e.g., SPY long gamma but QQQ short gamma)
- Unusual PCR readings in specific sectors
- Stocks above/below gamma flip with implications
- IV rank extremes (very high or low) suggesting vol mispricing
- Bias score extremes — strongest bull and bear cases

## MAGNIFICENT 7 SPOTLIGHT
Only mention Mag7 names if they have notable readings. Which are showing unusual positioning? Any major divergences from the index? Skip any that are unremarkable.

${swapSummary.totalMaturitiesToday > 0 ? '## INSTITUTIONAL FLOW\nInterpret the DTCC swap maturity data. What does the volume and concentration of maturing swaps suggest about dealer rebalancing today?\n\n' : ''}${regSHOList.length > 0 ? '## SHORT SQUEEZE WATCHLIST\nAny notable names on the Reg SHO threshold list? Cross-reference with high IV rank or unusual gamma positioning.\n\n' : ''}## KEY LEVELS TO WATCH
The most important price levels for today based on gamma walls, max pain, and support/resistance implied by dealer positioning.

## TRADE THESIS SUMMARY
2-3 highest-conviction observations from the data. What actionable edge does this data give us today?

Be concise but data-rich. Every claim should reference specific numbers from the analysis. Format with clear markdown headers.`;

  return prompt;
}

export async function POST() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }

  try {
    // Phase 1: Scan all stocks in parallel batches
    const results: StockScan[] = [];
    for (let i = 0; i < ALL_TICKERS.length; i += CONCURRENCY) {
      const batch = ALL_TICKERS.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(t => scanStock(t)));
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    // Phase 1b: VIX + DTCC/FINRA (parallel with last batch or after)
    const [vixQuote, swapSummary, regSHOSet] = await Promise.all([
      getQuote('VIX').catch(() => null),
      getMarketSwapSummary().catch(() => ({
        totalMaturitiesToday: 0, totalNotionalToday: 0,
        totalMaturitiesWeek: 0, totalNotionalWeek: 0,
        topMaturities: [] as { symbol: string; count: number; notional: number }[],
        asOf: '',
      })),
      fetchRegSHOThreshold().catch(() => new Set<string>()),
    ]);

    const vixPrice = vixQuote?.last ?? 0;
    const regSHOList = Array.from(regSHOSet).filter(s => /^[A-Z]+$/.test(s)).sort();

    if (results.length === 0) {
      return NextResponse.json({ error: 'Failed to scan any stocks' }, { status: 500 });
    }

    // Phase 2: Build prompt and call Claude
    const prompt = buildBriefingPrompt(results, vixPrice, swapSummary, regSHOList);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allContent: any[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(100000),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => 'Unknown error');
        throw new Error(`Claude API: ${response.status} — ${err}`);
      }

      const result = await response.json();
      allContent = [...allContent, ...(result.content || [])];

      if (result.stop_reason !== 'pause_turn') break;
      body.messages = [
        { role: 'user', content: prompt },
        { role: 'assistant', content: allContent },
      ];
    }

    const text = allContent
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('\n') || 'No response generated.';

    return NextResponse.json({
      analysis: text,
      stocksScanned: results.length,
      timestamp: Date.now(),
      // Include compact data for the UI
      indices: results.filter(r => INDICES.includes(r.symbol)),
      vix: vixPrice,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    console.error('[ai/briefing] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
