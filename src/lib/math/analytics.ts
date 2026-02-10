/**
 * Contextual Analytics Engine
 *
 * Computes metrics WITH context:
 * - "IV rank 82 — elevated vs 52-week range"
 * - "Put volume 340% above 20-day average"
 * - "Dealers abnormally short delta vs past 5 expirations"
 * - "GEX flipped negative 2 days ago — regime change"
 */

import type { OptionsChain, OptionContract } from '@/types/market';
import type { StrikeExposure } from '@/lib/math/blackScholes';

// ─── IV Analytics ──────────────────────────────────────────

export interface IVContext {
  currentIV: number;
  ivRank: number;          // 0-100: where current IV sits in 52w high-low range
  ivPercentile: number;    // 0-100: % of days IV was lower
  iv30dMA: number;
  iv52wHigh: number;
  iv52wLow: number;
  hvCurrent: number;       // 20-day historical vol
  ivHvRatio: number;       // IV/HV — >1 means options overpriced
  interpretation: string;
}

export function computeIVRankPercentile(
  currentIV: number,
  historicalIVs: number[] // daily IV readings, newest first
): { ivRank: number; ivPercentile: number; iv52wHigh: number; iv52wLow: number; iv30dMA: number } {
  if (historicalIVs.length < 5) {
    return { ivRank: 50, ivPercentile: 50, iv52wHigh: currentIV, iv52wLow: currentIV, iv30dMA: currentIV };
  }

  const iv52wHigh = Math.max(...historicalIVs);
  const iv52wLow = Math.min(...historicalIVs);
  const range = iv52wHigh - iv52wLow;
  const ivRank = range > 0 ? Math.max(0, Math.min(100, ((currentIV - iv52wLow) / range) * 100)) : 50;

  const below = historicalIVs.filter(iv => iv < currentIV).length;
  const ivPercentile = (below / historicalIVs.length) * 100;

  const last30 = historicalIVs.slice(0, Math.min(30, historicalIVs.length));
  const iv30dMA = last30.reduce((s, v) => s + v, 0) / last30.length;

  return { ivRank: Math.round(ivRank), ivPercentile: Math.round(ivPercentile), iv52wHigh, iv52wLow, iv30dMA };
}

export function computeHistoricalVolatility(closes: number[], window: number = 20): number {
  if (closes.length < window + 1) return 0;
  const returns: number[] = [];
  for (let i = 1; i <= window; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      returns.push(Math.log(closes[i - 1] / closes[i]));
    }
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252); // Annualized
}

export function interpretIV(ctx: IVContext, vixPrice?: number): string {
  const parts: string[] = [];

  // IV Rank context
  if (ctx.ivRank >= 80) {
    parts.push(`IV Rank at ${ctx.ivRank} — near 52-week highs (${ (ctx.currentIV * 100).toFixed(0)}% vs high of ${(ctx.iv52wHigh * 100).toFixed(0)}%). Options are expensive; favor selling premium.`);
  } else if (ctx.ivRank >= 60) {
    parts.push(`IV Rank at ${ctx.ivRank} — moderately elevated. Current IV ${(ctx.currentIV * 100).toFixed(0)}% is above average.`);
  } else if (ctx.ivRank <= 20) {
    parts.push(`IV Rank at ${ctx.ivRank} — near 52-week lows (${(ctx.currentIV * 100).toFixed(0)}% vs low of ${(ctx.iv52wLow * 100).toFixed(0)}%). Options are cheap; favor buying premium.`);
  } else {
    parts.push(`IV Rank at ${ctx.ivRank} — mid-range. Nothing extreme.`);
  }

  // IV vs HV
  if (ctx.ivHvRatio > 1.3) {
    parts.push(`IV/HV ratio ${ctx.ivHvRatio.toFixed(2)} — implied vol significantly exceeds realized vol. Market pricing more risk than recent moves suggest; potential vol overpricing.`);
  } else if (ctx.ivHvRatio < 0.8) {
    parts.push(`IV/HV ratio ${ctx.ivHvRatio.toFixed(2)} — implied vol BELOW realized. Options may be underpriced relative to actual movement.`);
  }

  // Trend
  if (ctx.currentIV > ctx.iv30dMA * 1.15) {
    parts.push(`IV is ${((ctx.currentIV / ctx.iv30dMA - 1) * 100).toFixed(0)}% above 30-day MA — rising volatility regime.`);
  } else if (ctx.currentIV < ctx.iv30dMA * 0.85) {
    parts.push(`IV is ${((1 - ctx.currentIV / ctx.iv30dMA) * 100).toFixed(0)}% below 30-day MA — falling volatility.`);
  }

  // VIX context — compare stock IV to market fear gauge
  if (vixPrice && vixPrice > 0) {
    const ivPct = ctx.currentIV * 100;
    const spread = ivPct - vixPrice;
    if (spread > 10) {
      parts.push(`Stock IV (${ivPct.toFixed(0)}%) is ${spread.toFixed(0)}pp above VIX (${vixPrice.toFixed(1)}) — significantly more volatile than the broad market.`);
    } else if (spread > 5) {
      parts.push(`Stock IV trades at a ${spread.toFixed(0)}pp premium to VIX (${vixPrice.toFixed(1)}) — modestly elevated vs market.`);
    } else if (spread < -5) {
      parts.push(`Stock IV (${ivPct.toFixed(0)}%) is ${Math.abs(spread).toFixed(0)}pp below VIX (${vixPrice.toFixed(1)}) — unusually calm relative to market.`);
    }
  }

  return parts.join(' ');
}

// ─── Volume Context ────────────────────────────────────────

export interface VolumeContext {
  todayCallVol: number;
  todayPutVol: number;
  avgCallVol: number;      // 20-day average
  avgPutVol: number;
  callVolRatio: number;    // today / avg
  putVolRatio: number;
  totalVolRatio: number;
  pcrToday: number;
  pcrAvg: number;
  interpretation: string;
}

export function interpretVolume(
  todayCallVol: number,
  todayPutVol: number,
  avgCallVol: number,
  avgPutVol: number,
  avgPCR: number
): VolumeContext {
  const callRatio = avgCallVol > 0 ? todayCallVol / avgCallVol : 1;
  const putRatio = avgPutVol > 0 ? todayPutVol / avgPutVol : 1;
  const totalToday = todayCallVol + todayPutVol;
  const totalAvg = avgCallVol + avgPutVol;
  const totalRatio = totalAvg > 0 ? totalToday / totalAvg : 1;
  const pcrToday = todayCallVol > 0 ? todayPutVol / todayCallVol : 0;

  const parts: string[] = [];

  // Total volume context
  if (totalRatio > 2.5) {
    parts.push(`Total options volume is ${totalRatio.toFixed(1)}x average — extremely elevated activity, likely catalyst-driven.`);
  } else if (totalRatio > 1.5) {
    parts.push(`Options volume running ${((totalRatio - 1) * 100).toFixed(0)}% above average.`);
  } else if (totalRatio < 0.5) {
    parts.push(`Options volume unusually low — ${((1 - totalRatio) * 100).toFixed(0)}% below average.`);
  }

  // Call/Put skew relative to average
  if (callRatio > 2 && putRatio < 1.2) {
    parts.push(`Call volume surging (${callRatio.toFixed(1)}x avg) while puts are normal — aggressive bullish positioning.`);
  } else if (putRatio > 2 && callRatio < 1.2) {
    parts.push(`Put volume surging (${putRatio.toFixed(1)}x avg) while calls are normal — significant hedging demand or bearish flow.`);
  } else if (callRatio > 1.8) {
    parts.push(`Call volume ${callRatio.toFixed(1)}x above average.`);
  } else if (putRatio > 1.8) {
    parts.push(`Put volume ${putRatio.toFixed(1)}x above average.`);
  } else if (callRatio < 0.5) {
    parts.push(`Call volume significantly below average (${(callRatio * 100).toFixed(0)}% of normal).`);
  } else if (putRatio < 0.5) {
    parts.push(`Put volume significantly below average (${(putRatio * 100).toFixed(0)}% of normal).`);
  }

  // PCR shift
  if (avgPCR > 0 && Math.abs(pcrToday - avgPCR) / avgPCR > 0.3) {
    if (pcrToday > avgPCR) {
      parts.push(`P/C ratio ${pcrToday.toFixed(2)} vs ${avgPCR.toFixed(2)} avg — shifted ${((pcrToday / avgPCR - 1) * 100).toFixed(0)}% more bearish than normal.`);
    } else {
      parts.push(`P/C ratio ${pcrToday.toFixed(2)} vs ${avgPCR.toFixed(2)} avg — shifted ${((1 - pcrToday / avgPCR) * 100).toFixed(0)}% more bullish than normal.`);
    }
  }

  return {
    todayCallVol, todayPutVol, avgCallVol, avgPutVol,
    callVolRatio: callRatio, putVolRatio: putRatio, totalVolRatio: totalRatio,
    pcrToday, pcrAvg: avgPCR,
    interpretation: parts.join(' ') || 'Volume within normal ranges.',
  };
}

// ─── Dealer Positioning Context ────────────────────────────

export interface DealerContext {
  gexRegime: 'long' | 'short' | 'neutral';
  gexMagnitude: 'extreme' | 'elevated' | 'normal' | 'low';
  dexBias: 'long' | 'short' | 'neutral';
  spotVsGammaFlip: 'above' | 'below' | 'at' | 'unknown';
  spotVsCallWall: number;   // % distance
  spotVsPutWall: number;
  spotVsMaxPain: number;
  keyLevels: { level: string; price: number; distance: number; interpretation: string }[];
  interpretation: string;
}

export function interpretDealerPositioning(
  spotPrice: number,
  totalGEX: number,
  totalDEX: number,
  gammaFlip: number | null,
  callWall: number | null,
  putWall: number | null,
  maxPainStrike: number,
  exposures: StrikeExposure[]
): DealerContext {
  const parts: string[] = [];
  const keyLevels: DealerContext['keyLevels'] = [];

  // GEX regime
  let gexRegime: DealerContext['gexRegime'] = 'neutral';
  let gexMagnitude: DealerContext['gexMagnitude'] = 'normal';

  if (totalGEX > 0) {
    gexRegime = 'long';
    parts.push(`Dealers are NET LONG gamma ($${abbreviate(totalGEX)}).`);
    parts.push('Expect dealer hedging to suppress volatility — mean-reversion environment. Breakout moves get faded.');
  } else if (totalGEX < 0) {
    gexRegime = 'short';
    parts.push(`Dealers are NET SHORT gamma ($${abbreviate(totalGEX)}).`);
    parts.push('Expect dealer hedging to AMPLIFY moves — trend-following environment. Moves accelerate as dealers chase.');
  }

  // Gamma flip context
  let spotVsGammaFlip: DealerContext['spotVsGammaFlip'] = 'unknown';
  if (gammaFlip !== null) {
    const dist = ((spotPrice - gammaFlip) / spotPrice) * 100;
    if (Math.abs(dist) < 0.5) {
      spotVsGammaFlip = 'at';
      parts.push(`⚠️ Spot is RIGHT AT the gamma flip ($${gammaFlip.toFixed(2)}) — regime transition zone. High instability, expect whipsaw.`);
    } else if (dist > 0) {
      spotVsGammaFlip = 'above';
      parts.push(`Spot is ${dist.toFixed(1)}% above gamma flip ($${gammaFlip.toFixed(2)}) — firmly in positive gamma territory.`);
    } else {
      spotVsGammaFlip = 'below';
      parts.push(`Spot is ${Math.abs(dist).toFixed(1)}% below gamma flip ($${gammaFlip.toFixed(2)}) — in negative gamma territory, moves can accelerate.`);
    }
    keyLevels.push({
      level: 'Gamma Flip', price: gammaFlip,
      distance: dist,
      interpretation: spotVsGammaFlip === 'above' ? 'Support (dealers long gamma above this)' : 'Below this = amplified moves',
    });
  }

  // Call Wall context
  let spotVsCallWall = 0;
  if (callWall !== null) {
    spotVsCallWall = ((callWall - spotPrice) / spotPrice) * 100;
    if (spotVsCallWall < 1 && spotVsCallWall > 0) {
      parts.push(`Approaching Call Wall at $${callWall} (${spotVsCallWall.toFixed(1)}% away) — significant resistance from dealer hedging.`);
    } else if (spotVsCallWall > 0) {
      parts.push(`Call Wall at $${callWall} (${spotVsCallWall.toFixed(1)}% overhead) acts as resistance.`);
    } else {
      parts.push(`Price has broken ABOVE the Call Wall ($${callWall}) — dealers forced to chase, potential short squeeze dynamic.`);
    }
    keyLevels.push({
      level: 'Call Wall', price: callWall,
      distance: spotVsCallWall,
      interpretation: spotVsCallWall > 0 ? 'Resistance — max call gamma' : 'Broken — dealers chasing',
    });
  }

  // Put Wall context
  let spotVsPutWall = 0;
  if (putWall !== null) {
    spotVsPutWall = ((spotPrice - putWall) / spotPrice) * 100;
    if (spotVsPutWall < 1 && spotVsPutWall > 0) {
      parts.push(`Near Put Wall at $${putWall} (${spotVsPutWall.toFixed(1)}% below) — strong support from hedging flows.`);
    } else if (spotVsPutWall > 0) {
      parts.push(`Put Wall at $${putWall} (${spotVsPutWall.toFixed(1)}% below) provides downside support.`);
    } else {
      parts.push(`Price has BROKEN the Put Wall ($${putWall}) — downside protection breached, potential cascade.`);
    }
    keyLevels.push({
      level: 'Put Wall', price: putWall,
      distance: -spotVsPutWall,
      interpretation: spotVsPutWall > 0 ? 'Support — max put gamma' : 'Broken — support lost',
    });
  }

  // Max pain magnet
  const spotVsMaxPain = ((maxPainStrike - spotPrice) / spotPrice) * 100;
  if (Math.abs(spotVsMaxPain) > 2) {
    parts.push(`Max Pain at $${maxPainStrike} (${spotVsMaxPain > 0 ? '+' : ''}${spotVsMaxPain.toFixed(1)}% from spot) — gravitational pull toward expiration.`);
  } else {
    parts.push(`Spot near Max Pain ($${maxPainStrike}) — price pinning likely into expiration.`);
  }
  keyLevels.push({
    level: 'Max Pain', price: maxPainStrike,
    distance: spotVsMaxPain,
    interpretation: Math.abs(spotVsMaxPain) < 2 ? 'Near max pain — pinning expected' : 'Expiration magnet',
  });

  // DEX bias
  let dexBias: DealerContext['dexBias'] = 'neutral';
  if (totalDEX > 0) {
    dexBias = 'long';
  } else if (totalDEX < 0) {
    dexBias = 'short';
    parts.push(`Dealers are net short delta ($${abbreviate(totalDEX)}) — they need to BUY the underlying to hedge, creating potential support.`);
  }

  return {
    gexRegime, gexMagnitude, dexBias, spotVsGammaFlip,
    spotVsCallWall, spotVsPutWall, spotVsMaxPain,
    keyLevels,
    interpretation: parts.join(' '),
  };
}

// ─── Skew Analysis ─────────────────────────────────────────

export interface SkewContext {
  skew25d: number;         // 25-delta put IV - 25-delta call IV
  skewRatio: number;       // OTM put IV / OTM call IV
  skewBias: 'put-heavy' | 'call-heavy' | 'balanced';
  interpretation: string;
}

export function computeSkew(
  calls: OptionContract[],
  puts: OptionContract[],
  spotPrice: number
): SkewContext {
  // Find ~25 delta options
  const call25d = calls.find(c => c.delta > 0 && Math.abs(c.delta - 0.25) < 0.1);
  const put25d = puts.find(p => p.delta < 0 && Math.abs(Math.abs(p.delta) - 0.25) < 0.1);

  // Skew from OTM wings
  const otmCalls = calls.filter(c => c.strike > spotPrice * 1.03 && c.impliedVolatility > 0);
  const otmPuts = puts.filter(p => p.strike < spotPrice * 0.97 && p.impliedVolatility > 0);

  const avgCallIV = otmCalls.length > 0
    ? otmCalls.reduce((s, c) => s + c.impliedVolatility, 0) / otmCalls.length : 0;
  const avgPutIV = otmPuts.length > 0
    ? otmPuts.reduce((s, p) => s + p.impliedVolatility, 0) / otmPuts.length : 0;

  const skew25d = (put25d?.impliedVolatility ?? 0) - (call25d?.impliedVolatility ?? 0);
  const skewRatio = avgCallIV > 0 ? avgPutIV / avgCallIV : 1;

  let skewBias: SkewContext['skewBias'] = 'balanced';
  const parts: string[] = [];

  if (skewRatio > 1.15) {
    skewBias = 'put-heavy';
    parts.push(`Put skew is elevated (${skewRatio.toFixed(2)}x) — market pricing more downside risk. OTM puts are ${((skewRatio - 1) * 100).toFixed(0)}% more expensive than OTM calls.`);
  } else if (skewRatio < 0.9) {
    skewBias = 'call-heavy';
    parts.push(`Call skew is elevated (${(1 / skewRatio).toFixed(2)}x) — unusual demand for upside. OTM calls more expensive than puts.`);
  } else {
    parts.push('Skew is balanced — no extreme directional bias in wings.');
  }

  if (skew25d > 0.05) {
    parts.push(`25-delta skew: ${(skew25d * 100).toFixed(1)}pp put premium over calls.`);
  } else if (skew25d < -0.03) {
    parts.push(`25-delta skew: ${(Math.abs(skew25d) * 100).toFixed(1)}pp call premium over puts — unusual.`);
  }

  return {
    skew25d, skewRatio, skewBias,
    interpretation: parts.join(' '),
  };
}

// ─── OI Concentration Analysis ─────────────────────────────

export interface OIContext {
  topCallStrikes: { strike: number; oi: number; pctOfTotal: number }[];
  topPutStrikes: { strike: number; oi: number; pctOfTotal: number }[];
  oiConcentration: number;  // HHI-like measure of OI concentration
  interpretation: string;
}

export function analyzeOIConcentration(
  calls: OptionContract[],
  puts: OptionContract[]
): OIContext {
  const totalCallOI = calls.reduce((s, c) => s + c.openInterest, 0);
  const totalPutOI = puts.reduce((s, p) => s + p.openInterest, 0);

  const topCalls = [...calls]
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 5)
    .map(c => ({
      strike: c.strike,
      oi: c.openInterest,
      pctOfTotal: totalCallOI > 0 ? (c.openInterest / totalCallOI) * 100 : 0,
    }));

  const topPuts = [...puts]
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 5)
    .map(p => ({
      strike: p.strike,
      oi: p.openInterest,
      pctOfTotal: totalPutOI > 0 ? (p.openInterest / totalPutOI) * 100 : 0,
    }));

  // Top 3 call strikes as % of total
  const top3CallPct = topCalls.slice(0, 3).reduce((s, c) => s + c.pctOfTotal, 0);
  const top3PutPct = topPuts.slice(0, 3).reduce((s, p) => s + p.pctOfTotal, 0);

  const parts: string[] = [];
  if (top3CallPct > 50) {
    parts.push(`Call OI heavily concentrated — top 3 strikes hold ${top3CallPct.toFixed(0)}% of all call OI ($${topCalls[0]?.strike}, $${topCalls[1]?.strike}, $${topCalls[2]?.strike}). These are strong magnet levels.`);
  }
  if (top3PutPct > 50) {
    parts.push(`Put OI heavily concentrated — top 3 strikes hold ${top3PutPct.toFixed(0)}% ($${topPuts[0]?.strike}, $${topPuts[1]?.strike}, $${topPuts[2]?.strike}). Strong support/floor levels.`);
  }

  return {
    topCallStrikes: topCalls,
    topPutStrikes: topPuts,
    oiConcentration: (top3CallPct + top3PutPct) / 2,
    interpretation: parts.join(' ') || 'OI well-distributed across strikes.',
  };
}

// ─── ATR & Stock Profile ──────────────────────────────────

export interface StockProfile {
  atr14: number;           // 14-day ATR in dollars
  atrPercent: number;      // ATR as % of price
  dailySigma: number;      // 1σ daily move in % (from HV20)
  avgDailyRange: number;   // Average |high-low|/close over 20 days
  avgDailyRangePct: number;
  typicalMoveThreshold: number; // Moves below this are "normal" (1.5σ)
  bigMoveThreshold: number;     // Moves above this are "abnormal" (2.5σ)
}

/**
 * Compute ATR (Average True Range) — the REAL measure of how much
 * a stock typically moves. Uses high, low, close data.
 * bars should be oldest-first (chronological).
 */
export function computeATR(
  bars: { h: number; l: number; c: number }[],
  period: number = 14
): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trs.push(tr);
  }
  // EMA-style ATR
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/**
 * Compute a full stock profile — tells you what's "normal" for THIS ticker
 */
export function computeStockProfile(
  bars: { o: number; h: number; l: number; c: number }[],
  currentPrice: number,
  hv20: number
): StockProfile {
  const atr14 = computeATR(bars, 14);
  const atrPercent = currentPrice > 0 ? (atr14 / currentPrice) * 100 : 0;

  // Daily sigma from annualized HV: dailyσ = HV / √252
  const dailySigma = hv20 / Math.sqrt(252) * 100; // as percent

  // Average daily range from last 20 bars
  const recentBars = bars.slice(-20);
  const ranges = recentBars.map(b => Math.abs(b.h - b.l) / b.c * 100);
  const avgDailyRange = recentBars.length > 0
    ? recentBars.reduce((s, b) => s + Math.abs(b.h - b.l), 0) / recentBars.length
    : 0;
  const avgDailyRangePct = ranges.length > 0
    ? ranges.reduce((s, v) => s + v, 0) / ranges.length
    : 0;

  return {
    atr14,
    atrPercent,
    dailySigma,
    avgDailyRange,
    avgDailyRangePct,
    typicalMoveThreshold: dailySigma * 1.5,   // moves < 1.5σ are normal
    bigMoveThreshold: dailySigma * 2.5,        // moves > 2.5σ are abnormal
  };
}

/**
 * Contextualize an intraday move for a specific stock
 */
export function contextualizeMove(
  changePercent: number,
  profile: StockProfile
): { sigma: number; isNormal: boolean; isBig: boolean; description: string } {
  const absChange = Math.abs(changePercent);
  const sigma = profile.dailySigma > 0 ? absChange / profile.dailySigma : 0;
  const isNormal = absChange <= profile.typicalMoveThreshold;
  const isBig = absChange >= profile.bigMoveThreshold;

  let description: string;
  if (isBig) {
    description = `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% move is ${sigma.toFixed(1)}σ — abnormally large for ${profile.atrPercent.toFixed(1)}% ATR stock. Avg daily range: ${profile.avgDailyRangePct.toFixed(1)}%.`;
  } else if (!isNormal) {
    description = `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% move is ${sigma.toFixed(1)}σ — above average but not extreme for this stock (ATR ${profile.atrPercent.toFixed(1)}%).`;
  } else {
    description = `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% move is ${sigma.toFixed(1)}σ — within normal range for this stock (ATR ${profile.atrPercent.toFixed(1)}%).`;
  }

  return { sigma, isNormal, isBig, description };
}

// ─── Helpers ───────────────────────────────────────────────

function abbreviate(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
  return sign + abs.toFixed(0);
}
