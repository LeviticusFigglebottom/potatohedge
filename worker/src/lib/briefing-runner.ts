
import { getQuote, getExpirations, getOptionsChain } from './providers/tradier.js';
import { fetchEquityBars } from './providers/equityBars.js';
import {
  computeDealerExposureFromChain,
  findGammaFlip,
  findCallWall,
  findPutWall,
  computeMaxPain,
} from './math/blackScholes.js';
import {
  computeHistoricalVolatility,
  computeIVRankPercentile,
  computeSkew,
  computeStockProfile,
} from './math/analytics.js';
import { generateRecommendations, type RecommendationInput, type TradeIdea } from './math/recommendations.js';
import type { EquityBar } from './providers/equityBars.js';
// DTCC swap ZIP skipped in this route — decompressing peaks at 200-400MB, OOM-kills on Vercel
import { fetchRegSHOThreshold, fetchShortInterest, fetchShortSaleVolume, type ShortInterestData, type ShortVolumeData } from './providers/finra.js';
import { scanMarketFlow, type FlowResult } from './providers/polygonFlow.js';

// Ported from src/app/api/ai/briefing/route.ts. Removed the Vercel
// maxDuration cap (this runs in the Railway worker now).

function isMarketOpenNow(): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  const hours = parseInt(get('hour'), 10) || 0;
  const minutes = parseInt(get('minute'), 10) || 0;
  const dayName = get('weekday');
  if (dayName === 'Sat' || dayName === 'Sun') return false;
  const time = hours * 60 + minutes;
  return time >= 570 && time <= 960; // 9:30 AM - 4:00 PM ET
}

// Stocks to analyze for the briefing
const INDICES = ['SPY', 'QQQ', 'IWM'];
const SECTOR_ETFS = ['XLF', 'XLE', 'XLK', 'XLV', 'XLI', 'XLRE', 'XLU', 'XLC', 'XLB', 'XLP', 'XLY'];
const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'];
const ALL_TICKERS = [...INDICES, ...SECTOR_ETFS, ...MAG7];
const CONCURRENCY = 3; // Reduced from 5 to stay under Vercel's 2048MB memory limit

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
  // Generated trade ideas from recommendation engine
  trades: TradeIdea[];
  nearestExp: string;
  nearestDTE: number;
  weeklyExp?: string;
  monthlyExp?: string;
  // Volatility regime context
  vrp: number; // IV - HV (Volatility Risk Premium in decimal)
  hv10: number;
  hv30: number;
  hv60: number;
  termStructureDirection: 'contango' | 'backwardation' | 'flat';
  nearTermIV: number;
  farTermIV: number;
  // Intraday price action
  open: number;
  high: number;
  low: number;
  volume: number;
  avgVolume: number;
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
    else if (hvValues[i] >= (sorted[Math.floor(sorted.length * 0.66)] ?? 999)) { highVolRets.push(fwd20); }
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

    // Additional HV windows for vol regime context
    const hv10 = computeHistoricalVolatility(closes, 10);
    const hv30 = computeHistoricalVolatility(closes, 30);
    const hv60 = computeHistoricalVolatility(closes, 60);
    const vrp = currentIV - hvCurrent; // Volatility Risk Premium

    // Term structure direction from multiple chains
    let nearTermIV = currentIV;
    let farTermIV = currentIV;
    let termStructureDirection: 'contango' | 'backwardation' | 'flat' = 'flat';
    if (chains.length >= 2) {
      const getChainATMIV = (chain: typeof chains[0]) => {
        const atm = [...chain.calls, ...chain.puts]
          .filter(o => Math.abs(o.strike - spotPrice) / spotPrice < atmTolerance && o.impliedVolatility > 0.01)
          .sort((a, b) => Math.abs(a.strike - spotPrice) - Math.abs(b.strike - spotPrice));
        return atm.length > 0 ? atm.slice(0, 4).reduce((s, o) => s + o.impliedVolatility, 0) / Math.min(4, atm.length) : 0;
      };
      nearTermIV = getChainATMIV(chains[0]) || currentIV;
      farTermIV = getChainATMIV(chains[chains.length - 1]) || currentIV;
      const diff = farTermIV - nearTermIV;
      termStructureDirection = diff > 0.005 ? 'contango' : diff < -0.005 ? 'backwardation' : 'flat';
    }

    // Resolve expiration dates from the full list (not just the 3 we fetched chains for)
    // This ensures we can find a monthly expiration even if it's not in nearExps
    const weeklyExp = expirations.find(e => e.dte >= 5 && e.dte <= 10)?.date;
    const monthlyExp = expirations.find(e => e.dte >= 25 && e.dte <= 50)?.date
      || expirations.find(e => e.dte >= 14 && e.dte <= 24)?.date; // fallback to 2-3 week if no monthly

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
      weeklyExp,
      monthlyExp,
      correlationCtx,
      isMarketOpen: isMarketOpenNow(),
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
      trades: rec.trades.slice(0, 3), // top 3 trade ideas per stock
      nearestExp: nearExps[0]?.date || '',
      nearestDTE: nearExps[0]?.dte || 0,
      weeklyExp,
      monthlyExp,
      // Volatility regime
      vrp, hv10, hv30, hv60,
      termStructureDirection, nearTermIV, farTermIV,
      // Intraday price action
      open: quote.open,
      high: quote.high,
      low: quote.low,
      volume: quote.volume,
      avgVolume: quote.avgVolume,
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
    // Intraday context
    const range = s.high > 0 && s.low > 0 ? s.high - s.low : 0;
    const rangePos = range > 0 ? ((s.price - s.low) / range * 100).toFixed(0) : '—';
    const relVol = s.avgVolume > 0 ? (s.volume / s.avgVolume * 100).toFixed(0) : '—';
    const vrpPp = s.vrp * 100;
    const vrpLabel = vrpPp > 0 ? `+${vrpPp.toFixed(1)}pp (sellers' edge)` : `${vrpPp.toFixed(1)}pp (buyers' edge)`;
    const lines = [
      `${s.symbol}: $${s.price.toFixed(2)} (${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%) | Bias: ${s.biasScore > 0 ? '+' : ''}${s.biasScore} ${s.bias} | Gamma: ${s.gammaRegime} | IV: ${s.volRegime} (rank ${s.ivRank}, ${(s.currentIV * 100).toFixed(0)}% IV vs ${(s.hvCurrent * 100).toFixed(0)}% HV) | PCR: ${s.volumePCR.toFixed(2)} | Skew: ${s.skewBias}`,
      `  VRP: ${vrpLabel} | HV10: ${(s.hv10 * 100).toFixed(0)}% | HV20: ${(s.hvCurrent * 100).toFixed(0)}% | HV30: ${(s.hv30 * 100).toFixed(0)}% | HV60: ${(s.hv60 * 100).toFixed(0)}% | Term Structure: ${s.termStructureDirection} (near ${(s.nearTermIV * 100).toFixed(0)}% → far ${(s.farTermIV * 100).toFixed(0)}%)`,
      `  GEX: ${gexLabel} | DEX: ${dexLabel} | Vanna: ${s.vannaRegime} | Charm: ${s.charmRegime} | ATR: ${s.atrPercent.toFixed(1)}% | Daily 1σ: ${(s.dailySigma * 100).toFixed(2)}%`,
      `  Intraday: O=$${s.open.toFixed(2)} H=$${s.high.toFixed(2)} L=$${s.low.toFixed(2)} | Range: $${range.toFixed(2)} (${rangePos}% from low) | Vol: ${(s.volume / 1e6).toFixed(1)}M (${relVol}% of avg)`,
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

  const marketOpen = isMarketOpenNow();
  const marketNote = !marketOpen ? `
** MARKET IS CURRENTLY CLOSED **
All volume, flow, and intraday data below is from the LAST trading session — it is STALE.
DO NOT treat zero or low volume metrics as bearish signals or as evidence of low conviction.
DO NOT weight volume P/C ratios, options flow, or sweep/block data as current signals.
FOCUS ON: OI-based dealer positioning (GEX, DEX, vanna, charm, gamma flip, walls, max pain), IV regime, skew, term structure, and structural levels.
Momentum data reflects the prior session and may include after-hours moves.
Frame your briefing as preparation for the NEXT session, not as live market commentary.
` : '';

  let prompt = `You are a senior quantitative market strategist. Generate a comprehensive ${marketOpen ? 'MORNING BRIEFING' : 'PRE-SESSION ANALYSIS'} from ${marketOpen ? 'live' : 'end-of-day'} options flow and dealer positioning data across ${stocks.length} securities.

Your analysis should be direct, opinionated, and actionable — like a trading desk morning note. Lead with the single most important headline. Use specific numbers. Identify the primary edge for ${marketOpen ? 'today' : 'the next session'}.
${marketNote}
CRITICAL: You have intraday price action data (open, high, low, volume vs average) and second-order Greeks (vanna, charm) in addition to gamma. Use ALL of them:
- VANNA: sensitivity of delta to implied vol changes. "Bullish vanna" means a vol drop forces dealers to buy stock. "Bearish vanna" means a vol drop forces dealers to sell.
- CHARM: delta decay over time. "Bullish charm" means time passing forces dealers to buy. Charm is often the dominant flow on quiet days.
- When vanna and charm DIVERGE (one bullish, one bearish), that creates conflict in dealer hedging — discuss which dominates and why.
- When vanna and charm ALIGN, that confirms the directional bias.
- GAMMA SLOPE measures how rapidly dealer exposure changes near spot — higher slope = stronger pinning effect.

═══════════════════════════════════════════
${marketOpen ? 'LIVE' : 'END-OF-SESSION'} MARKET DATA — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
═══════════════════════════════════════════

VIX: ${vixPrice.toFixed(2)} (${vixChangePct >= 0 ? '+' : ''}${vixChangePct.toFixed(1)}%)

─── INDEX ANALYSIS ───
${indices.map(fmtStock).join('\n\n')}

─── SECTOR ETFs ───
${sectors.map(fmtStock).join('\n\n')}

─── MAGNIFICENT 7 ───
${mag7.map(fmtStock).join('\n\n')}`;

  // Volatility Regime Summary
  const vrpStocks = stocks.filter(s => INDICES.includes(s.symbol));
  if (vrpStocks.length > 0) {
    prompt += `\n\n─── VOLATILITY REGIME SUMMARY ───`;
    prompt += `\n(VRP = IV - HV20. Positive = sellers' edge. Negative = buyers' edge. Term structure: contango = normal, backwardation = event risk)`;
    for (const s of vrpStocks) {
      const vrpPp = s.vrp * 100;
      const hvTrend = s.hv10 > s.hv60 * 1.1 ? 'EXPANDING' : s.hv10 < s.hv60 * 0.9 ? 'COMPRESSING' : 'stable';
      prompt += `\n${s.symbol}: VRP ${vrpPp > 0 ? '+' : ''}${vrpPp.toFixed(1)}pp | IV Rank ${s.ivRank} | IV/HV ratio ${(s.currentIV / (s.hvCurrent || 0.01)).toFixed(2)} | HV trend: ${hvTrend} (10d: ${(s.hv10 * 100).toFixed(0)}% → 60d: ${(s.hv60 * 100).toFixed(0)}%) | Term: ${s.termStructureDirection}`;
    }
    const avgVRP = vrpStocks.reduce((s, v) => s + v.vrp, 0) / vrpStocks.length * 100;
    const avgIVRank = Math.round(vrpStocks.reduce((s, v) => s + v.ivRank, 0) / vrpStocks.length);
    prompt += `\nMarket avg VRP: ${avgVRP > 0 ? '+' : ''}${avgVRP.toFixed(1)}pp | Avg IV Rank: ${avgIVRank}`;
    prompt += `\nRegime: ${avgVRP > 3 ? 'SELL PREMIUM — IV significantly overprices realized risk across indices' : avgVRP > 0 ? 'Mild seller\'s edge — IV modestly above HV' : avgVRP > -3 ? 'Neutral — IV near fair value' : 'BUY PREMIUM — IV underprices realized vol, options are cheap'}`;
  }

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

  // Algorithm-generated trade ideas from the recommendation engine
  const allTrades = stocks
    .flatMap(s => s.trades.map(t => ({ ...t, ticker: s.symbol, spot: s.price, bias: s.bias, biasScore: s.biasScore, nearestExp: s.nearestExp, nearestDTE: s.nearestDTE, weeklyExp: s.weeklyExp, monthlyExp: s.monthlyExp, ivRank: s.ivRank, currentIV: s.currentIV, gammaFlip: s.gammaFlip, callWall: s.callWall, putWall: s.putWall })))
    .sort((a, b) => b.score - a.score);

  if (allTrades.length > 0) {
    prompt += `\n\n─── ALGORITHM TRADE IDEAS (top ${Math.min(20, allTrades.length)} by conviction score) ───`;
    prompt += `\n(These are quantitative setups from the scoring engine. Use them as starting points — apply your judgment to select the best 3-5 and refine entry/exit.)`;
    for (const t of allTrades.slice(0, 20)) {
      prompt += `\n\n${t.ticker} ($${t.spot.toFixed(2)}) — Score: ${t.biasScore > 0 ? '+' : ''}${t.biasScore} ${t.bias} | IV Rank: ${t.ivRank}`;
      prompt += `\n  Strategy: ${t.strategy} (${t.direction}, ${t.confidence} confidence, algo score: ${t.score})`;
      prompt += `\n  Strikes: ${t.strikes} | Exp: ${t.expiration}`;
      prompt += `\n  Entry: ${t.entry}`;
      prompt += `\n  Risk: ${t.risk}`;
      prompt += `\n  Key levels: γFlip=${t.gammaFlip ? '$' + t.gammaFlip.toFixed(0) : 'N/A'} CW=${t.callWall ? '$' + t.callWall.toFixed(0) : 'N/A'} PW=${t.putWall ? '$' + t.putWall.toFixed(0) : 'N/A'}`;
      prompt += `\n  Reasoning: ${t.reasoning.join(' | ')}`;
    }
  }

  prompt += `\n\n═══════════════════════════════════════════
YOUR TASK — Write the morning briefing. Start with one bold headline sentence that captures today's most important dynamic. Then cover:

## Morning Briefing — ${new Date().toISOString().slice(0, 10)}

**Lead with one bold opening paragraph** summarizing the most critical market dynamic. Reference specific numbers. State the directional lean clearly.

Then analyze:

1. **INTRADAY PRICE ACTION & VOLUME** — Where is price relative to today's open and range? Is volume running above or below average (use the relative volume % data)? Any key reversals from the high/low? How does today's intraday move compare to the ATR? Are we seeing expansion or contraction? Reference specific OHLV numbers.

2. **GAMMA + VANNA + CHARM REGIME** — What's the gamma regime for SPY/QQQ/IWM? Crucially, analyze the VANNA and CHARM readings: which direction do they push dealer hedging? Do they confirm or contradict the gamma signal? If vanna and charm diverge, explain which dominates in the current vol regime (VIX level). Reference gamma flip levels and what happens if breached.

3. **VOLATILITY REGIME & RISK PREMIUM** — This is critical edge-finding analysis. For each index and notable single name:
   - **VRP (Volatility Risk Premium)**: Is IV above or below realized vol? Positive VRP = options overpriced (sellers' edge). Negative VRP = options underpriced (buyers' edge). Reference the VRP numbers provided for each stock.
   - **HV Term Structure**: Compare HV10 vs HV20 vs HV30 vs HV60. Rising short-term HV (HV10 > HV60) = vol expansion. Falling (HV10 < HV60) = vol compression. This tells you whether realized vol is accelerating or decelerating.
   - **IV Term Structure**: Contango (far IV > near IV) is normal. Backwardation (near IV > far IV) signals imminent event risk — premium sellers should avoid near-term. Reference the term structure direction and near/far IV levels.
   - **Net Assessment**: State clearly: "sell premium" vs "buy premium" vs "neutral" for each major name, and WHY based on VRP + term structure + IV rank. This directly informs the trade ideas section.

4. **INDEX DIVERGENCES** — Are SPY, QQQ, IWM aligned or divergent? What does the split mean? Is this rotation or broad trend? Which index has the cleanest directional setup based on gamma+vanna+charm alignment?

5. **MAGNIFICENT 7 BREAKDOWN** — For each Mag7 stock with notable positioning, state the directional lean and which Greek(s) drive it. Flag any that diverge from their index. Count how many are long vs short — does narrow leadership make QQQ vulnerable?

${flowData.flow.tickersScanned > 0 ? '6. **OPTIONS FLOW ANALYSIS** — Analyze the real-time options premium flow. What does the net premium tell us? Which tickers have the most aggressive institutional positioning? Are sweeps/blocks confirming or diverging from dealer gamma positioning? Cross-reference flow direction with GEX regime for each ticker.\n\n' : ''}${swapSummary.totalMaturitiesToday > 0 || swapSummary.totalMaturitiesWeek > 0 ? '7. **SWAP MATURITIES** — Interpret swap maturities. Extreme clusters create forced dealer rebalancing. Cross-reference with flow alerts: are institutions positioning ahead of maturity unwinds?\n\n' : ''}${regSHOList.length > 0 || shortInterestData.length > 0 ? '8. **SHORT INTEREST / REG SHO** — Notable names with persistent FTDs or high days-to-cover. Cross-reference with options flow: are shorts being squeezed (bullish flow + high SI)?\n\n' : ''}9. **KEY LEVELS** — For SPY specifically: gamma flip, call wall, put wall, max pain. What happens at each level.

10. **OPTIONS TRADE IDEAS** — This is critical. Using all available data (dealer Greeks, flow, IV regime, VRP, key levels, intraday price action, algorithm trade ideas above), present **3-5 specific, actionable short-term options plays**. For EACH trade, provide ALL of these fields in a structured format:

| Field | Required Detail |
|-------|----------------|
| **Ticker** | Stock symbol |
| **Direction** | Bullish / Bearish / Neutral |
| **Strategy** | e.g., "Buy 605C weeklies", "Bear put spread 590/580", "Sell iron condor 595/600/610/615" |
| **Strike(s)** | Exact strike price(s) — MUST follow strike rules below |
| **Expiration** | Specific date and DTE |
| **Entry** | Price target or condition for entry |
| **Target** | Profit target price/level |
| **Stop/Max Loss** | Where to cut the trade |
| **Thesis** | 2-3 sentences: what Greek/flow/level drives this, what catalyst or positioning supports it |
| **Invalidation** | What specific level or event kills the trade |

**MANDATORY STRIKE SELECTION RULES — FOLLOW THESE EXACTLY:**
1. **Near-the-money only**: All strikes MUST be within 2 ATR of the current spot price. For SPY at $605 with 1% ATR (~$6), that means strikes between ~$593 and ~$617. NEVER pick strikes like $700C or $250P — those are far OTM penny options worth $0.01 with zero edge.
2. **Minimum premium**: Every individual option leg must have an estimated market value of at least $0.10 per contract. If a strike would trade for pennies, move it closer to the money. A $5-wide spread should cost at least $0.50-1.50 in premium, NOT $0.01.
3. **Use key levels for strike placement**: Place short strikes near gamma flip, put wall, or call wall levels. Place long strikes 1 ATR beyond the short strikes. The algorithm's ATR-based strikes above are good starting points.
4. **Credit spreads**: Short strike should be ~0.5-1 ATR from spot (near a support/resistance level). The premium collected should be 20-40% of the spread width.
5. **Debit spreads**: Long strike should be ATM or slightly ITM. Short strike should be 1-2 ATR away. The debit paid should be 30-60% of the spread width.
6. **Position value floor**: Each contract in the position must have a notional value of at least $100 (i.e., option mid price × 100 shares ≥ $100, so mid ≥ $1.00 per leg for single-leg trades, or net spread premium ≥ $0.50).
7. **Expiration selection**: Credit strategies (iron condors, credit spreads) MUST use 30-45 DTE for meaningful premium — NEVER use weekly expirations for premium-selling strategies (near-expiry OTM options are worth pennies). Debit strategies can use 14-21 DTE. Only event plays (gamma flip straddle, expiration pin) should use weekly/0DTE. State the DTE clearly in your expiration field.

Prioritize trades where multiple signals converge: gamma positioning + flow direction + key level proximity + IV regime + VRP. Use the VRP data to determine strategy type: positive VRP (IV > HV) favors credit strategies; negative VRP favors debit strategies. Use HV term structure to gauge vol momentum. Prefer defined-risk strategies (spreads) over naked options. Reference the algorithm trade ideas data above — use their ATR-derived strikes as the foundation, then adjust based on key levels and flow data.

CRITICAL FORMAT REQUIREMENT: Start each trade idea with "TRADE N:" (e.g., "TRADE 1: SPY BULL PUT SPREAD") followed by the fields in either table or colon format. This exact prefix is required for the UI to parse and display your trade ideas. Example:

TRADE 1: SPY BULL PUT SPREAD
| **Ticker** | SPY |
| **Direction** | Bullish |
| **Strategy** | Bull put spread |
| **Strike(s)** | Sell $595P / Buy $590P |
| **Expiration** | 2025-02-21 (7 DTE) |
| **Entry** | Enter for ~$1.20 credit |
| **Target** | 50% of max credit ($0.60) |
| **Stop/Max Loss** | Close at $3.80 debit (net risk ~$380) |
| **Thesis** | Positive GEX regime pins price above gamma flip. Vanna + charm both push dealer buying. |
| **Invalidation** | Break below $590 put wall |

Be opinionated and direct. Use **bold** for key names, levels, and directional calls. Every claim must reference specific data. Do NOT hedge every statement — make clear calls.`;

  return prompt;
}

// ─── Parse Claude's trade ideas from narrative text ──────────

interface AITradeIdea {
  title: string;
  ticker: string;
  direction: string;
  strategy: string;
  strikes: string;
  expiration: string;
  entry: string;
  target: string;
  stopMaxLoss: string;
  thesis: string;
  invalidation: string;
}

function parseAITradeIdeas(text: string): AITradeIdea[] {
  const ideas: AITradeIdea[] = [];
  const lines = text.split('\n');

  // Strategy 1: Find "TRADE N:" blocks (Claude's primary format)
  // e.g., "TRADE 1: TSLA MOMENTUM PLAY" or "**TRADE 1: TSLA MOMENTUM**"
  const tradeStartIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\*{0,2}TRADE\s+\d+/i.test(lines[i])) {
      tradeStartIndices.push(i);
    }
  }

  // Strategy 2 (fallback): Find "N." or "N)" numbered blocks after a trade-related heading
  if (tradeStartIndices.length === 0) {
    let inSection = false;
    for (let i = 0; i < lines.length; i++) {
      if (/(?:trade\s+ideas?|options?\s+trade|actionable\s+(?:plays?|setups?|ideas?)|recommended\s+trades?)/i.test(lines[i])) {
        inSection = true;
        continue;
      }
      if (inSection && /^\s*(?:#{1,3}\s*|\*{1,2})?\d+[\.\)]\s+\S/.test(lines[i])) {
        tradeStartIndices.push(i);
      }
      // Stop at next major heading that isn't trade-related
      if (inSection && /^#{1,2}\s/.test(lines[i]) && !/trade|play|setup|idea|options/i.test(lines[i]) && !/\d+[\.\)]/.test(lines[i])) {
        break;
      }
    }
  }

  // Strategy 3 (fallback): Find heading-style trade blocks "### N. TICKER — Strategy"
  if (tradeStartIndices.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*#{2,4}\s*\d+[\.\)]\s+[A-Z]{1,5}\s/.test(lines[i])) {
        tradeStartIndices.push(i);
      }
    }
  }

  // Strategy 4 (fallback): Find bold-prefixed trade entries "**1. TICKER — Strategy**"
  if (tradeStartIndices.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\*{2}\d+[\.\)]\s+[A-Z]{1,5}\s/.test(lines[i])) {
        tradeStartIndices.push(i);
      }
    }
  }

  if (tradeStartIndices.length === 0) return ideas;

  // Process each trade block
  for (let t = 0; t < tradeStartIndices.length; t++) {
    const start = tradeStartIndices[t];
    const end = t + 1 < tradeStartIndices.length ? tradeStartIndices[t + 1] : Math.min(start + 30, lines.length);
    const blockLines = lines.slice(start, end);
    const block = blockLines.join('\n');

    // Extract title from first line
    const titleLine = blockLines[0].replace(/\*\*/g, '').replace(/^#{1,4}\s*/, '').trim();
    const titleMatch = titleLine.match(/(?:TRADE\s+\d+\s*[:\-–—]\s*)(.*)/i)
      || titleLine.match(/^\d+[\.\)]\s+(.*)/);
    const title = titleMatch ? titleMatch[1].trim() : titleLine;

    // Field extractor: handles multiple formats
    const field = (name: string): string => {
      for (const line of blockLines) {
        const raw = line.trim();

        // Format A: Pipe-separated table: "| **Ticker** | TSLA |" or "| Ticker | TSLA |" or "| Ticker: | TSLA |"
        const pipeMatch = raw.match(new RegExp(
          `\\|\\s*\\*{0,2}${name}[^|]*\\*{0,2}\\s*\\|\\s*(.+?)\\s*\\|?\\s*$`, 'i'
        ));
        if (pipeMatch) return pipeMatch[1].replace(/\*\*/g, '').trim();

        // Format B: "**Field:** Value" or "Field: Value" (with optional leading - * >)
        const stripped = raw.replace(/^[\s\-*|>]+/, '').trim();
        const colonMatch = stripped.match(new RegExp(
          `^\\*{0,2}${name}[^:]*:\\s*\\*{0,2}(.+)`, 'i'
        ));
        if (colonMatch) return colonMatch[1].replace(/\*\*/g, '').replace(/\|?\s*$/, '').trim();
      }
      return '';
    };

    let ticker = field('Ticker');
    // Fallback: extract ticker from title (first uppercase word that looks like a symbol)
    if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
      const titleTicker = title.match(/\b([A-Z]{1,5})\b/);
      if (titleTicker) ticker = titleTicker[1];
    }
    // Also try extracting from the block content if title didn't have it
    if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
      const blockTicker = block.match(/\b(SPY|QQQ|IWM|AAPL|MSFT|GOOGL|AMZN|NVDA|TSLA|META|XLF|XLE|XLK|XLV|XLI|XLY|XLP|XLU|XLRE|XLB|XLC|DIA|GLD|TLT)\b/);
      if (blockTicker) ticker = blockTicker[1];
    }
    if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) continue;

    ideas.push({
      title,
      ticker,
      direction: field('Direction'),
      strategy: field('Strategy'),
      strikes: field('Strike') || field('Strikes'),
      expiration: field('Expiration') || field('Exp'),
      entry: field('Entry'),
      target: field('Target') || field('Profit'),
      stopMaxLoss: field('Stop') || field('Max Loss') || field('Risk'),
      thesis: field('Thesis') || field('Thesi') || field('Rationale'),
      invalidation: field('Invalidation') || field('Invalid'),
    });
  }

  return ideas;
}

export interface BriefingRunResult {
  analysis: string;
  stocksScanned: number;
  timestamp: number;
  vix: number;
  // Full Claude prompt — the worker stores this so you can audit decisions.
  prompt: string;
  aiTradeIdeas: Array<{
    title: string;
    ticker: string;
    direction: string;
    strategy: string;
    strikes: string;
    expiration: string;
    entry: string;
    target: string;
    stopMaxLoss: string;
    thesis: string;
    invalidation: string;
    spot: number;
    nearestExp: string;
    nearestDTE: number;
    weeklyExp?: string;
    monthlyExp?: string;
    gammaFlip: number | null;
    callWall: number | null;
    putWall: number | null;
    ivRank: number;
    biasScore: number;
    bias: 'bullish' | 'bearish' | 'neutral';
  }>;
}

export async function runBriefing(): Promise<BriefingRunResult> {
  const t0 = Date.now();
  const phase = (msg: string) => console.log(`[briefing] ${msg} (+${Date.now() - t0}ms)`);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  phase('Starting briefing generation');

    // Helper: race a promise against a hard deadline
    const raceTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
      Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

    // ════════════════════════════════════════════════════════════
    // PHASE 1: Scan stocks + fetch institutional data + build prompt
    // Wrapped in async scope so institutional Maps/Sets/arrays become
    // GC-eligible before the Claude API call starts (reduces peak memory)
    // ════════════════════════════════════════════════════════════
    const { results, prompt, vixPrice, tradeIdeas } = await (async () => {
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
      // NOTE: DTCC swap ZIP skipped — decompressing the cumulative equity swap
      // report peaks at 200-400MB which OOM-kills on Vercel's 2048MB limit.
      const institutionalPromise = Promise.all([
        getQuote('VIX').catch(() => null),
        Promise.resolve(emptySwap),
        raceTimeout(fetchRegSHOThreshold().catch(() => new Set<string>()), 4000, new Set<string>()),
        raceTimeout(fetchShortInterest().catch(() => new Map<string, ShortInterestData>()), 5000, new Map<string, ShortInterestData>()),
        raceTimeout(fetchShortSaleVolume().catch(() => new Map<string, ShortVolumeData>()), 5000, new Map<string, ShortVolumeData>()),
        raceTimeout(scanMarketFlow().catch(() => emptyFlow), 8000, emptyFlow),
      ]);
      phase('Institutional data fetches started');

      // Scan all stocks in parallel batches (runs concurrently with institutional data)
      const scanResults: StockScan[] = [];
      for (let i = 0; i < ALL_TICKERS.length; i += CONCURRENCY) {
        const batch = ALL_TICKERS.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(t => scanStock(t)));
        for (const r of batchResults) {
          if (r) scanResults.push(r);
        }
      }
      phase(`Stock scanning done: ${scanResults.length}/${ALL_TICKERS.length} scanned`);

      // Wait for institutional data (likely already done since stock scanning takes longer)
      const [vixQuote, swapSummary, regSHOSet, shortInterestMap, shortVolumeMap, flowResult] = await institutionalPromise;
      phase('Institutional data ready');
      const vp = vixQuote?.last ?? 0;
      const vpc = vixQuote?.changePct ?? 0;
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

      // Build prompt
      phase('Building Claude prompt');
      const builtPrompt = buildBriefingPrompt(scanResults, vp, vpc, swapSummary, regSHOList, shortInterestData, shortVolumeData, flowResult);

      // Build structured trade ideas for the UI (for paper trading buttons)
      const ideas = scanResults
        .flatMap(s => s.trades.map(t => ({
          ticker: s.symbol,
          spot: s.price,
          bias: s.bias,
          biasScore: s.biasScore,
          strategy: t.strategy,
          direction: t.direction,
          confidence: t.confidence,
          score: t.score,
          strikes: t.strikes,
          expiration: t.expiration,
          targetExp: t.targetExp,
          entry: t.entry,
          risk: t.risk,
          reasoning: t.reasoning,
          tags: t.tags,
          profitTargetPct: t.profitTargetPct,
          stopLossPct: t.stopLossPct,
          nearestExp: s.nearestExp,
          nearestDTE: s.nearestDTE,
          weeklyExp: s.weeklyExp,
          monthlyExp: s.monthlyExp,
          ivRank: s.ivRank,
          currentIV: s.currentIV,
          gammaFlip: s.gammaFlip,
          callWall: s.callWall,
          putWall: s.putWall,
        })))
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);

      return { results: scanResults, prompt: builtPrompt, vixPrice: vp, tradeIdeas: ideas };
    })();
    // shortInterestMap, shortVolumeMap, regSHOSet, swapSummary, flowResult,
    // shortInterestData, shortVolumeData, regSHOList are now GC-eligible

    if (results.length === 0) {
      throw new Error('Failed to scan any stocks');
    }

    phase(`Prompt built (${prompt.length} chars). Calling Claude API...`);

    // ════════════════════════════════════════════════════════════
    // PHASE 2: Call Claude API
    // Wrapped so request body, response buffers, and allContent array
    // are released after extracting the final text
    // ════════════════════════════════════════════════════════════
    const text = await (async () => {
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

      return allContent
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n') || 'No response generated.';
    })();
    // body, allContent, response buffers now GC-eligible

    // ════════════════════════════════════════════════════════════
    // PHASE 3: Build response
    // ════════════════════════════════════════════════════════════
    const parsedAIIdeas = parseAITradeIdeas(text);
    console.log(`[ai/briefing] Parsed ${parsedAIIdeas.length} AI trade ideas from narrative (${text.length} chars). Tickers: ${parsedAIIdeas.map(i => i.ticker).join(', ') || 'none'}`);

    // Enrich parsed AI ideas with stock scan data (expiration, spot price, levels)
    const aiTradeIdeas = parsedAIIdeas.map(ai => {
      const scan = results.find(s => s.symbol === ai.ticker);
      return {
        ...ai,
        spot: scan?.price ?? 0,
        nearestExp: scan?.nearestExp ?? '',
        nearestDTE: scan?.nearestDTE ?? 0,
        weeklyExp: scan?.weeklyExp,
        monthlyExp: scan?.monthlyExp,
        gammaFlip: scan?.gammaFlip ?? null,
        callWall: scan?.callWall ?? null,
        putWall: scan?.putWall ?? null,
        ivRank: scan?.ivRank ?? 0,
        biasScore: scan?.biasScore ?? 0,
        bias: scan?.bias ?? 'neutral',
      };
    });

  return {
    analysis: text,
    stocksScanned: results.length,
    timestamp: Date.now(),
    vix: vixPrice,
    prompt,
    aiTradeIdeas,
  };
}
