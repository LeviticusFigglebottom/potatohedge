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
import { fetchRegSHOThreshold, fetchShortInterest, fetchShortSaleVolume, type ShortInterestData, type ShortVolumeData } from '@/lib/providers/finra';
import { scanMarketFlow, type FlowResult } from '@/lib/providers/polygonFlow';

export const maxDuration = 60; // Briefing: scan 21 stocks + Claude analysis

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
  // Enhanced: vanna/charm analysis
  totalVanna: number;
  totalCharm: number;
  vannaRegime: 'bullish' | 'bearish' | 'neutral'; // vol drop direction
  charmRegime: 'bullish' | 'bearish' | 'neutral'; // time decay direction
  // Enhanced: options-derived institutional metrics
  deepITMCallOI: number;  // likely synthetic longs
  deepITMPutOI: number;   // likely protective puts / synthetic shorts
  unusualVolumeStrikes: string[]; // strikes with vol >> OI
  gammaSlope: number; // rate of GEX change around spot (steeper = more pinning)
  totalGEX: number;
  totalDEX: number;
  atrPercent: number;
  dailySigma: number;
  skewBias: string;
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
      fetchEquityBars(ticker, 250),
    ]);
    const spotPrice = quote.last;
    if (!spotPrice || spotPrice <= 0) return null;
    const nearExps = expirations.slice(0, 3); // 3 expirations for briefing (balance speed vs accuracy)
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

    // Vanna regime: if net vanna > 0, a vol drop causes dealers to buy → bullish
    // If net vanna < 0, a vol drop causes dealers to sell → bearish
    const vannaThreshold = Math.abs(totalGEX) * 0.01 || 1;
    const vannaRegime: 'bullish' | 'bearish' | 'neutral' =
      totalVanna > vannaThreshold ? 'bullish' : totalVanna < -vannaThreshold ? 'bearish' : 'neutral';
    const charmRegime: 'bullish' | 'bearish' | 'neutral' =
      totalCharm > vannaThreshold ? 'bullish' : totalCharm < -vannaThreshold ? 'bearish' : 'neutral';

    // Gamma slope: measure how rapidly GEX changes around spot (steeper = more pinning effect)
    const nearSpot = agg.filter(e => Math.abs(e.strike - spotPrice) / spotPrice < 0.05);
    let gammaSlope = 0;
    if (nearSpot.length >= 2) {
      const gexValues = nearSpot.map(e => e.netGEX);
      const diffs = gexValues.slice(1).map((v, i) => Math.abs(v - gexValues[i]));
      gammaSlope = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    }

    // Deep ITM OI: proxy for institutional synthetic positions
    const itmThreshold = 0.15; // 15% ITM
    let deepITMCallOI = 0;
    let deepITMPutOI = 0;
    const unusualVolumeStrikes: string[] = [];
    for (const chain of chains) {
      for (const c of chain.calls) {
        if (c.strike < spotPrice * (1 - itmThreshold) && c.openInterest > 100) {
          deepITMCallOI += c.openInterest;
        }
        if (c.openInterest > 0 && c.volume > c.openInterest * 3 && c.volume > 500) {
          unusualVolumeStrikes.push(`${c.strike}C(${c.volume}v/${c.openInterest}oi)`);
        }
      }
      for (const p of chain.puts) {
        if (p.strike > spotPrice * (1 + itmThreshold) && p.openInterest > 100) {
          deepITMPutOI += p.openInterest;
        }
        if (p.openInterest > 0 && p.volume > p.openInterest * 3 && p.volume > 500) {
          unusualVolumeStrikes.push(`${p.strike}P(${p.volume}v/${p.openInterest}oi)`);
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
      totalVanna, totalCharm, vannaRegime, charmRegime,
      deepITMCallOI, deepITMPutOI,
      unusualVolumeStrikes: unusualVolumeStrikes.slice(0, 5),
      gammaSlope, totalGEX, totalDEX,
      atrPercent: profile.atrPercent,
      dailySigma: profile.dailySigma,
      skewBias: skew.skewBias,
    };
  } catch {
    return null;
  }
}

function abbr(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function buildBriefingPrompt(
  stocks: StockScan[],
  vixPrice: number,
  vixChangePct: number,
  swapSummary: { totalMaturitiesToday: number; totalNotionalToday: number; totalMaturitiesWeek: number; totalNotionalWeek: number; topMaturities: { symbol: string; count: number; notional: number }[]; asOf: string },
  regSHOList: string[],
  shortInterestData: { symbol: string; daysToCover: number; shortInterest: number }[],
  shortVolumeData: { symbol: string; shortRatio: number; shortVolume: number; totalVolume: number }[],
  flowData: FlowResult,
): string {
  const indices = stocks.filter(s => INDICES.includes(s.symbol));
  const sectors = stocks.filter(s => SECTOR_ETFS.includes(s.symbol));
  const mag7 = stocks.filter(s => MAG7.includes(s.symbol));

  const fmtStock = (s: StockScan) => {
    const gexLabel = s.totalGEX >= 0 ? `+${abbr(s.totalGEX)}` : abbr(s.totalGEX);
    const dexLabel = s.totalDEX >= 0 ? `+${abbr(s.totalDEX)}` : abbr(s.totalDEX);
    const lines = [
      `${s.symbol}: $${s.price.toFixed(2)} (${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%) | Bias: ${s.biasScore > 0 ? '+' : ''}${s.biasScore} ${s.bias} | Gamma: ${s.gammaRegime} | IV: ${s.volRegime} (rank ${s.ivRank}, ${(s.currentIV * 100).toFixed(0)}% IV vs ${(s.hvCurrent * 100).toFixed(0)}% HV) | PCR: ${s.volumePCR.toFixed(2)} | Skew: ${s.skewBias}`,
      `  GEX: ${gexLabel} | DEX: ${dexLabel} | Vanna: ${s.vannaRegime} | Charm: ${s.charmRegime} | ATR: ${s.atrPercent.toFixed(1)}% | Daily 1σ: ${(s.dailySigma * 100).toFixed(2)}%`,
      `  Levels: γFlip=${s.gammaFlip ? '$' + s.gammaFlip.toFixed(0) : 'N/A'} CW=${s.callWall ? '$' + s.callWall.toFixed(0) : 'N/A'} PW=${s.putWall ? '$' + s.putWall.toFixed(0) : 'N/A'} MaxPain=$${s.maxPain.toFixed(0)}`,
      `  Top signals: ${s.topSignals.join(' | ') || 'none'}`,
    ];
    if (s.deepITMCallOI > 1000 || s.deepITMPutOI > 1000) {
      lines.push(`  Institutional proxy: DeepITM Call OI=${s.deepITMCallOI.toLocaleString()} (synth longs) | DeepITM Put OI=${s.deepITMPutOI.toLocaleString()} (hedges/synth shorts)`);
    }
    if (s.unusualVolumeStrikes.length > 0) {
      lines.push(`  Unusual volume: ${s.unusualVolumeStrikes.join(', ')}`);
    }
    if (s.warnings.length > 0) lines.push(`  Warnings: ${s.warnings.join(', ')}`);
    return lines.join('\n');
  };

  let prompt = `You are a senior quantitative market strategist. Generate a comprehensive MORNING BRIEFING from live options flow and dealer positioning data across ${stocks.length} securities.

Your analysis should be direct, opinionated, and actionable — like a trading desk morning note. Lead with the single most important headline. Use specific numbers. Identify the primary edge for today.

CRITICAL: You have second-order Greeks (vanna, charm) in addition to gamma. Use them:
- VANNA: sensitivity of delta to implied vol changes. "Bullish vanna" means a vol drop forces dealers to buy stock. "Bearish vanna" means a vol drop forces dealers to sell.
- CHARM: delta decay over time. "Bullish charm" means time passing forces dealers to buy. Charm is often the dominant flow on quiet days.
- When vanna and charm DIVERGE (one bullish, one bearish), that creates conflict in dealer hedging — discuss which dominates and why.
- When vanna and charm ALIGN, that confirms the directional bias.
- GAMMA SLOPE measures how rapidly dealer exposure changes near spot — higher slope = stronger pinning effect.

═══════════════════════════════════════════
LIVE MARKET DATA — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
═══════════════════════════════════════════

VIX: ${vixPrice.toFixed(2)} (${vixChangePct >= 0 ? '+' : ''}${vixChangePct.toFixed(1)}%)

─── INDEX ANALYSIS ───
${indices.map(fmtStock).join('\n\n')}

─── SECTOR ETFs ───
${sectors.map(fmtStock).join('\n\n')}

─── MAGNIFICENT 7 ───
${mag7.map(fmtStock).join('\n\n')}`;

  // Real-time options flow data
  if (flowData.flow.tickersScanned > 0) {
    const f = flowData.flow;
    prompt += `\n\n─── REAL-TIME OPTIONS FLOW (${f.tickersScanned} tickers, ${f.contractsAnalyzed.toLocaleString()} contracts) ───`;
    prompt += `\nNet Premium Flow: ${abbr(f.netPremium)} (${f.sentiment.toUpperCase()})`;
    prompt += `\nCall Premium: ${abbr(f.netCallPremium)} | Put Premium: ${abbr(f.netPutPremium)}`;
    prompt += `\nVolume P/C Ratio: ${f.putCallRatio.toFixed(2)} (${f.totalCallVolume.toLocaleString()}C / ${f.totalPutVolume.toLocaleString()}P)`;
    prompt += `\n(Net premium = call premium - put premium. Positive = net call buying = institutions positioning bullish. P/C < 0.7 = aggressive call buying, > 1.2 = heavy hedging)`;

    if (flowData.perTickerFlow.length > 0) {
      prompt += `\n\nPer-Ticker Flow (sorted by magnitude):`;
      for (const tf of flowData.perTickerFlow.slice(0, 10)) {
        const dir = tf.netPremium > 0 ? '+' : '';
        prompt += `\n  ${tf.ticker}: ${dir}${abbr(tf.netPremium)} (C: ${abbr(tf.callPremium)} / P: ${abbr(tf.putPremium)})`;
      }
    }

    if (flowData.alerts.length > 0) {
      prompt += `\n\nTop Flow Alerts (by premium):`;
      for (const a of flowData.alerts.slice(0, 15)) {
        const dir = a.sentiment === 'bullish' ? '▲' : a.sentiment === 'bearish' ? '▼' : '—';
        prompt += `\n  ${dir} ${a.ticker} ${a.contractType.toUpperCase()} $${a.strike} ${a.expiry}: ${abbr(a.premium)} ${a.tradeType.toUpperCase()} (Vol/OI: ${a.volumeOIRatio}x, IV: ${(a.impliedVol * 100).toFixed(0)}%)`;
      }
    }

    if (flowData.isDeveloper) {
      prompt += `\n(Enhanced with trade-level sweep/block detection from Polygon Developer)`;
    }
  }

  // DTCC swap data
  if (swapSummary.totalMaturitiesToday > 0 || swapSummary.totalMaturitiesWeek > 0 || swapSummary.asOf) {
    const dateNote = swapSummary.asOf ? ` (report: ${swapSummary.asOf})` : '';
    prompt += `\n\n─── DTCC EQUITY SWAP MATURITIES${dateNote} ───`;
    if (swapSummary.totalMaturitiesToday > 0) {
      prompt += `\nToday: ${swapSummary.totalMaturitiesToday.toLocaleString()} swaps (${abbr(swapSummary.totalNotionalToday)} notional)`;
    }
    if (swapSummary.totalMaturitiesWeek > 0) {
      prompt += `\nThis week: ${swapSummary.totalMaturitiesWeek.toLocaleString()} swaps (${abbr(swapSummary.totalNotionalWeek)} notional)`;
    }
    if (swapSummary.topMaturities.length > 0) {
      prompt += `\nTop by notional: ${swapSummary.topMaturities.slice(0, 8).map(m => `${m.symbol}(${m.count} swaps, ${abbr(m.notional)})`).join(', ')}`;
    }
    if (swapSummary.totalMaturitiesToday === 0 && swapSummary.totalMaturitiesWeek === 0) {
      prompt += `\nNo swaps maturing today/this week — data reflects open positions only.`;
    }
  }

  // Reg SHO
  if (regSHOList.length > 0) {
    prompt += `\n\n─── REG SHO THRESHOLD LIST (persistent FTDs) ───
${regSHOList.length} securities: ${regSHOList.slice(0, 25).join(', ')}${regSHOList.length > 25 ? ` +${regSHOList.length - 25} more` : ''}`;
  }

  // Short Interest (bi-monthly positions from CDN)
  if (shortInterestData.length > 0) {
    prompt += `\n\n─── HIGH SHORT INTEREST (>3 days to cover) ───`;
    for (const si of shortInterestData.slice(0, 10)) {
      prompt += `\n${si.symbol}: ${si.daysToCover.toFixed(1)} DTC, ${(si.shortInterest / 1e6).toFixed(2)}M shares short`;
    }
  }

  // Daily Short Sale Volume (from regShoDaily — always available, no auth)
  if (shortVolumeData.length > 0) {
    const highShort = shortVolumeData.filter(sv => sv.shortRatio > 0.50);
    if (highShort.length > 0) {
      prompt += `\n\n─── DAILY SHORT SALE VOLUME (>50% short ratio) ───`;
      prompt += `\n(Short volume ratio = short sales / total volume. Above 50% = majority of trading is short selling)`;
      for (const sv of highShort.slice(0, 15)) {
        prompt += `\n${sv.symbol}: ${(sv.shortRatio * 100).toFixed(0)}% short ratio (${abbr(sv.shortVolume)} short / ${abbr(sv.totalVolume)} total)`;
      }
    }
  }

  // Institutional proxy summary
  const synthLongs = stocks.filter(s => s.deepITMCallOI > 5000).sort((a, b) => b.deepITMCallOI - a.deepITMCallOI);
  const synthShorts = stocks.filter(s => s.deepITMPutOI > 5000).sort((a, b) => b.deepITMPutOI - a.deepITMPutOI);
  if (synthLongs.length > 0 || synthShorts.length > 0) {
    prompt += `\n\n─── OPTIONS-DERIVED INSTITUTIONAL POSITIONING ───`;
    prompt += `\n(Deep ITM options with high OI indicate synthetic stock positions — likely institutional hedging or directional bets)`;
    if (synthLongs.length > 0) {
      prompt += `\nSynthetic longs (deep ITM calls): ${synthLongs.slice(0, 5).map(s => `${s.symbol}(${s.deepITMCallOI.toLocaleString()} contracts)`).join(', ')}`;
    }
    if (synthShorts.length > 0) {
      prompt += `\nSynthetic shorts/hedges (deep ITM puts): ${synthShorts.slice(0, 5).map(s => `${s.symbol}(${s.deepITMPutOI.toLocaleString()} contracts)`).join(', ')}`;
    }
  }

  // Unusual volume summary
  const uva = stocks.filter(s => s.unusualVolumeStrikes.length > 0);
  if (uva.length > 0) {
    prompt += `\n\n─── UNUSUAL OPTIONS ACTIVITY ───`;
    for (const s of uva.slice(0, 8)) {
      prompt += `\n${s.symbol}: ${s.unusualVolumeStrikes.join(', ')}`;
    }
  }

  prompt += `\n\n═══════════════════════════════════════════
YOUR TASK — Write the morning briefing. Start with one bold headline sentence that captures today's most important dynamic. Then cover:

## Morning Briefing — ${new Date().toISOString().slice(0, 10)}

**Lead with one bold opening paragraph** summarizing the most critical market dynamic. Reference specific numbers. State the directional lean clearly.

Then analyze:

1. **GAMMA + VANNA + CHARM REGIME** — What's the gamma regime for SPY/QQQ/IWM? Crucially, analyze the VANNA and CHARM readings: which direction do they push dealer hedging? Do they confirm or contradict the gamma signal? If vanna and charm diverge, explain which dominates in the current vol regime (VIX level). Reference gamma flip levels and what happens if breached.

2. **INDEX DIVERGENCES** — Are SPY, QQQ, IWM aligned or divergent? What does the split mean? Is this rotation or broad trend? Which index has the cleanest directional setup based on gamma+vanna+charm alignment?

3. **MAGNIFICENT 7 BREAKDOWN** — For each Mag7 stock with notable positioning, state the directional lean and which Greek(s) drive it. Flag any that diverge from their index. Count how many are long vs short — does narrow leadership make QQQ vulnerable?

${flowData.flow.tickersScanned > 0 ? '4. **OPTIONS FLOW ANALYSIS** — Analyze the real-time options premium flow. What does the net premium tell us? Which tickers have the most aggressive institutional positioning? Are sweeps/blocks confirming or diverging from dealer gamma positioning? Cross-reference flow direction with GEX regime for each ticker.\n\n' : ''}${swapSummary.totalMaturitiesToday > 0 || swapSummary.totalMaturitiesWeek > 0 ? '5. **SWAP MATURITIES** — Interpret swap maturities. Extreme clusters create forced dealer rebalancing. Cross-reference with flow alerts: are institutions positioning ahead of maturity unwinds?\n\n' : ''}${regSHOList.length > 0 || shortInterestData.length > 0 ? '6. **SHORT INTEREST / REG SHO** — Notable names with persistent FTDs or high days-to-cover. Cross-reference with options flow: are shorts being squeezed (bullish flow + high SI)?\n\n' : ''}7. **WATCHLIST** — Name 3-5 specific stocks (from any scanned) with the highest-conviction setups. For each: state the direction, the dominant Greek signal, key level to watch, and what would invalidate the thesis. Include flow context (sweeps, blocks, unusual volume) alongside dealer positioning.

7. **KEY LEVELS** — For SPY specifically: gamma flip, call wall, put wall, max pain. What happens at each level.

Be opinionated and direct. Use **bold** for key names, levels, and directional calls. Every claim must reference specific data. Do NOT hedge every statement — make clear calls.`;

  return prompt;
}

export async function POST() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }

  try {
    // Helper: race a promise against a hard deadline
    const raceTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
      Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

    const emptySwap = {
      totalMaturitiesToday: 0, totalNotionalToday: 0,
      totalMaturitiesWeek: 0, totalNotionalWeek: 0,
      topMaturities: [] as { symbol: string; count: number; notional: number }[],
      asOf: '',
    };
    const emptyFlow: FlowResult = {
      flow: { netCallPremium: 0, netPutPremium: 0, netPremium: 0, totalCallVolume: 0, totalPutVolume: 0, putCallRatio: 0, sentiment: 'neutral', tickersScanned: 0, contractsAnalyzed: 0 },
      alerts: [], perTickerFlow: [], isDeveloper: false, asOf: '',
    };

    // Start institutional data fetches IMMEDIATELY — they run in parallel
    // with stock scanning (saves 5-10s vs running them sequentially after)
    const institutionalPromise = Promise.all([
      getQuote('VIX').catch(() => null),
      raceTimeout(getMarketSwapSummary().catch(() => emptySwap), 4000, emptySwap),
      raceTimeout(fetchRegSHOThreshold().catch(() => new Set<string>()), 4000, new Set<string>()),
      raceTimeout(fetchShortInterest().catch(() => new Map<string, ShortInterestData>()), 5000, new Map<string, ShortInterestData>()),
      raceTimeout(fetchShortSaleVolume().catch(() => new Map<string, ShortVolumeData>()), 5000, new Map<string, ShortVolumeData>()),
      raceTimeout(scanMarketFlow().catch(() => emptyFlow), 8000, emptyFlow),
    ]);

    // Phase 1: Scan all stocks in parallel batches (runs concurrently with institutional data)
    const results: StockScan[] = [];
    for (let i = 0; i < ALL_TICKERS.length; i += CONCURRENCY) {
      const batch = ALL_TICKERS.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(t => scanStock(t)));
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    // Wait for institutional data (likely already done since stock scanning takes longer)
    const [vixQuote, swapSummary, regSHOSet, shortInterestMap, shortVolumeMap, flowResult] = await institutionalPromise;
    const vixPrice = vixQuote?.last ?? 0;
    const vixChangePct = vixQuote?.changePct ?? 0;
    const regSHOList = Array.from(regSHOSet).filter(s => /^[A-Z]+$/.test(s)).sort();

    // Build short interest highlights (3-100 DTC, meaningful positions only — OTC data)
    const shortInterestData: { symbol: string; daysToCover: number; shortInterest: number }[] = [];
    for (const [sym, data] of shortInterestMap) {
      if (data.daysToCover >= 3 && data.daysToCover <= 100 && data.shortInterest >= 50000 && data.avgDailyVolume >= 1000) {
        shortInterestData.push({ symbol: sym, daysToCover: data.daysToCover, shortInterest: data.shortInterest });
      }
    }
    shortInterestData.sort((a, b) => b.daysToCover - a.daysToCover);

    // Build short volume highlights (>40% short ratio with significant volume)
    const shortVolumeData: { symbol: string; shortRatio: number; shortVolume: number; totalVolume: number }[] = [];
    for (const [sym, data] of shortVolumeMap) {
      if (data.shortRatio > 0.40 && data.totalVolume > 100000) {
        shortVolumeData.push({ symbol: sym, shortRatio: data.shortRatio, shortVolume: data.shortVolume, totalVolume: data.totalVolume });
      }
    }
    shortVolumeData.sort((a, b) => b.shortRatio - a.shortRatio);

    if (results.length === 0) {
      return NextResponse.json({ error: 'Failed to scan any stocks' }, { status: 500 });
    }

    // Phase 2: Build prompt and call Claude
    const prompt = buildBriefingPrompt(results, vixPrice, vixChangePct, swapSummary, regSHOList, shortInterestData, shortVolumeData, flowResult);

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
