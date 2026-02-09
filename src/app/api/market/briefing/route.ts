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
import { generateRecommendations } from '@/lib/math/recommendations';
import { getMarketSwapSummary } from '@/lib/providers/dtcc';
import { fetchRegSHOWithDate, fetchShortInterestWithDate } from '@/lib/providers/finra';

export const maxDuration = 30;

const KEY_INDICES = ['SPY', 'QQQ', 'IWM'];
const MAG7 = ['AAPL', 'MSFT', 'NVDA', 'AMZN']; // Top 4 by weight (reduced from 7 for speed)

/** Analysis result for a single index */
export interface IndexAnalysis {
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
  topSignals: { name: string; direction: string; weight: number; description: string }[];
  atrPercent: number;
  dailySigma: number;
  // Enhanced: vanna/charm and institutional proxy
  totalVanna: number;
  totalCharm: number;
  totalGEX: number;
  vannaRegime: 'bullish' | 'bearish' | 'neutral';
  charmRegime: 'bullish' | 'bearish' | 'neutral';
  deepITMCallOI: number;
  deepITMPutOI: number;
  unusualVolumeStrikes: string[];
}

export interface BriefingData {
  timestamp: number;
  indices: IndexAnalysis[];
  vix: { price: number; changePct: number } | null;
  dia: { price: number; changePct: number } | null;
  mag7: { symbol: string; price: number; changePct: number }[];
  swapSummary: {
    totalMaturitiesToday: number;
    totalNotionalToday: number;
    totalMaturitiesWeek: number;
    totalNotionalWeek: number;
    topMaturities: { symbol: string; count: number; notional: number }[];
    available: boolean;
    asOf: string;
  };
  regSHOList: string[];
  regSHOAsOf: string;
  shortInterestHighlights: { symbol: string; daysToCover: number; shortInterest: number }[];
  shortInterestAsOf: string;
  finraAvailable: boolean;
  narrative: string[];
  alerts: string[];
  // Options-derived institutional positioning
  vannaCharmAnalysis: {
    symbol: string;
    totalVanna: number;
    totalCharm: number;
    vannaRegime: 'bullish' | 'bearish' | 'neutral';
    charmRegime: 'bullish' | 'bearish' | 'neutral';
    totalGEX: number;
  }[];
  optionsDerivedPositioning: {
    deepITMCallOI: { symbol: string; contracts: number }[];
    deepITMPutOI: { symbol: string; contracts: number }[];
    unusualVolume: { symbol: string; strikes: string[] }[];
  };
}

interface EquityBar {
  o: number; h: number; l: number; c: number; v: number; t: number;
}

function computeQuickCorrelationCtx(bars: EquityBar[], hvCurrent: number) {
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
  const p66 = sorted[Math.floor(sorted.length * 0.66)] || 999;
  const lowVolWins5d: boolean[] = [];
  const lowVolRets: number[] = [];
  const highVolRets: number[] = [];
  for (let i = 0; i < hvValues.length - 20; i++) {
    const idx = i + 20;
    const fwd5 = returns.slice(idx, idx + 5).reduce((s, r) => s + r, 0);
    const fwd20 = returns.slice(idx, idx + 20).reduce((s, r) => s + r, 0);
    if (hvValues[i] <= p33) { lowVolRets.push(fwd20); lowVolWins5d.push(fwd5 > 0); }
    else if (hvValues[i] >= p66) { highVolRets.push(fwd20); }
  }
  const dailySigma = hvCurrent > 0 ? hvCurrent / Math.sqrt(252) : 0.015;
  const bigUps: { next1d: number }[] = [];
  const bigDowns: { next1d: number; next5d: number }[] = [];
  for (let i = 0; i < returns.length - 5; i++) {
    if (Math.abs(returns[i]) < dailySigma * 2) continue;
    if (returns[i] > 0) { bigUps.push({ next1d: returns[i + 1] || 0 }); }
    else { bigDowns.push({ next1d: returns[i + 1] || 0, next5d: returns.slice(i + 1, i + 6).reduce((s, r) => s + r, 0) }); }
  }
  const avg = (a: number[]) => a.length > 0 ? a.reduce((s, v) => s + v, 0) / a.length : 0;
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

function abbr(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}

function generateNarrative(
  indices: IndexAnalysis[],
  vix: { price: number; changePct: number } | null,
  swapAvailable: boolean,
  swapSummary: BriefingData['swapSummary'],
  regSHOCount: number,
): { narrative: string[]; alerts: string[] } {
  const narrative: string[] = [];
  const alerts: string[] = [];

  const spy = indices.find(i => i.symbol === 'SPY');
  const qqq = indices.find(i => i.symbol === 'QQQ');
  const iwm = indices.find(i => i.symbol === 'IWM');

  if (spy) {
    const gammaLabel = spy.gammaRegime === 'long' ? 'long gamma (mean-reverting, dips get bought)'
      : spy.gammaRegime === 'short' ? 'short gamma (trend-following, moves get amplified)'
      : 'neutral gamma';
    const volLabel = spy.volRegime === 'high' ? 'elevated' : spy.volRegime === 'low' ? 'compressed' : 'mid-range';

    narrative.push(
      `SPY is at $${spy.price.toFixed(2)} (${spy.changePct >= 0 ? '+' : ''}${spy.changePct.toFixed(2)}%) in a ${gammaLabel} regime with ${volLabel} IV (rank ${spy.ivRank}).`
    );

    if (spy.gammaFlip !== null) {
      const dist = ((spy.price - spy.gammaFlip) / spy.price * 100);
      narrative.push(
        `Gamma flip at $${spy.gammaFlip.toFixed(0)} — spot is ${dist > 0 ? dist.toFixed(1) + '% above' : Math.abs(dist).toFixed(1) + '% below'}. ${dist > 0 ? 'Dealers hedge by buying dips.' : 'Dealers hedge by selling into weakness — downside can accelerate.'}`
      );
    }

    if (spy.callWall && spy.putWall) {
      narrative.push(
        `GEX-implied range: $${spy.putWall.toFixed(0)} (put wall) to $${spy.callWall.toFixed(0)} (call wall). Max pain: $${spy.maxPain.toFixed(0)}.`
      );
    }

    const pcrLabel = spy.volumePCR > 1.3 ? 'bearish (heavy put buying)' : spy.volumePCR < 0.7 ? 'bullish (call-dominant)' : 'balanced';
    narrative.push(
      `Options flow: PCR ${spy.volumePCR.toFixed(2)} — ${pcrLabel}. Bias score: ${spy.biasScore > 0 ? '+' : ''}${spy.biasScore} (${spy.bias}).`
    );
  }

  if (spy && qqq && iwm) {
    const allBullish = [spy, qqq, iwm].every(i => i.bias === 'bullish');
    const allBearish = [spy, qqq, iwm].every(i => i.bias === 'bearish');
    const mixed = !allBullish && !allBearish;

    if (allBullish) {
      narrative.push('Cross-index alignment: all 3 major indices show bullish bias — broad market strength.');
    } else if (allBearish) {
      narrative.push('Cross-index alignment: all 3 major indices show bearish bias — broad market weakness.');
    } else if (mixed) {
      const leaders = [spy, qqq, iwm].filter(i => i.changePct > 0).map(i => i.symbol);
      const laggards = [spy, qqq, iwm].filter(i => i.changePct < 0).map(i => i.symbol);
      if (leaders.length > 0 && laggards.length > 0) {
        narrative.push(
          `Divergence: ${leaders.join(', ')} leading (${leaders.map(l => `${l} ${[spy, qqq, iwm].find(i => i.symbol === l)?.bias}`).join(', ')}) while ${laggards.join(', ')} lagging — rotation, not broad trend.`
        );
      }
    }

    const iwmVsSpy = iwm.changePct - spy.changePct;
    if (Math.abs(iwmVsSpy) > 1) {
      narrative.push(
        iwmVsSpy > 0
          ? `Risk-on rotation: IWM outperforming SPY by ${iwmVsSpy.toFixed(1)}pp — small caps leading, broad risk appetite.`
          : `Risk-off rotation: IWM underperforming SPY by ${Math.abs(iwmVsSpy).toFixed(1)}pp — flight to quality/large caps.`
      );
    }
  }

  if (vix) {
    if (vix.price > 25) {
      narrative.push(`VIX at ${vix.price.toFixed(2)} — elevated fear. Expect wide ranges and premium-rich environment.`);
    } else if (vix.price < 15) {
      narrative.push(`VIX at ${vix.price.toFixed(2)} — complacency/calm. Options are cheap; ideal for buying vol.`);
    } else {
      narrative.push(`VIX at ${vix.price.toFixed(2)} (${vix.changePct >= 0 ? '+' : ''}${vix.changePct.toFixed(1)}%) — mid-range volatility.`);
    }
  }

  if (qqq) {
    if (Math.abs(qqq.biasScore) > 25) {
      narrative.push(
        `QQQ at $${qqq.price.toFixed(2)} shows ${qqq.bias} bias (${qqq.biasScore > 0 ? '+' : ''}${qqq.biasScore}) — ${qqq.gammaRegime} gamma, IV rank ${qqq.ivRank}. ${qqq.callWall ? `Call wall: $${qqq.callWall.toFixed(0)}.` : ''} ${qqq.putWall ? `Put wall: $${qqq.putWall.toFixed(0)}.` : ''}`
      );
    }
  }

  if (iwm) {
    if (Math.abs(iwm.biasScore) > 25) {
      narrative.push(
        `IWM at $${iwm.price.toFixed(2)} shows ${iwm.bias} bias (${iwm.biasScore > 0 ? '+' : ''}${iwm.biasScore}) — ${iwm.gammaRegime} gamma, IV rank ${iwm.ivRank}.`
      );
    }
  }

  if (swapAvailable && swapSummary.totalMaturitiesToday > 0) {
    narrative.push(
      `DTCC: ${swapSummary.totalMaturitiesToday.toLocaleString()} equity swaps (${abbr(swapSummary.totalNotionalToday)} notional) maturing today — dealer rebalancing expected.`
    );
    if (swapSummary.topMaturities.length > 0) {
      const top3 = swapSummary.topMaturities.slice(0, 3).map(m => `${m.symbol} (${m.count}, ${abbr(m.notional)})`).join(', ');
      narrative.push(`Top swap maturities: ${top3}.`);
    }
  }

  if (regSHOCount > 0) {
    narrative.push(`${regSHOCount} securities on Reg SHO threshold list (persistent FTDs — potential squeeze catalysts).`);
  }

  if (spy) {
    const moveSigma = spy.dailySigma > 0 ? Math.abs(spy.changePct) / spy.dailySigma : 0;
    if (moveSigma > 2) {
      alerts.push(`SPY today's ${spy.changePct > 0 ? '+' : ''}${spy.changePct.toFixed(1)}% move is ${moveSigma.toFixed(1)}σ — statistically significant. Wait for settling before new entries.`);
    }
    if (spy.volRegime === 'high' && spy.gammaRegime === 'short') {
      alerts.push('High IV + Short Gamma = volatile environment. Use defined-risk strategies only.');
    }
    if (spy.ivRank > 80) {
      alerts.push(`SPY IV Rank ${spy.ivRank} — near 52w highs. Favor selling premium.`);
    } else if (spy.ivRank < 15) {
      alerts.push(`SPY IV Rank ${spy.ivRank} — near 52w lows. Options are cheap, favor buying.`);
    }
  }

  return { narrative, alerts };
}

export async function GET() {
  try {
    /** Run full GEX/IV/flow analysis for a single ticker */
    async function analyzeIndex(ticker: string): Promise<IndexAnalysis | null> {
      try {
        const [quote, expirations, historyBars] = await Promise.all([
          getQuote(ticker),
          getExpirations(ticker),
          fetchEquityBars(ticker, 250),
        ]);

        const spotPrice = quote.last;
        if (!spotPrice || spotPrice <= 0) return null;

        const nearExps = expirations.slice(0, 2); // 2 expirations max for briefing (speed)
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
          if (ex) {
            ex.netGEX += e.netGEX; ex.netDEX += e.netDEX;
            ex.callGEX += e.callGEX; ex.putGEX += e.putGEX;
            ex.netVanna += e.netVanna; ex.callVanna += e.callVanna; ex.putVanna += e.putVanna;
            ex.netCharm += e.netCharm; ex.callCharm += e.callCharm; ex.putCharm += e.putCharm;
          }
          else byStrike.set(e.strike, { ...e });
        }
        const agg = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
        const totalGEX = agg.reduce((s, e) => s + e.netGEX, 0);
        const totalDEX = agg.reduce((s, e) => s + e.netDEX, 0);
        const totalVanna = agg.reduce((s, e) => s + e.netVanna, 0);
        const totalCharm = agg.reduce((s, e) => s + e.netCharm, 0);

        // Deep ITM OI computation for institutional proxy
        const itmThreshold = 0.15;
        let deepITMCallOI = 0;
        let deepITMPutOI = 0;
        const unusualVolumeStrikes: string[] = [];
        for (const chain of chains) {
          for (const c of chain.calls) {
            if (c.strike < spotPrice * (1 - itmThreshold) && c.openInterest > 100) deepITMCallOI += c.openInterest;
            if (c.openInterest > 0 && c.volume > c.openInterest * 3 && c.volume > 500) {
              unusualVolumeStrikes.push(`${c.strike}C`);
            }
          }
          for (const p of chain.puts) {
            if (p.strike > spotPrice * (1 + itmThreshold) && p.openInterest > 100) deepITMPutOI += p.openInterest;
            if (p.openInterest > 0 && p.volume > p.openInterest * 3 && p.volume > 500) {
              unusualVolumeStrikes.push(`${p.strike}P`);
            }
          }
        }
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
        const profile = computeStockProfile(
          historyBars.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
          spotPrice, hvCurrent
        );
        const correlationCtx = computeQuickCorrelationCtx(historyBars, hvCurrent);

        const input = {
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

        // Vanna/Charm regime determination
        const vannaThreshold = Math.abs(totalGEX) * 0.01 || 1;
        const vannaRegime: 'bullish' | 'bearish' | 'neutral' =
          totalVanna > vannaThreshold ? 'bullish' : totalVanna < -vannaThreshold ? 'bearish' : 'neutral';
        const charmRegime: 'bullish' | 'bearish' | 'neutral' =
          totalCharm > vannaThreshold ? 'bullish' : totalCharm < -vannaThreshold ? 'bearish' : 'neutral';

        return {
          symbol: ticker,
          price: spotPrice,
          changePct: quote.changePct,
          bias: rec.overallBias,
          biasScore: rec.biasScore,
          volRegime: rec.volRegime,
          gammaRegime: rec.gammaRegime,
          ivRank: ivMetrics.ivRank,
          currentIV,
          hvCurrent,
          volumePCR,
          gammaFlip, callWall, putWall,
          maxPain: maxPainResult.strike,
          topSignals: rec.signals.filter(s => s.weight !== 0).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 5),
          atrPercent: profile.atrPercent,
          dailySigma: profile.dailySigma,
          totalVanna, totalCharm, totalGEX, vannaRegime, charmRegime,
          deepITMCallOI, deepITMPutOI,
          unusualVolumeStrikes: unusualVolumeStrikes.slice(0, 5),
        };
      } catch (err) {
        console.error(`[briefing] Failed ${ticker}:`, err instanceof Error ? err.message : err);
        return null;
      }
    }

    // Phase 1: Fetch VIX, DIA quotes + index analysis + DTCC/FINRA data (with hard timeout)
    const emptySwap = {
      totalMaturitiesToday: 0, totalNotionalToday: 0,
      totalMaturitiesWeek: 0, totalNotionalWeek: 0,
      topMaturities: [] as { symbol: string; count: number; notional: number }[],
      asOf: '',
    };
    const emptyRegSHO = { tickers: new Set<string>(), asOf: '' };
    const emptySI = { data: new Map<string, { daysToCover: number; shortInterest: number }>(), asOf: '' };

    // Independent per-provider timeouts — so DTCC being slow doesn't block RegSHO/SI
    const raceTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
      Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

    const institutionalRace = Promise.all([
      raceTimeout(getMarketSwapSummary().catch(() => emptySwap), 4000, emptySwap),
      raceTimeout(fetchRegSHOWithDate().catch(() => emptyRegSHO), 4000, emptyRegSHO),
      raceTimeout(fetchShortInterestWithDate().catch(() => emptySI), 5000, emptySI),
    ]);

    const [vixQuote, diaQuote, institutionalData, ...indexResults] = await Promise.all([
      getQuote('VIX').catch(() => null),
      getQuote('DIA').catch(() => null),
      institutionalRace,
      ...KEY_INDICES.map(t => analyzeIndex(t)),
    ]);

    const [swapSummary, regSHOResult, siResult] = institutionalData;

    const indices = indexResults.filter((r): r is IndexAnalysis => r !== null);

    // Phase 2: Mag7 quotes (parallel)
    const mag7Quotes = await Promise.all(MAG7.map(t => getQuote(t).catch(() => null)));
    const mag7 = MAG7.map((sym, i) => ({
      symbol: sym,
      price: mag7Quotes[i]?.last ?? 0,
      changePct: mag7Quotes[i]?.changePct ?? 0,
    }));

    const vix = vixQuote ? { price: vixQuote.last, changePct: vixQuote.changePct } : null;
    const dia = diaQuote ? { price: diaQuote.last, changePct: diaQuote.changePct } : null;

    const regSHOList = Array.from(regSHOResult.tickers).filter(s => /^[A-Z]+$/.test(s)).sort();

    const shortInterestHighlights: BriefingData['shortInterestHighlights'] = [];
    for (const [sym, data] of siResult.data) {
      if (data.daysToCover > 3) {
        shortInterestHighlights.push({ symbol: sym, daysToCover: data.daysToCover, shortInterest: data.shortInterest });
      }
    }
    shortInterestHighlights.sort((a, b) => b.daysToCover - a.daysToCover);

    const swapAvailable = swapSummary.asOf !== '' || swapSummary.totalMaturitiesToday > 0 || swapSummary.totalMaturitiesWeek > 0;
    const finraAvailable = regSHOResult.tickers.size > 0 || siResult.data.size > 0;

    const { narrative, alerts } = generateNarrative(
      indices, vix, swapAvailable,
      { ...swapSummary, available: swapAvailable },
      regSHOList.length,
    );

    // Build vanna/charm analysis and institutional proxy from index data
    const vannaCharmAnalysis = indices.map(r => ({
      symbol: r.symbol,
      totalVanna: r.totalVanna,
      totalCharm: r.totalCharm,
      vannaRegime: r.vannaRegime,
      charmRegime: r.charmRegime,
      totalGEX: r.totalGEX,
    }));

    const optionsDerivedPositioning = {
      deepITMCallOI: indices.filter(r => r.deepITMCallOI > 500).map(r => ({ symbol: r.symbol, contracts: r.deepITMCallOI })),
      deepITMPutOI: indices.filter(r => r.deepITMPutOI > 500).map(r => ({ symbol: r.symbol, contracts: r.deepITMPutOI })),
      unusualVolume: indices.filter(r => r.unusualVolumeStrikes.length > 0).map(r => ({ symbol: r.symbol, strikes: r.unusualVolumeStrikes })),
    };

    const briefing: BriefingData = {
      timestamp: Date.now(),
      indices,
      vix, dia, mag7,
      swapSummary: { ...swapSummary, available: swapAvailable },
      regSHOList: regSHOList.slice(0, 50),
      regSHOAsOf: regSHOResult.asOf,
      shortInterestHighlights: shortInterestHighlights.slice(0, 20),
      shortInterestAsOf: siResult.asOf,
      finraAvailable,
      narrative, alerts,
      vannaCharmAnalysis,
      optionsDerivedPositioning,
    };

    return NextResponse.json(briefing);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[briefing] Unhandled error:', error);
    return NextResponse.json({
      error: message,
      stack: stack?.split('\n').slice(0, 10),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      route: '/api/market/briefing',
    }, { status: 500 });
  }
}
