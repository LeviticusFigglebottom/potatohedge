/**
 * Correlation & Cross-Reference Analysis Engine
 *
 * Computes behavioral correlations for a stock using historical data:
 * - IV regime performance: does the stock rise when vol is cheap?
 * - Market relative: beta, alpha, drawdown/rally behavior vs SPY
 * - Sector relative: outperformance vs sector ETF
 * - Vol pricing accuracy: does IV consistently over/under-price moves?
 * - Mean reversion tendency: does the stock reverse after big moves?
 * - Volume-price dynamics: what does unusual volume signal?
 * - Anomaly detection
 */

import type { EquityBar } from '@/lib/providers/equityBars';

// ─── Types ────────────────────────────────────────────────────

export interface IVRegimePerformance {
  lowIV: RegimeBucket;
  midIV: RegimeBucket;
  highIV: RegimeBucket;
  insight: string;
}

interface RegimeBucket {
  avgReturn5d: number;
  avgReturn20d: number;
  winRate5d: number;
  sampleSize: number;
}

export interface MarketRelative {
  beta: number;
  correlation: number;
  alpha30d: number;
  alpha90d: number;
  drawdownBehavior: { avgMarketDd: number; avgStockDd: number; ratio: number; count: number };
  rallyBehavior: { avgMarketRally: number; avgStockRally: number; ratio: number; count: number };
  insight: string;
}

export interface SectorRelative {
  sectorETF: string;
  sectorName: string;
  correlation: number;
  relativeStrength30d: number;
  relativeStrength90d: number;
  divergenceDays: number; // days in last 60 where stock and sector moved opposite
  insight: string;
}

export interface VolPricing {
  avgImpliedMove: number;
  avgRealizedMove: number;
  overPricingRate: number;
  avgOverPricing: number;
  insight: string;
}

export interface MeanReversion {
  afterBigUp: { avgNextDayReturn: number; reversalRate: number; avgNext5dReturn: number; sampleSize: number };
  afterBigDown: { avgNextDayReturn: number; reversalRate: number; avgNext5dReturn: number; sampleSize: number };
  insight: string;
}

export interface VolumeDynamics {
  highVolUpDayPct: number;
  avgReturnHighVol: number;
  avgReturnLowVol: number;
  volSurgeFollowThrough: number; // pct of vol surges followed by continuation
  insight: string;
}

export interface Anomaly {
  description: string;
  type: 'bullish' | 'bearish' | 'neutral';
  strength: 'strong' | 'moderate' | 'weak';
}

export interface CorrelationInsight {
  label: string;
  value: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  strength: number; // 0-100
}

export interface CorrelationResult {
  symbol: string;
  ivRegime: IVRegimePerformance;
  marketRelative: MarketRelative;
  sectorRelative: SectorRelative | null;
  volPricing: VolPricing;
  meanReversion: MeanReversion;
  volumeDynamics: VolumeDynamics;
  anomalies: Anomaly[];
  strongestInsights: CorrelationInsight[];
  dataRange: { from: string; to: string; bars: number };
}

// ─── Sector ETF Mapping ───────────────────────────────────────

const SECTOR_ETF_MAP: Record<string, { etf: string; name: string }> = {
  'Technology': { etf: 'XLK', name: 'Tech Sector' },
  'Finance': { etf: 'XLF', name: 'Financial Sector' },
  'Healthcare': { etf: 'XLV', name: 'Healthcare Sector' },
  'Consumer': { etf: 'XLY', name: 'Consumer Discretionary' },
  'Energy': { etf: 'XLE', name: 'Energy Sector' },
  'Industrial': { etf: 'XLI', name: 'Industrial Sector' },
  'Telecom': { etf: 'XLC', name: 'Communication Svcs' },
  'Retail': { etf: 'XRT', name: 'Retail Sector' },
  'Entertainment': { etf: 'XLC', name: 'Communication Svcs' },
  'Automotive': { etf: 'CARZ', name: 'Auto Sector' },
};

export function getSectorETF(sector: string): { etf: string; name: string } | null {
  if (sector === 'ETF') return null;
  return SECTOR_ETF_MAP[sector] || null;
}

// ─── Core Computation ─────────────────────────────────────────

export function computeCorrelations(
  symbol: string,
  stockBars: EquityBar[],
  spyBars: EquityBar[],
  sectorBars: EquityBar[] | null,
  sectorInfo: { etf: string; name: string } | null,
  currentIV: number,
  hvCurrent: number,
): CorrelationResult {
  // Align bars by date (ms timestamps → date strings)
  const stockByDate = indexByDate(stockBars);
  const spyByDate = indexByDate(spyBars);
  const sectorByDate = sectorBars ? indexByDate(sectorBars) : null;

  // Get common dates between stock and SPY
  const commonDates = [...stockByDate.keys()].filter(d => spyByDate.has(d)).sort();

  // Compute daily returns
  const stockReturns = computeReturns(commonDates, stockByDate);
  const spyReturns = computeReturns(commonDates, spyByDate);
  const sectorReturns = sectorByDate ? computeReturns(
    commonDates.filter(d => sectorByDate.has(d)),
    sectorByDate
  ) : null;

  // HV time series (rolling 20-day) to classify IV regimes
  const hvSeries = computeRollingHV(commonDates, stockByDate, 20);

  // Data range
  const from = commonDates.length > 0 ? commonDates[0] : '';
  const to = commonDates.length > 0 ? commonDates[commonDates.length - 1] : '';

  const ivRegime = computeIVRegimePerformance(commonDates, stockByDate, hvSeries);
  const marketRelative = computeMarketRelative(stockReturns, spyReturns, commonDates, stockByDate, spyByDate);
  const sectorRelative = sectorReturns && sectorByDate && sectorInfo
    ? computeSectorRelative(stockReturns, sectorReturns, commonDates, stockByDate, sectorByDate, sectorInfo)
    : null;
  const volPricing = computeVolPricing(commonDates, stockByDate, hvSeries, currentIV, hvCurrent);
  const meanReversion = computeMeanReversion(commonDates, stockByDate, hvSeries);
  const volumeDynamics = computeVolumeDynamics(commonDates, stockByDate);
  const anomalies = detectAnomalies(
    ivRegime, marketRelative, sectorRelative, volPricing, meanReversion, volumeDynamics
  );

  const strongestInsights = rankInsights(
    ivRegime, marketRelative, sectorRelative, volPricing, meanReversion, volumeDynamics, anomalies
  );

  return {
    symbol,
    ivRegime,
    marketRelative,
    sectorRelative,
    volPricing,
    meanReversion,
    volumeDynamics,
    anomalies,
    strongestInsights,
    dataRange: { from, to, bars: commonDates.length },
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function dateKey(ms: number): string {
  return new Date(ms).toISOString().split('T')[0];
}

function indexByDate(bars: EquityBar[]): Map<string, EquityBar> {
  const m = new Map<string, EquityBar>();
  for (const b of bars) {
    m.set(dateKey(b.t), b);
  }
  return m;
}

function computeReturns(dates: string[], byDate: Map<string, EquityBar>): Map<string, number> {
  const rets = new Map<string, number>();
  for (let i = 1; i < dates.length; i++) {
    const prev = byDate.get(dates[i - 1]);
    const curr = byDate.get(dates[i]);
    if (prev && curr && prev.c > 0) {
      rets.set(dates[i], (curr.c - prev.c) / prev.c);
    }
  }
  return rets;
}

function computeRollingHV(dates: string[], byDate: Map<string, EquityBar>, window: number): Map<string, number> {
  const hvMap = new Map<string, number>();
  for (let i = window; i < dates.length; i++) {
    const logReturns: number[] = [];
    for (let j = i - window + 1; j <= i; j++) {
      const prev = byDate.get(dates[j - 1]);
      const curr = byDate.get(dates[j]);
      if (prev && curr && prev.c > 0 && curr.c > 0) {
        logReturns.push(Math.log(curr.c / prev.c));
      }
    }
    if (logReturns.length >= window - 2) {
      const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
      const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
      hvMap.set(dates[i], Math.sqrt(variance * 252));
    }
  }
  return hvMap;
}

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return 0;
  const meanX = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanY = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const denom = Math.sqrt(varX * varY);
  return denom > 0 ? cov / denom : 0;
}

function forwardReturn(dates: string[], byDate: Map<string, EquityBar>, idx: number, days: number): number | null {
  if (idx + days >= dates.length) return null;
  const start = byDate.get(dates[idx]);
  const end = byDate.get(dates[idx + days]);
  if (!start || !end || start.c <= 0) return null;
  return (end.c - start.c) / start.c;
}

// ─── IV Regime Performance ────────────────────────────────────

function computeIVRegimePerformance(
  dates: string[],
  byDate: Map<string, EquityBar>,
  hvSeries: Map<string, number>,
): IVRegimePerformance {
  // Collect all HV values to find percentiles
  const hvValues = [...hvSeries.values()].sort((a, b) => a - b);
  if (hvValues.length < 30) {
    return {
      lowIV: { avgReturn5d: 0, avgReturn20d: 0, winRate5d: 0.5, sampleSize: 0 },
      midIV: { avgReturn5d: 0, avgReturn20d: 0, winRate5d: 0.5, sampleSize: 0 },
      highIV: { avgReturn5d: 0, avgReturn20d: 0, winRate5d: 0.5, sampleSize: 0 },
      insight: 'Insufficient data for IV regime analysis.',
    };
  }

  const p33 = hvValues[Math.floor(hvValues.length * 0.33)];
  const p66 = hvValues[Math.floor(hvValues.length * 0.66)];

  const buckets: { low: number[]; mid: number[]; high: number[] } = { low: [], mid: [], high: [] };
  const buckets20: { low: number[]; mid: number[]; high: number[] } = { low: [], mid: [], high: [] };

  for (let i = 0; i < dates.length; i++) {
    const hv = hvSeries.get(dates[i]);
    if (hv === undefined) continue;
    const ret5 = forwardReturn(dates, byDate, i, 5);
    const ret20 = forwardReturn(dates, byDate, i, 20);
    const bucket = hv <= p33 ? 'low' : hv <= p66 ? 'mid' : 'high';
    if (ret5 !== null) buckets[bucket].push(ret5);
    if (ret20 !== null) buckets20[bucket].push(ret20);
  }

  const makeBucket = (rets5: number[], rets20: number[]): RegimeBucket => ({
    avgReturn5d: rets5.length > 0 ? rets5.reduce((s, v) => s + v, 0) / rets5.length : 0,
    avgReturn20d: rets20.length > 0 ? rets20.reduce((s, v) => s + v, 0) / rets20.length : 0,
    winRate5d: rets5.length > 0 ? rets5.filter(r => r > 0).length / rets5.length : 0.5,
    sampleSize: rets5.length,
  });

  const low = makeBucket(buckets.low, buckets20.low);
  const mid = makeBucket(buckets.mid, buckets20.mid);
  const high = makeBucket(buckets.high, buckets20.high);

  // Generate insight
  const parts: string[] = [];
  if (low.sampleSize > 10 && high.sampleSize > 10) {
    if (low.avgReturn20d > high.avgReturn20d + 0.005) {
      parts.push(`Tends to perform better when vol is cheap: +${(low.avgReturn20d * 100).toFixed(1)}% avg 20d return in low-vol vs ${(high.avgReturn20d * 100).toFixed(1)}% in high-vol.`);
    } else if (high.avgReturn20d > low.avgReturn20d + 0.005) {
      parts.push(`Counter-intuitively performs better in high-vol regimes: +${(high.avgReturn20d * 100).toFixed(1)}% avg 20d return vs ${(low.avgReturn20d * 100).toFixed(1)}% in low-vol.`);
    } else {
      parts.push('No significant performance difference across vol regimes.');
    }
    if (Math.abs(low.winRate5d - high.winRate5d) > 0.08) {
      const better = low.winRate5d > high.winRate5d ? 'low' : 'high';
      const rate = better === 'low' ? low.winRate5d : high.winRate5d;
      parts.push(`${better === 'low' ? 'Low' : 'High'}-vol periods have ${(rate * 100).toFixed(0)}% 5-day win rate.`);
    }
  }

  return {
    lowIV: low,
    midIV: mid,
    highIV: high,
    insight: parts.join(' ') || 'IV regime data available but no strong pattern detected.',
  };
}

// ─── Market Relative ──────────────────────────────────────────

function computeMarketRelative(
  stockReturns: Map<string, number>,
  spyReturns: Map<string, number>,
  dates: string[],
  stockByDate: Map<string, EquityBar>,
  spyByDate: Map<string, EquityBar>,
): MarketRelative {
  // Align returns
  const commonRetDates = dates.filter(d => stockReturns.has(d) && spyReturns.has(d));
  const sx = commonRetDates.map(d => stockReturns.get(d)!);
  const sy = commonRetDates.map(d => spyReturns.get(d)!);

  const correlation = pearsonCorrelation(sx, sy);

  // Beta via covariance / variance
  const n = sx.length;
  const meanX = sx.reduce((s, v) => s + v, 0) / n;
  const meanY = sy.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    cov += (sx[i] - meanX) * (sy[i] - meanY);
    varY += (sy[i] - meanY) ** 2;
  }
  const beta = varY > 0 ? cov / varY : 1;

  // Alpha (30d and 90d cumulative)
  const last30 = commonRetDates.slice(-30);
  const last90 = commonRetDates.slice(-90);
  const cumReturn = (retDates: string[], rets: Map<string, number>) =>
    retDates.reduce((s, d) => s * (1 + (rets.get(d) || 0)), 1) - 1;

  const stockRet30 = cumReturn(last30, stockReturns);
  const spyRet30 = cumReturn(last30, spyReturns);
  const stockRet90 = cumReturn(last90, stockReturns);
  const spyRet90 = cumReturn(last90, spyReturns);
  const alpha30d = stockRet30 - beta * spyRet30;
  const alpha90d = stockRet90 - beta * spyRet90;

  // Drawdown / Rally behavior
  // Identify SPY drawdown periods (rolling 5-day return < -2%) and rally periods (> 2%)
  const drawdowns: { stock: number; spy: number }[] = [];
  const rallies: { stock: number; spy: number }[] = [];

  for (let i = 5; i < commonRetDates.length; i++) {
    const spyRet = forwardReturn(commonRetDates.map(d => d), spyByDate, i - 5, 5);
    const stockRet = forwardReturn(commonRetDates.map(d => d), stockByDate, i - 5, 5);
    if (spyRet === null || stockRet === null) continue;

    if (spyRet < -0.02) {
      drawdowns.push({ stock: stockRet, spy: spyRet });
    } else if (spyRet > 0.02) {
      rallies.push({ stock: stockRet, spy: spyRet });
    }
  }

  const avgArr = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const ddStock = avgArr(drawdowns.map(d => d.stock));
  const ddSpy = avgArr(drawdowns.map(d => d.spy));
  const rallyStock = avgArr(rallies.map(r => r.stock));
  const rallySpy = avgArr(rallies.map(r => r.spy));

  // Insight
  const parts: string[] = [];
  parts.push(`Beta ${beta.toFixed(2)} vs SPY (${correlation > 0.7 ? 'highly correlated' : correlation > 0.4 ? 'moderately correlated' : 'low correlation'}).`);

  if (drawdowns.length > 5) {
    const ddRatio = ddSpy !== 0 ? ddStock / ddSpy : 1;
    if (ddRatio > 1.3) {
      parts.push(`Amplifies market drawdowns: falls ${(ddRatio).toFixed(1)}x as much as SPY during selloffs.`);
    } else if (ddRatio < 0.7) {
      parts.push(`Defensive in drawdowns: falls only ${(ddRatio).toFixed(1)}x vs SPY during selloffs.`);
    }
  }

  if (alpha30d > 0.02) {
    parts.push(`Generating +${(alpha30d * 100).toFixed(1)}% alpha over 30 days.`);
  } else if (alpha30d < -0.02) {
    parts.push(`Underperforming by ${(Math.abs(alpha30d) * 100).toFixed(1)}% alpha over 30 days.`);
  }

  return {
    beta,
    correlation,
    alpha30d,
    alpha90d,
    drawdownBehavior: {
      avgMarketDd: ddSpy, avgStockDd: ddStock,
      ratio: ddSpy !== 0 ? ddStock / ddSpy : 1,
      count: drawdowns.length,
    },
    rallyBehavior: {
      avgMarketRally: rallySpy, avgStockRally: rallyStock,
      ratio: rallySpy !== 0 ? rallyStock / rallySpy : 1,
      count: rallies.length,
    },
    insight: parts.join(' '),
  };
}

// ─── Sector Relative ──────────────────────────────────────────

function computeSectorRelative(
  stockReturns: Map<string, number>,
  sectorReturns: Map<string, number>,
  dates: string[],
  stockByDate: Map<string, EquityBar>,
  sectorByDate: Map<string, EquityBar>,
  sectorInfo: { etf: string; name: string },
): SectorRelative {
  const commonDates = dates.filter(d => stockReturns.has(d) && sectorReturns.has(d));
  const sx = commonDates.map(d => stockReturns.get(d)!);
  const sy = commonDates.map(d => sectorReturns.get(d)!);
  const correlation = pearsonCorrelation(sx, sy);

  // Relative strength
  const cumReturn = (retDates: string[], rets: Map<string, number>) =>
    retDates.reduce((s, d) => s * (1 + (rets.get(d) || 0)), 1) - 1;

  const last30 = commonDates.slice(-30);
  const last90 = commonDates.slice(-90);
  const rs30 = cumReturn(last30, stockReturns) - cumReturn(last30, sectorReturns);
  const rs90 = cumReturn(last90, stockReturns) - cumReturn(last90, sectorReturns);

  // Divergence days (last 60 trading days)
  const last60 = commonDates.slice(-60);
  let divergences = 0;
  for (const d of last60) {
    const sr = stockReturns.get(d);
    const secr = sectorReturns.get(d);
    if (sr !== undefined && secr !== undefined && Math.abs(sr) > 0.005 && Math.abs(secr) > 0.005) {
      if ((sr > 0 && secr < 0) || (sr < 0 && secr > 0)) divergences++;
    }
  }

  const parts: string[] = [];
  if (rs30 > 0.03) {
    parts.push(`Outperforming ${sectorInfo.name} by +${(rs30 * 100).toFixed(1)}% over 30d.`);
  } else if (rs30 < -0.03) {
    parts.push(`Underperforming ${sectorInfo.name} by ${(rs30 * 100).toFixed(1)}% over 30d.`);
  }
  if (divergences > 15) {
    parts.push(`High divergence from sector: moved opposite direction on ${divergences} of last 60 days.`);
  }
  if (correlation < 0.5) {
    parts.push(`Low sector correlation (${correlation.toFixed(2)}) — trades independently of ${sectorInfo.name}.`);
  }

  return {
    sectorETF: sectorInfo.etf,
    sectorName: sectorInfo.name,
    correlation,
    relativeStrength30d: rs30,
    relativeStrength90d: rs90,
    divergenceDays: divergences,
    insight: parts.join(' ') || `Tracking ${sectorInfo.name} closely.`,
  };
}

// ─── Vol Pricing Accuracy ─────────────────────────────────────

function computeVolPricing(
  dates: string[],
  byDate: Map<string, EquityBar>,
  hvSeries: Map<string, number>,
  currentIV: number,
  hvCurrent: number,
): VolPricing {
  // Compare rolling HV (realized) to what implied vol WOULD have predicted
  // Since we don't have historical IV, use HV*1.15 proxy (typical risk premium)
  // Then check if moves typically fall within the implied range

  const impliedMoves: number[] = [];
  const realizedMoves: number[] = [];
  let overPriced = 0;
  let total = 0;

  for (let i = 20; i < dates.length - 20; i++) {
    const hv = hvSeries.get(dates[i]);
    if (!hv) continue;

    const impliedDaily = hv * 1.15 / Math.sqrt(252); // proxy IV daily move
    const bar = byDate.get(dates[i]);
    if (!bar || bar.c <= 0) continue;

    // Actual 5-day realized move
    const fwd = forwardReturn(dates, byDate, i, 5);
    if (fwd === null) continue;

    const implied5d = impliedDaily * Math.sqrt(5);
    const realized5d = Math.abs(fwd);

    impliedMoves.push(implied5d);
    realizedMoves.push(realized5d);

    if (implied5d > realized5d) overPriced++;
    total++;
  }

  const avgImplied = impliedMoves.length > 0 ? impliedMoves.reduce((s, v) => s + v, 0) / impliedMoves.length : 0;
  const avgRealized = realizedMoves.length > 0 ? realizedMoves.reduce((s, v) => s + v, 0) / realizedMoves.length : 0;
  const overPricingRate = total > 0 ? overPriced / total : 0.5;
  const avgOverPricing = avgImplied > 0 ? (avgImplied - avgRealized) / avgImplied : 0;

  const parts: string[] = [];
  if (overPricingRate > 0.65) {
    parts.push(`Options historically overpriced ${(overPricingRate * 100).toFixed(0)}% of the time — vol sellers have an edge.`);
  } else if (overPricingRate < 0.45) {
    parts.push(`Options historically underpriced ${((1 - overPricingRate) * 100).toFixed(0)}% of the time — stock moves more than implied.`);
  } else {
    parts.push('Vol pricing roughly fair — no systematic over/under-pricing detected.');
  }

  if (currentIV > 0 && hvCurrent > 0) {
    const ratio = currentIV / hvCurrent;
    if (ratio > 1.3) {
      parts.push(`Currently IV/HV is ${ratio.toFixed(2)} — implied vol ${((ratio - 1) * 100).toFixed(0)}% above realized, favoring premium selling.`);
    } else if (ratio < 0.8) {
      parts.push(`Currently IV/HV is ${ratio.toFixed(2)} — implied vol below realized, options look cheap.`);
    }
  }

  return {
    avgImpliedMove: avgImplied,
    avgRealizedMove: avgRealized,
    overPricingRate,
    avgOverPricing,
    insight: parts.join(' '),
  };
}

// ─── Mean Reversion ───────────────────────────────────────────

function computeMeanReversion(
  dates: string[],
  byDate: Map<string, EquityBar>,
  hvSeries: Map<string, number>,
): MeanReversion {
  const bigUps: { next1d: number; next5d: number }[] = [];
  const bigDowns: { next1d: number; next5d: number }[] = [];

  for (let i = 1; i < dates.length - 5; i++) {
    const prev = byDate.get(dates[i - 1]);
    const curr = byDate.get(dates[i]);
    if (!prev || !curr || prev.c <= 0) continue;

    const dayReturn = (curr.c - prev.c) / prev.c;
    const hv = hvSeries.get(dates[i]);
    const dailySigma = hv ? hv / Math.sqrt(252) : 0.015; // fallback 1.5%

    // Big move = > 2 sigma
    if (Math.abs(dayReturn) < dailySigma * 2) continue;

    const next1d = forwardReturn(dates, byDate, i, 1);
    const next5d = forwardReturn(dates, byDate, i, 5);
    if (next1d === null || next5d === null) continue;

    if (dayReturn > 0) {
      bigUps.push({ next1d, next5d });
    } else {
      bigDowns.push({ next1d, next5d });
    }
  }

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  const afterBigUp = {
    avgNextDayReturn: avg(bigUps.map(b => b.next1d)),
    reversalRate: bigUps.length > 0 ? bigUps.filter(b => b.next1d < 0).length / bigUps.length : 0.5,
    avgNext5dReturn: avg(bigUps.map(b => b.next5d)),
    sampleSize: bigUps.length,
  };

  const afterBigDown = {
    avgNextDayReturn: avg(bigDowns.map(b => b.next1d)),
    reversalRate: bigDowns.length > 0 ? bigDowns.filter(b => b.next1d > 0).length / bigDowns.length : 0.5,
    avgNext5dReturn: avg(bigDowns.map(b => b.next5d)),
    sampleSize: bigDowns.length,
  };

  const parts: string[] = [];
  if (afterBigDown.sampleSize > 5 && afterBigDown.reversalRate > 0.6) {
    parts.push(`Mean-reverts after selloffs: bounces ${(afterBigDown.reversalRate * 100).toFixed(0)}% of the time after 2σ+ drops.`);
  }
  if (afterBigUp.sampleSize > 5 && afterBigUp.reversalRate > 0.55) {
    parts.push(`Tends to pull back after big up days: gives back ${(afterBigUp.reversalRate * 100).toFixed(0)}% of the time.`);
  }
  if (afterBigDown.sampleSize > 5 && afterBigDown.avgNext5dReturn > 0.01) {
    parts.push(`After large drops, avg 5-day recovery: +${(afterBigDown.avgNext5dReturn * 100).toFixed(1)}%.`);
  }
  if (afterBigUp.sampleSize > 5 && afterBigUp.avgNext5dReturn > 0.01) {
    parts.push(`Momentum after big ups: avg 5-day follow-through +${(afterBigUp.avgNext5dReturn * 100).toFixed(1)}%.`);
  }

  return {
    afterBigUp,
    afterBigDown,
    insight: parts.join(' ') || 'No strong mean-reversion or momentum pattern detected.',
  };
}

// ─── Volume Dynamics ──────────────────────────────────────────

function computeVolumeDynamics(
  dates: string[],
  byDate: Map<string, EquityBar>,
): VolumeDynamics {
  // Compute 20-day avg volume, then classify days
  const vols: { date: string; vol: number; ret: number }[] = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = byDate.get(dates[i - 1]);
    const curr = byDate.get(dates[i]);
    if (!prev || !curr || prev.c <= 0) continue;
    vols.push({
      date: dates[i],
      vol: curr.v,
      ret: (curr.c - prev.c) / prev.c,
    });
  }

  if (vols.length < 40) {
    return {
      highVolUpDayPct: 0.5, avgReturnHighVol: 0, avgReturnLowVol: 0,
      volSurgeFollowThrough: 0.5,
      insight: 'Insufficient data for volume analysis.',
    };
  }

  // Rolling 20-day avg volume
  const highVolDays: typeof vols = [];
  const lowVolDays: typeof vols = [];

  for (let i = 20; i < vols.length; i++) {
    const avgVol = vols.slice(i - 20, i).reduce((s, v) => s + v.vol, 0) / 20;
    if (vols[i].vol > avgVol * 1.5) {
      highVolDays.push(vols[i]);
    } else if (vols[i].vol < avgVol * 0.7) {
      lowVolDays.push(vols[i]);
    }
  }

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const highVolUpPct = highVolDays.length > 0
    ? highVolDays.filter(d => d.ret > 0).length / highVolDays.length : 0.5;
  const avgRetHigh = avg(highVolDays.map(d => d.ret));
  const avgRetLow = avg(lowVolDays.map(d => d.ret));

  // Volume surge follow-through: after a high-vol day, does the next day continue?
  let surgeFollowCount = 0;
  let surgeTotal = 0;
  for (let i = 0; i < highVolDays.length; i++) {
    const dateIdx = vols.findIndex(v => v.date === highVolDays[i].date);
    if (dateIdx >= 0 && dateIdx + 1 < vols.length) {
      surgeTotal++;
      const nextDayRet = vols[dateIdx + 1].ret;
      if ((highVolDays[i].ret > 0 && nextDayRet > 0) || (highVolDays[i].ret < 0 && nextDayRet < 0)) {
        surgeFollowCount++;
      }
    }
  }
  const followThrough = surgeTotal > 0 ? surgeFollowCount / surgeTotal : 0.5;

  const parts: string[] = [];
  if (highVolDays.length > 10) {
    if (highVolUpPct > 0.6) {
      parts.push(`High-volume days are bullish: ${(highVolUpPct * 100).toFixed(0)}% are up days.`);
    } else if (highVolUpPct < 0.4) {
      parts.push(`High-volume days are bearish: only ${(highVolUpPct * 100).toFixed(0)}% are up days.`);
    }
    if (followThrough > 0.6) {
      parts.push(`Volume surges show follow-through: ${(followThrough * 100).toFixed(0)}% continue in same direction next day.`);
    } else if (followThrough < 0.4) {
      parts.push(`Volume surges tend to reverse: only ${(followThrough * 100).toFixed(0)}% follow-through rate.`);
    }
  }

  return {
    highVolUpDayPct: highVolUpPct,
    avgReturnHighVol: avgRetHigh,
    avgReturnLowVol: avgRetLow,
    volSurgeFollowThrough: followThrough,
    insight: parts.join(' ') || 'No unusual volume-price patterns detected.',
  };
}

// ─── Anomaly Detection ────────────────────────────────────────

function detectAnomalies(
  ivRegime: IVRegimePerformance,
  market: MarketRelative,
  sector: SectorRelative | null,
  vol: VolPricing,
  mr: MeanReversion,
  vd: VolumeDynamics,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // Negative beta or very low correlation
  if (market.beta < 0) {
    anomalies.push({
      description: `Negative beta (${market.beta.toFixed(2)}) — moves opposite to the market`,
      type: 'neutral', strength: 'strong',
    });
  }

  // Sector divergence
  if (sector && sector.divergenceDays > 20) {
    anomalies.push({
      description: `Diverged from ${sector.sectorName} on ${sector.divergenceDays}/60 recent days — trading independently`,
      type: 'neutral', strength: 'moderate',
    });
  }

  // Consistent vol overpricing
  if (vol.overPricingRate > 0.70) {
    anomalies.push({
      description: `Options consistently overpriced (${(vol.overPricingRate * 100).toFixed(0)}% of the time) — systematic edge for premium sellers`,
      type: 'neutral', strength: 'strong',
    });
  } else if (vol.overPricingRate < 0.40) {
    anomalies.push({
      description: `Options consistently underpriced (${((1 - vol.overPricingRate) * 100).toFixed(0)}% of the time) — stock moves more than options imply`,
      type: 'neutral', strength: 'strong',
    });
  }

  // Counter-intuitive IV regime performance
  if (ivRegime.highIV.sampleSize > 10 && ivRegime.lowIV.sampleSize > 10) {
    if (ivRegime.highIV.avgReturn20d > ivRegime.lowIV.avgReturn20d + 0.02) {
      anomalies.push({
        description: `Performs BETTER in high-vol regimes (+${(ivRegime.highIV.avgReturn20d * 100).toFixed(1)}% vs ${(ivRegime.lowIV.avgReturn20d * 100).toFixed(1)}% 20d avg) — contrarian signal`,
        type: 'bullish', strength: 'moderate',
      });
    }
  }

  // Strong mean reversion after drops
  if (mr.afterBigDown.sampleSize > 5 && mr.afterBigDown.reversalRate > 0.7) {
    anomalies.push({
      description: `Strong bounce-back tendency: reverses ${(mr.afterBigDown.reversalRate * 100).toFixed(0)}% of the time after big drops`,
      type: 'bullish', strength: 'moderate',
    });
  }

  // Momentum stock (no reversal)
  if (mr.afterBigUp.sampleSize > 5 && mr.afterBigUp.reversalRate < 0.35) {
    anomalies.push({
      description: `Momentum stock: continues higher ${((1 - mr.afterBigUp.reversalRate) * 100).toFixed(0)}% of the time after big up days`,
      type: 'bullish', strength: 'moderate',
    });
  }

  // Drawdown amplifier
  if (market.drawdownBehavior.count > 10 && market.drawdownBehavior.ratio > 1.8) {
    anomalies.push({
      description: `Falls ${market.drawdownBehavior.ratio.toFixed(1)}x more than SPY in drawdowns — high drawdown risk`,
      type: 'bearish', strength: 'strong',
    });
  }

  // Defensive stock
  if (market.drawdownBehavior.count > 10 && market.drawdownBehavior.ratio < 0.5) {
    anomalies.push({
      description: `Defensive: only falls ${market.drawdownBehavior.ratio.toFixed(1)}x vs SPY during drawdowns`,
      type: 'bullish', strength: 'moderate',
    });
  }

  // Significant positive alpha
  if (market.alpha90d > 0.08) {
    anomalies.push({
      description: `Generating ${(market.alpha90d * 100).toFixed(1)}% alpha over 90 days — strong outperformance`,
      type: 'bullish', strength: 'strong',
    });
  } else if (market.alpha90d < -0.08) {
    anomalies.push({
      description: `${(market.alpha90d * 100).toFixed(1)}% alpha over 90 days — significant underperformance`,
      type: 'bearish', strength: 'strong',
    });
  }

  return anomalies;
}

// ─── Rank Insights ────────────────────────────────────────────

function rankInsights(
  iv: IVRegimePerformance,
  market: MarketRelative,
  sector: SectorRelative | null,
  vol: VolPricing,
  mr: MeanReversion,
  vd: VolumeDynamics,
  anomalies: Anomaly[],
): CorrelationInsight[] {
  const insights: CorrelationInsight[] = [];

  // Beta & correlation
  insights.push({
    label: 'Market Beta',
    value: `${market.beta.toFixed(2)} (r=${market.correlation.toFixed(2)})`,
    direction: market.beta > 1.2 ? 'bearish' : market.beta < 0.8 ? 'bullish' : 'neutral',
    strength: Math.abs(market.beta - 1) * 50 + Math.abs(market.correlation) * 30,
  });

  // Alpha
  if (Math.abs(market.alpha30d) > 0.01) {
    insights.push({
      label: '30d Alpha',
      value: `${market.alpha30d > 0 ? '+' : ''}${(market.alpha30d * 100).toFixed(1)}%`,
      direction: market.alpha30d > 0 ? 'bullish' : 'bearish',
      strength: Math.min(100, Math.abs(market.alpha30d) * 500),
    });
  }

  // Vol pricing
  if (Math.abs(vol.overPricingRate - 0.5) > 0.1) {
    insights.push({
      label: 'Vol Pricing',
      value: vol.overPricingRate > 0.5
        ? `Overpriced ${(vol.overPricingRate * 100).toFixed(0)}%`
        : `Underpriced ${((1 - vol.overPricingRate) * 100).toFixed(0)}%`,
      direction: 'neutral',
      strength: Math.abs(vol.overPricingRate - 0.5) * 200,
    });
  }

  // IV regime edge
  if (iv.lowIV.sampleSize > 10 && iv.highIV.sampleSize > 10) {
    const diff = iv.lowIV.avgReturn20d - iv.highIV.avgReturn20d;
    if (Math.abs(diff) > 0.005) {
      insights.push({
        label: 'Low-Vol Edge',
        value: diff > 0
          ? `+${(diff * 100).toFixed(1)}% vs high-vol`
          : `${(diff * 100).toFixed(1)}% vs high-vol`,
        direction: diff > 0 ? 'bullish' : 'bearish',
        strength: Math.min(100, Math.abs(diff) * 1000),
      });
    }
  }

  // Drawdown behavior
  if (market.drawdownBehavior.count > 5) {
    const ratio = market.drawdownBehavior.ratio;
    insights.push({
      label: 'Drawdown Sensitivity',
      value: `${ratio.toFixed(1)}x SPY`,
      direction: ratio > 1.3 ? 'bearish' : ratio < 0.7 ? 'bullish' : 'neutral',
      strength: Math.min(100, Math.abs(ratio - 1) * 80),
    });
  }

  // Mean reversion
  if (mr.afterBigDown.sampleSize > 5) {
    insights.push({
      label: 'Bounce Rate',
      value: `${(mr.afterBigDown.reversalRate * 100).toFixed(0)}% after drops`,
      direction: mr.afterBigDown.reversalRate > 0.55 ? 'bullish' : 'bearish',
      strength: Math.abs(mr.afterBigDown.reversalRate - 0.5) * 150,
    });
  }

  // Sector relative
  if (sector && Math.abs(sector.relativeStrength30d) > 0.02) {
    insights.push({
      label: `vs ${sector.sectorETF}`,
      value: `${sector.relativeStrength30d > 0 ? '+' : ''}${(sector.relativeStrength30d * 100).toFixed(1)}% 30d`,
      direction: sector.relativeStrength30d > 0 ? 'bullish' : 'bearish',
      strength: Math.min(100, Math.abs(sector.relativeStrength30d) * 500),
    });
  }

  // Volume dynamics
  if (vd.highVolUpDayPct !== 0.5 && Math.abs(vd.highVolUpDayPct - 0.5) > 0.08) {
    insights.push({
      label: 'Vol Surge Bias',
      value: `${(vd.highVolUpDayPct * 100).toFixed(0)}% up`,
      direction: vd.highVolUpDayPct > 0.55 ? 'bullish' : 'bearish',
      strength: Math.abs(vd.highVolUpDayPct - 0.5) * 150,
    });
  }

  // Sort by strength descending
  insights.sort((a, b) => b.strength - a.strength);
  return insights.slice(0, 8);
}
