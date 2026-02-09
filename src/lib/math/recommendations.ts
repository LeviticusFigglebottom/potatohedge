/**
 * Trade Recommendation Engine v2
 *
 * ALL thresholds are now ticker-specific, normalized against:
 * - ATR (14-day Average True Range) — what's a "normal" move for THIS stock
 * - Daily σ (from HV20) — statistical move significance
 * - Average daily range — empirical price action context
 *
 * A 4.4% move on DUOL (50% HV, 3% ATR) ≈ 1.4σ — notable, not extreme
 * A 1.9% move on SPY (13% HV, 0.8% ATR) ≈ 2.3σ — statistically more extreme
 */

export type Direction = 'bullish' | 'bearish' | 'neutral';
export type VolRegime = 'high' | 'mid' | 'low';
export type GammaRegime = 'long' | 'short' | 'neutral';
export type Confidence = 'high' | 'medium' | 'low';

export interface Signal {
  name: string;
  direction: Direction;
  weight: number;
  description: string;
}

export interface TradeIdea {
  strategy: string;
  direction: Direction;
  confidence: Confidence;
  score: number;
  expiration: string;
  strikes: string;
  entry: string;
  risk: string;
  reasoning: string[];
  tags: string[];
}

export interface RecommendationOutput {
  symbol: string;
  spotPrice: number;
  overallBias: Direction;
  biasScore: number;
  volRegime: VolRegime;
  gammaRegime: GammaRegime;
  signals: Signal[];
  trades: TradeIdea[];
  warnings: string[];
  moveContext: string;
  stockContext: string;
  timestamp: number;
}

export interface RecommendationInput {
  symbol: string;
  spotPrice: number;
  // GEX/Dealer
  totalGEX: number;
  totalDEX: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number;
  // Volume/PCR
  volumePCR: number;
  oiPCR: number;
  totalCallVol: number;
  totalPutVol: number;
  totalCallOI: number;
  totalPutOI: number;
  // IV
  ivRank: number;
  ivPercentile: number;
  currentIV: number;
  hvCurrent: number;
  ivHvRatio: number;
  // Skew
  skewBias: string;
  skewRatio: number;
  // Price action — ATR-relative
  changePercent: number;
  atr14: number;           // 14-day ATR in dollars
  atrPercent: number;      // ATR as % of price
  dailySigma: number;      // 1σ daily move in %
  avgDailyRangePct: number; // avg |H-L|/C in %
  // Expirations
  nearestExp: string;
  nearestDTE: number;
  weeklyExp?: string;
  monthlyExp?: string;
  // Optional correlation context (available when correlation data is loaded)
  correlationCtx?: {
    meanReversionBounceRate: number;   // 0-1, bounce rate after 2σ+ drops
    meanReversionPullbackRate: number; // 0-1, pullback rate after 2σ+ rallies
    avgRecovery5d: number;             // avg 5d return after big drops
    lowVolWinRate: number;             // win rate in low-vol regime
    highVolAvg20d: number;             // avg 20d return in high-vol regime
    lowVolAvg20d: number;              // avg 20d return in low-vol regime
    volOverpricingRate: number;        // 0-1, how often IV > realized
    drawdownRatio: number;             // vs SPY during drawdowns
    alpha30d: number;                  // 30d alpha vs SPY
  };
  // Optional: DTCC swap maturity data
  swapMaturitiesToday?: number;
  swapNotionalToday?: number;
  swapMaturitiesWeek?: number;
  swapNotionalWeek?: number;
  // Optional: FINRA short interest + Reg SHO
  shortInterest?: number;         // total shares short
  daysToCover?: number;           // SI / avg daily volume
  regSHOThreshold?: boolean;      // on Reg SHO threshold list (persistent FTDs)
}

// ─── Helpers ──────────────────────────────────────────────

/** Clamp value to [min, max] */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Piecewise linear interpolation.
 * Given sorted breakpoints xs and corresponding weights ys,
 * returns the interpolated weight for value x.
 * Clamps to first/last ys if x is outside the range.
 */
function plerp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}

// ─── Signal Scoring ────────────────────────────────────────

function scoreSignals(input: RecommendationInput): Signal[] {
  const signals: Signal[] = [];
  const { spotPrice, dailySigma, atrPercent } = input;

  // 1. GEX Regime
  if (input.totalGEX > 0) {
    signals.push({
      name: 'GEX Regime',
      direction: 'neutral',
      weight: 0.1,
      description: `Dealers long gamma ($${abbr(input.totalGEX)}) — expect mean-reversion, sell volatility`,
    });
  } else if (input.totalGEX < 0) {
    signals.push({
      name: 'GEX Regime',
      direction: 'neutral',
      weight: 0,
      description: `Dealers short gamma ($${abbr(input.totalGEX)}) — amplified moves, trend-following favored`,
    });
  }

  // 2. Gamma Flip Position — distance measured in ATR multiples
  //    Fade signal to zero when flip is >30% from price (stale/irrelevant)
  if (input.gammaFlip !== null) {
    const distPct = (spotPrice - input.gammaFlip) / spotPrice * 100;
    const absDistPct = Math.abs(distPct);
    const distATR = atrPercent > 0 ? absDistPct / atrPercent : 0;

    if (absDistPct > 30) {
      // Too far away — gamma flip is stale/irrelevant, skip entirely
    } else {
      // Fade weight linearly from full at <10% to zero at 30%
      const distanceFade = absDistPct > 10 ? Math.max(0, 1 - (absDistPct - 10) / 20) : 1;
      // Weight peaks at ~3 ATR then fades, capped at 0.3
      const rawWeight = Math.min(0.3, Math.min(distATR, 3) * 0.1);

      if (distPct > 0.3) {
        signals.push({
          name: 'Gamma Flip',
          direction: 'bullish',
          weight: rawWeight * distanceFade,
          description: `Spot ${distPct.toFixed(1)}% above γ flip ($${input.gammaFlip.toFixed(0)}) — ${distATR.toFixed(1)} ATR into positive gamma, dips get bought`,
        });
      } else if (distPct < -0.3) {
        signals.push({
          name: 'Gamma Flip',
          direction: 'bearish',
          weight: -(rawWeight * distanceFade),
          description: `Spot ${Math.abs(distPct).toFixed(1)}% below γ flip ($${input.gammaFlip.toFixed(0)}) — ${distATR.toFixed(1)} ATR into negative gamma, sells accelerate`,
        });
      } else {
        signals.push({
          name: 'Gamma Flip',
          direction: 'neutral',
          weight: 0,
          description: `Spot at γ flip ($${input.gammaFlip.toFixed(0)}) — regime transition, high uncertainty`,
        });
      }
    }
  }

  // 3. Call/Put Wall Proximity — measured in ATR
  //    Skip walls >20% from price — just far-OTM OI clusters, not real levels
  //    OI confidence: walls only meaningful when total OI is significant
  const totalOI = input.totalCallOI + input.totalPutOI;
  const wallOIConfidence = totalOI < 5000 ? 0 : totalOI < 20000 ? (totalOI - 5000) / 15000 : 1;

  if (input.callWall !== null) {
    const distPct = (input.callWall - spotPrice) / spotPrice * 100;
    const absDistPct = Math.abs(distPct);
    const distATR = atrPercent > 0 ? distPct / atrPercent : 99;
    if (absDistPct <= 20 && wallOIConfidence > 0) {
      const thinNote = wallOIConfidence < 1 ? ' (thin OI — low confidence)' : '';
      if (distPct > 0 && distATR < 1.5) {
        signals.push({
          name: 'Call Wall Proximity',
          direction: 'bearish',
          weight: -0.2 * wallOIConfidence,
          description: `Call Wall at $${input.callWall} is ${distATR.toFixed(1)} ATR overhead (${distPct.toFixed(1)}%)${thinNote} — strong resistance within ~${Math.ceil(distATR)} day range`,
        });
      } else if (distPct < 0) {
        signals.push({
          name: 'Call Wall Breach',
          direction: 'bullish',
          weight: 0.3 * wallOIConfidence,
          description: `Above Call Wall ($${input.callWall})${thinNote} — dealers chasing, squeeze potential`,
        });
      }
    }
  }

  if (input.putWall !== null) {
    const distPct = (spotPrice - input.putWall) / spotPrice * 100;
    const absDistPct = Math.abs(distPct);
    const distATR = atrPercent > 0 ? distPct / atrPercent : 99;
    if (absDistPct <= 20 && wallOIConfidence > 0) {
      const thinNote = wallOIConfidence < 1 ? ' (thin OI — low confidence)' : '';
      if (distPct > 0 && distATR < 1.5) {
        signals.push({
          name: 'Put Wall Proximity',
          direction: 'bullish',
          weight: 0.2 * wallOIConfidence,
          description: `Put Wall at $${input.putWall} is ${distATR.toFixed(1)} ATR below (${distPct.toFixed(1)}%)${thinNote} — strong support within ~${Math.ceil(distATR)} day range`,
        });
      } else if (distPct < 0) {
        signals.push({
          name: 'Put Wall Breach',
          direction: 'bearish',
          weight: -0.3 * wallOIConfidence,
          description: `Below Put Wall ($${input.putWall})${thinNote} — support broken, downside accelerates`,
        });
      }
    }
  }

  // 4. Max Pain — measured in ATR
  const mpDistPct = (input.maxPain - spotPrice) / spotPrice * 100;
  const mpATR = atrPercent > 0 ? Math.abs(mpDistPct) / atrPercent : 0;
  if (mpATR > 0.5) {
    signals.push({
      name: 'Max Pain Magnet',
      direction: mpDistPct > 0 ? 'bullish' : 'bearish',
      weight: Math.max(-0.15, Math.min(0.15, (mpDistPct / atrPercent) * 0.05)),
      description: `Max pain at $${input.maxPain} — ${mpATR.toFixed(1)} ATR away (${mpDistPct > 0 ? '+' : ''}${mpDistPct.toFixed(1)}%), gravitational pull into expiration`,
    });
  }

  // 5. PCR Signal (ratio-based, already ticker-neutral)
  //    Zero-weight when either side has <50 contracts (PCR is meaningless)
  //    Attenuate when total volume is thin (<2k contracts)
  //    Cap effective PCR to [0.05, 20] — values outside are data artifacts
  const totalOptVol = input.totalCallVol + input.totalPutVol;
  const minSideVol = Math.min(input.totalCallVol, input.totalPutVol);
  const pcrReliable = minSideVol >= 50 && totalOptVol >= 500;
  const pcrConfidence = !pcrReliable ? 0 : totalOptVol < 2000 ? (totalOptVol - 500) / 1500 : 1;
  const effectivePCR = Math.max(0.05, Math.min(20, input.volumePCR));

  // Continuous PCR weight: smoothly interpolates across the full range
  // PCR 0.3→+0.25, 0.6→+0.10, 0.8→+0.03, 0.95→0, 1.05→0, 1.2→-0.08, 1.5→-0.20, 2.5→-0.30
  const pcrWeight = plerp(effectivePCR,
    [0.3, 0.6, 0.8, 0.95, 1.05, 1.2, 1.5, 2.5],
    [0.25, 0.10, 0.03, 0.0, 0.0, -0.08, -0.20, -0.30]
  ) * pcrConfidence;
  if (Math.abs(pcrWeight) > 0.01) {
    const reliabilityNote = !pcrReliable
      ? ` (UNRELIABLE: ${minSideVol < 50 ? `only ${minSideVol} contracts on ${input.totalCallVol < input.totalPutVol ? 'call' : 'put'} side` : `low volume: ${totalOptVol}`})`
      : pcrConfidence < 1 ? ` (low volume: ${totalOptVol} contracts)` : '';
    const pcrLabel = input.volumePCR > 20 ? '>20' : input.volumePCR < 0.05 ? '<0.05' : input.volumePCR.toFixed(2);
    signals.push({
      name: 'Volume P/C Ratio',
      direction: pcrWeight > 0 ? 'bullish' : 'bearish',
      weight: pcrWeight,
      description: `PCR ${pcrLabel}${reliabilityNote} — ${effectivePCR < 0.7 ? 'call-dominant, bullish flow' : effectivePCR > 1.5 ? 'heavy put buying, bearish/hedging' : effectivePCR > 1.0 ? 'slightly put-heavy' : 'slightly call-heavy'}`,
    });
  }

  // 6. DEX Bias — scale weight by magnitude relative to GEX
  // If DEX is small relative to GEX, it matters less
  {
    const dexMag = Math.abs(input.totalDEX);
    const gexMag = Math.abs(input.totalGEX) || 1;
    const dexScale = clamp(dexMag / gexMag, 0.2, 2) / 2; // 0.1 to 1.0 multiplier
    if (input.totalDEX < 0) {
      signals.push({
        name: 'Dealer Delta',
        direction: 'bullish',
        weight: 0.10 * dexScale,
        description: `Dealers short delta ($${abbr(input.totalDEX)}) — must buy underlying to hedge, supportive flow`,
      });
    } else if (input.totalDEX > 0) {
      signals.push({
        name: 'Dealer Delta',
        direction: 'bearish',
        weight: -0.05 * dexScale,
        description: `Dealers long delta ($${abbr(input.totalDEX)}) — may sell into rallies`,
      });
    }
  }

  // 7. IV Regime
  if (input.ivRank > 70) {
    signals.push({
      name: 'IV Rank',
      direction: 'neutral',
      weight: 0,
      description: `IV Rank ${input.ivRank} — elevated implied vol (${(input.currentIV * 100).toFixed(0)}% vs ${(input.hvCurrent * 100).toFixed(0)}% realized), favor selling premium`,
    });
  } else if (input.ivRank < 25) {
    signals.push({
      name: 'IV Rank',
      direction: 'neutral',
      weight: 0,
      description: `IV Rank ${input.ivRank} — low implied vol (${(input.currentIV * 100).toFixed(0)}% IV), options are cheap, favor buying`,
    });
  } else {
    signals.push({
      name: 'IV Rank',
      direction: 'neutral',
      weight: 0,
      description: `IV Rank ${input.ivRank} — mid-range (${(input.currentIV * 100).toFixed(0)}% IV vs ${(input.hvCurrent * 100).toFixed(0)}% HV)`,
    });
  }

  // 8. IV/HV Divergence — key for premium pricing
  if (input.ivHvRatio > 1.3) {
    signals.push({
      name: 'IV/HV Spread',
      direction: 'neutral',
      weight: 0,
      description: `IV/HV ${input.ivHvRatio.toFixed(2)} — implied ${((input.ivHvRatio - 1) * 100).toFixed(0)}% above realized. Options overpriced vs actual movement — edge in selling`,
    });
  } else if (input.ivHvRatio > 0 && input.ivHvRatio < 0.85) {
    signals.push({
      name: 'IV/HV Spread',
      direction: 'neutral',
      weight: 0,
      description: `IV/HV ${input.ivHvRatio.toFixed(2)} — implied ${((1 - input.ivHvRatio) * 100).toFixed(0)}% below realized. Options underpriced — edge in buying`,
    });
  }

  // 9. Skew
  if (input.skewBias === 'put-heavy') {
    signals.push({
      name: 'Skew',
      direction: 'bearish',
      weight: -0.1,
      description: `Put skew elevated (${input.skewRatio.toFixed(2)}x) — market pricing downside risk`,
    });
  } else if (input.skewBias === 'call-heavy') {
    signals.push({
      name: 'Skew',
      direction: 'bullish',
      weight: 0.1,
      description: `Call skew elevated — unusual upside demand`,
    });
  }

  // 10. Correlation-based signals (when available)
  if (input.correlationCtx) {
    const ctx = input.correlationCtx;
    const absChange = Math.abs(input.changePercent);
    const sigma = dailySigma > 0 ? absChange / dailySigma : 0;

    // Mean reversion after big drops: if stock dropped >2σ today and has strong bounce tendency
    if (input.changePercent < 0 && sigma > 2 && ctx.meanReversionBounceRate > 0.6) {
      const strength = Math.min(0.2, (ctx.meanReversionBounceRate - 0.5) * 0.6);
      signals.push({
        name: 'Mean Reversion (Hist)',
        direction: 'bullish',
        weight: strength,
        description: `After 2σ+ drops, this stock bounces ${(ctx.meanReversionBounceRate * 100).toFixed(0)}% of the time (avg 5d recovery: ${ctx.avgRecovery5d > 0 ? '+' : ''}${(ctx.avgRecovery5d * 100).toFixed(1)}%)`,
      });
    }

    // Momentum continuation after big ups
    if (input.changePercent > 0 && sigma > 2 && ctx.meanReversionPullbackRate < 0.4) {
      const strength = Math.min(0.15, (0.5 - ctx.meanReversionPullbackRate) * 0.4);
      signals.push({
        name: 'Momentum (Hist)',
        direction: 'bullish',
        weight: strength,
        description: `Momentum stock — continues higher ${((1 - ctx.meanReversionPullbackRate) * 100).toFixed(0)}% after big up days`,
      });
    } else if (input.changePercent > 0 && sigma > 2 && ctx.meanReversionPullbackRate > 0.6) {
      const strength = Math.min(0.15, (ctx.meanReversionPullbackRate - 0.5) * 0.4);
      signals.push({
        name: 'Mean Reversion (Hist)',
        direction: 'bearish',
        weight: -strength,
        description: `Tends to pull back ${(ctx.meanReversionPullbackRate * 100).toFixed(0)}% of the time after big rallies`,
      });
    }

    // IV regime edge: if current vol is low and low-vol periods historically favor going up
    if (input.ivRank < 30 && ctx.lowVolWinRate > 0.58 && ctx.lowVolAvg20d > 0.005) {
      signals.push({
        name: 'Low-Vol Edge (Hist)',
        direction: 'bullish',
        weight: Math.min(0.12, (ctx.lowVolWinRate - 0.5) * 0.5),
        description: `Low-vol regimes historically bullish: ${(ctx.lowVolWinRate * 100).toFixed(0)}% win rate, +${(ctx.lowVolAvg20d * 100).toFixed(1)}% avg 20d return`,
      });
    } else if (input.ivRank > 70 && ctx.highVolAvg20d < -0.01) {
      signals.push({
        name: 'High-Vol Drag (Hist)',
        direction: 'bearish',
        weight: Math.max(-0.1, ctx.highVolAvg20d * 5),
        description: `High-vol regimes historically weak: ${(ctx.highVolAvg20d * 100).toFixed(1)}% avg 20d return`,
      });
    }

    // Recent alpha momentum
    if (ctx.alpha30d > 0.04) {
      signals.push({
        name: 'Alpha Momentum',
        direction: 'bullish',
        weight: Math.min(0.1, ctx.alpha30d),
        description: `+${(ctx.alpha30d * 100).toFixed(1)}% alpha vs SPY over 30 days — outperformance momentum`,
      });
    } else if (ctx.alpha30d < -0.04) {
      signals.push({
        name: 'Alpha Drag',
        direction: 'bearish',
        weight: Math.max(-0.1, ctx.alpha30d),
        description: `${(ctx.alpha30d * 100).toFixed(1)}% alpha vs SPY over 30 days — underperforming`,
      });
    }
  }

  // 11. Momentum — ATR-RELATIVE with continuous weight scaling
  // Weight ramps smoothly from 0 at 0.8σ to ±0.20 at 3σ+
  const absChange = Math.abs(input.changePercent);
  const moveSigma = dailySigma > 0 ? absChange / dailySigma : 0;
  const moveATR = atrPercent > 0 ? absChange / atrPercent : 0;

  if (moveSigma > 0.8) {
    // Continuous: 0.8σ→0, 1.2σ→0.04, 2σ→0.10, 3σ→0.16, 4σ→0.20
    const momMag = clamp(plerp(moveSigma, [0.8, 1.2, 2.0, 3.0, 4.0], [0.0, 0.04, 0.10, 0.16, 0.20]), 0, 0.20);
    const dir = input.changePercent > 0 ? 'bullish' : 'bearish';
    const sign = input.changePercent > 0 ? 1 : -1;
    signals.push({
      name: 'Momentum',
      direction: momMag > 0.01 ? dir : 'neutral',
      weight: momMag * sign,
      description: moveSigma > 2
        ? `Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% = ${moveSigma.toFixed(1)}σ move (${moveATR.toFixed(1)}x ATR) — statistically significant for this stock`
        : moveSigma > 1.2
        ? `Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% = ${moveSigma.toFixed(1)}σ (${moveATR.toFixed(1)}x ATR) — above average for this stock's ${atrPercent.toFixed(1)}% daily ATR`
        : `Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% = ${moveSigma.toFixed(1)}σ — within normal range (${atrPercent.toFixed(1)}% ATR)`,
    });
  } else if (absChange > 0.1) {
    signals.push({
      name: 'Momentum',
      direction: 'neutral',
      weight: 0,
      description: `Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% = ${moveSigma.toFixed(1)}σ — within normal range for this stock (${atrPercent.toFixed(1)}% ATR, ${avgDailyRangePctStr(input.avgDailyRangePct)} avg daily range)`,
    });
  }

  // 12. DTCC Swap Maturity Pressure
  if (input.swapMaturitiesToday && input.swapMaturitiesToday > 0) {
    const notionalM = (input.swapNotionalToday || 0) / 1e6;
    const isHeavy = input.swapMaturitiesToday > 100 || notionalM > 50;
    const weight = isHeavy ? -0.10 : -0.05; // headwind — dealer rebalancing creates friction
    signals.push({
      name: 'Swap Maturity',
      direction: isHeavy ? 'bearish' : 'neutral',
      weight: isHeavy ? weight : 0,
      description: `${input.swapMaturitiesToday} swap${input.swapMaturitiesToday > 1 ? 's' : ''} ($${notionalM.toFixed(0)}M notional) maturing today — ${isHeavy ? 'heavy dealer rebalancing pressure' : 'minor dealer flow'}`,
    });
  }
  if (input.swapMaturitiesWeek && input.swapMaturitiesWeek > (input.swapMaturitiesToday || 0)) {
    const weekNotionalM = (input.swapNotionalWeek || 0) / 1e6;
    if (input.swapMaturitiesWeek > 200 || weekNotionalM > 100) {
      signals.push({
        name: 'Swap Maturity (Week)',
        direction: 'bearish',
        weight: -0.05,
        description: `${input.swapMaturitiesWeek} swaps ($${weekNotionalM.toFixed(0)}M) maturing this week — persistent rebalancing headwind`,
      });
    }
  }

  // 13. Reg SHO Threshold (persistent FTDs)
  if (input.regSHOThreshold) {
    signals.push({
      name: 'Reg SHO Threshold',
      direction: 'neutral',
      weight: 0,
      description: 'On Reg SHO threshold list — persistent failures-to-deliver, potential forced buy-in / squeeze catalyst',
    });
  }

  // 14. Short Interest / Days to Cover
  if (input.daysToCover !== undefined && input.daysToCover > 0) {
    if (input.daysToCover > 5) {
      signals.push({
        name: 'High Short Interest',
        direction: 'neutral', // could squeeze either way
        weight: 0,
        description: `${input.daysToCover.toFixed(1)} days to cover — crowded short, squeeze risk on positive catalysts`,
      });
    } else if (input.daysToCover > 2) {
      signals.push({
        name: 'Elevated Short Interest',
        direction: 'neutral',
        weight: 0,
        description: `${input.daysToCover.toFixed(1)} days to cover — moderate short positioning`,
      });
    }
  }

  return signals;
}

// ─── Strategy Generation ───────────────────────────────────

function generateTrades(
  input: RecommendationInput,
  signals: Signal[],
  bias: Direction,
  biasScore: number,
  volRegime: VolRegime,
  gammaRegime: GammaRegime
): TradeIdea[] {
  const trades: TradeIdea[] = [];
  const { spotPrice, callWall, putWall, gammaFlip, maxPain, atr14, atrPercent } = input;

  // ATR-based spread width (use ~1-2 ATR for spread width)
  const spreadWidth = Math.max(1, Math.round(atr14));
  const strikeStep = spotPrice > 200 ? 5 : spotPrice > 50 ? 2.5 : 1;

  const shortDTE = input.nearestDTE <= 5 ? `${input.nearestDTE}d (${input.nearestExp})` : `3-7 DTE`;
  const medDTE = '14-21 DTE';
  const longDTE = '30-45 DTE';

  // ─── HIGH IV: Sell Premium ───
  if (volRegime === 'high') {
    if (bias === 'bullish' || bias === 'neutral') {
      const sellStrike = putWall ? Math.round(putWall / strikeStep) * strikeStep : Math.round((spotPrice - atr14 * 1.5) / strikeStep) * strikeStep;
      const buyStrike = Math.round((sellStrike - spreadWidth) / strikeStep) * strikeStep;
      trades.push({
        strategy: 'Bull Put Spread (Credit)',
        direction: 'bullish',
        confidence: bias === 'bullish' ? 'high' : 'medium',
        score: bias === 'bullish' ? 80 : 65,
        expiration: longDTE,
        strikes: `Sell $${sellStrike} put, buy $${buyStrike} put — ${putWall ? `anchored to put wall support` : `~1.5 ATR below spot`}`,
        entry: 'Enter on up days when IV is still elevated. Target ~1/3 width of spread in credit.',
        risk: `Max loss $${(sellStrike - buyStrike).toFixed(0)} per share minus credit. Close at 50% profit or if short strike breached.`,
        reasoning: [
          `IV Rank ${input.ivRank} — options overpriced (IV ${(input.currentIV * 100).toFixed(0)}% vs HV ${(input.hvCurrent * 100).toFixed(0)}%), edge in selling`,
          bias === 'bullish' ? 'Directional signals lean bullish' : 'Neutral bias allows defined-risk credit',
          gammaRegime === 'long' ? 'Long gamma regime — mean-reversion supports short puts' : '',
          putWall ? `Put Wall at $${putWall.toFixed(0)} provides dealer-driven support` : '',
        ].filter(Boolean),
        tags: ['premium-selling', 'defined-risk', 'theta-positive'],
      });
    }

    if (bias === 'bearish' || bias === 'neutral') {
      const sellStrike = callWall ? Math.round(callWall / strikeStep) * strikeStep : Math.round((spotPrice + atr14 * 1.5) / strikeStep) * strikeStep;
      const buyStrike = Math.round((sellStrike + spreadWidth) / strikeStep) * strikeStep;
      trades.push({
        strategy: 'Bear Call Spread (Credit)',
        direction: 'bearish',
        confidence: bias === 'bearish' ? 'high' : 'medium',
        score: bias === 'bearish' ? 80 : 65,
        expiration: longDTE,
        strikes: `Sell $${sellStrike} call, buy $${buyStrike} call — ${callWall ? `anchored to call wall resistance` : `~1.5 ATR above spot`}`,
        entry: 'Enter on down days when IV pops. Target ~1/3 width in credit.',
        risk: `Max loss $${(buyStrike - sellStrike).toFixed(0)} per share minus credit. Close at 50% profit.`,
        reasoning: [
          `IV Rank ${input.ivRank} — rich premium to sell`,
          bias === 'bearish' ? 'Directional signals lean bearish' : 'Neutral allows credit collection',
          callWall ? `Call Wall at $${callWall.toFixed(0)} caps upside via dealer hedging` : '',
        ].filter(Boolean),
        tags: ['premium-selling', 'defined-risk', 'theta-positive'],
      });
    }

    if (bias === 'neutral' && gammaRegime === 'long') {
      const sellCall = callWall ? Math.round(callWall / strikeStep) * strikeStep : Math.round((spotPrice + atr14 * 2) / strikeStep) * strikeStep;
      const sellPut = putWall ? Math.round(putWall / strikeStep) * strikeStep : Math.round((spotPrice - atr14 * 2) / strikeStep) * strikeStep;
      trades.push({
        strategy: 'Iron Condor',
        direction: 'neutral',
        confidence: 'high',
        score: 85,
        expiration: longDTE,
        strikes: `Sell $${sellCall}C / $${sellPut}P. Wings ~$${spreadWidth} beyond. Range: $${sellPut} - $${sellCall} (${((sellCall - sellPut) / atr14).toFixed(1)} ATR wide).`,
        entry: 'Enter when IV is above 30d MA. Collect both sides of credit.',
        risk: `Max loss on either wing. Close at 50% profit. Roll tested side at 2x credit.`,
        reasoning: [
          `IV Rank ${input.ivRank} — premium-rich environment (IV/HV ${input.ivHvRatio.toFixed(2)})`,
          'Long gamma regime — dealers suppress breakouts, pinning action',
          callWall && putWall ? `GEX walls ($${putWall.toFixed(0)} - $${callWall.toFixed(0)}) define the expected range` : '',
          `Max Pain at $${maxPain} — gravitational pull strengthens into expiration`,
        ].filter(Boolean),
        tags: ['premium-selling', 'range-bound', 'theta-positive', 'highest-conviction'],
      });
    }
  }

  // ─── LOW IV: Buy Premium ───
  if (volRegime === 'low') {
    if (bias === 'bullish') {
      const buyStrike = Math.round(spotPrice / strikeStep) * strikeStep;
      const targetStrike = callWall ? Math.round(callWall / strikeStep) * strikeStep : Math.round((spotPrice + atr14 * 2) / strikeStep) * strikeStep;
      trades.push({
        strategy: 'Bull Call Debit Spread',
        direction: 'bullish',
        confidence: Math.abs(biasScore) > 30 ? 'high' : 'medium',
        score: Math.abs(biasScore) > 30 ? 75 : 60,
        expiration: medDTE,
        strikes: `Buy $${buyStrike} call, sell $${targetStrike} call — ${callWall ? `targeting call wall` : `~2 ATR target`}. Spread width: $${(targetStrike - buyStrike).toFixed(0)}`,
        entry: 'Enter on pullbacks to support. IV is cheap — time decay less punishing.',
        risk: 'Max risk = debit paid. Take profit at 50-100% of debit.',
        reasoning: [
          `IV Rank ${input.ivRank} — options cheap (${(input.currentIV * 100).toFixed(0)}% IV, 52w low ${(input.hvCurrent * 100).toFixed(0)}%), good entry`,
          'Bullish directional signals support upside targeting',
          callWall ? `Call Wall at $${callWall.toFixed(0)} = realistic ${((callWall - spotPrice) / atr14).toFixed(1)} ATR price target` : '',
          gammaRegime === 'short' ? 'Short gamma — dealer hedging amplifies moves in your favor' : '',
        ].filter(Boolean),
        tags: ['premium-buying', 'defined-risk', 'directional'],
      });
    }

    if (bias === 'bearish') {
      const buyStrike = Math.round(spotPrice / strikeStep) * strikeStep;
      const targetStrike = putWall ? Math.round(putWall / strikeStep) * strikeStep : Math.round((spotPrice - atr14 * 2) / strikeStep) * strikeStep;
      trades.push({
        strategy: 'Bear Put Debit Spread',
        direction: 'bearish',
        confidence: Math.abs(biasScore) > 30 ? 'high' : 'medium',
        score: Math.abs(biasScore) > 30 ? 75 : 60,
        expiration: medDTE,
        strikes: `Buy $${buyStrike} put, sell $${targetStrike} put — ${putWall ? `targeting put wall` : `~2 ATR target`}. Spread width: $${(buyStrike - targetStrike).toFixed(0)}`,
        entry: 'Enter on failed rallies or rejection at resistance.',
        risk: 'Max risk = debit paid. Take profit at 50-100%.',
        reasoning: [
          `IV Rank ${input.ivRank} — cheap options, favorable for buying`,
          'Bearish signals support downside targeting',
          putWall ? `Put Wall at $${putWall.toFixed(0)} as ${((spotPrice - putWall) / atr14).toFixed(1)} ATR downside target` : '',
          gammaRegime === 'short' ? 'Short gamma amplifies the move' : '',
        ].filter(Boolean),
        tags: ['premium-buying', 'defined-risk', 'directional'],
      });
    }

    if (gammaRegime === 'short') {
      const straddleStrike = Math.round(spotPrice / strikeStep) * strikeStep;
      const movePctNeeded = input.currentIV > 0 ? (input.currentIV / Math.sqrt(252)) * 100 : atrPercent;
      trades.push({
        strategy: 'Long Straddle / Strangle',
        direction: 'neutral',
        confidence: input.ivHvRatio < 0.85 ? 'high' : 'medium',
        score: input.ivHvRatio < 0.85 ? 80 : 60,
        expiration: medDTE,
        strikes: `ATM straddle at $${straddleStrike} or strangle $${Math.round((spotPrice - atr14) / strikeStep) * strikeStep}P / $${Math.round((spotPrice + atr14) / strikeStep) * strikeStep}C (1 ATR wings)`,
        entry: `Enter when IV is near 52w lows. Need ~${movePctNeeded.toFixed(1)}% move to break even (~${(movePctNeeded / atrPercent).toFixed(1)} ATR).`,
        risk: 'Max risk = premium paid. Close if IV compresses further. Manage at 21 DTE.',
        reasoning: [
          `IV Rank ${input.ivRank} — vol is cheap, straddles underpriced`,
          input.ivHvRatio < 0.85 ? `IV/HV ${input.ivHvRatio.toFixed(2)} — implied ${((1 - input.ivHvRatio) * 100).toFixed(0)}% below realized, edge in buying vol` : '',
          'Short gamma regime — dealer hedging amplifies moves in either direction',
          `Stock averages ${atrPercent.toFixed(1)}% daily moves (${input.avgDailyRangePct.toFixed(1)}% avg range) — sufficient movement potential`,
        ].filter(Boolean),
        tags: ['premium-buying', 'volatility-long', 'non-directional'],
      });
    }
  }

  // ─── MID IV: Context-Dependent ───
  if (volRegime === 'mid') {
    if (bias === 'bullish' && Math.abs(biasScore) > 20) {
      const targetStrike = callWall ? Math.round(callWall / strikeStep) * strikeStep : Math.round((spotPrice + atr14 * 1.5) / strikeStep) * strikeStep;
      trades.push({
        strategy: 'Call Debit Spread',
        direction: 'bullish',
        confidence: Math.abs(biasScore) > 40 ? 'high' : 'medium',
        score: Math.min(75, 50 + Math.abs(biasScore)),
        expiration: medDTE,
        strikes: `Buy slightly ITM call, sell $${targetStrike} — ${callWall ? `call wall target` : '1.5 ATR target'}`,
        entry: `Enter on pullbacks. Risk 1-2% of account. Stock's daily range is ~${atrPercent.toFixed(1)}%.`,
        risk: 'Max risk = debit. Target 50-100% return on debit.',
        reasoning: [
          `Mid-range IV (Rank ${input.ivRank}) — spreads offer best risk/reward`,
          `Bullish bias score: +${biasScore.toFixed(0)}`,
          ...signals.filter(s => s.direction === 'bullish').map(s => s.description).slice(0, 2),
        ],
        tags: ['defined-risk', 'directional'],
      });
    }

    if (bias === 'bearish' && Math.abs(biasScore) > 20) {
      const targetStrike = putWall ? Math.round(putWall / strikeStep) * strikeStep : Math.round((spotPrice - atr14 * 1.5) / strikeStep) * strikeStep;
      trades.push({
        strategy: 'Put Debit Spread',
        direction: 'bearish',
        confidence: Math.abs(biasScore) > 40 ? 'high' : 'medium',
        score: Math.min(75, 50 + Math.abs(biasScore)),
        expiration: medDTE,
        strikes: `Buy slightly ITM put, sell $${targetStrike} — ${putWall ? `put wall target` : '1.5 ATR target'}`,
        entry: 'Enter on failed rallies or breakdown below support.',
        risk: 'Max risk = debit. Target 50-100% return.',
        reasoning: [
          `Mid-range IV (Rank ${input.ivRank}) — spreads optimal`,
          `Bearish bias score: ${biasScore.toFixed(0)}`,
          ...signals.filter(s => s.direction === 'bearish').map(s => s.description).slice(0, 2),
        ],
        tags: ['defined-risk', 'directional'],
      });
    }
  }

  // ─── Gamma Flip Play — only when within 1 ATR ───
  if (gammaFlip !== null) {
    const flipDistPct = Math.abs(spotPrice - gammaFlip) / spotPrice * 100;
    const flipDistATR = atrPercent > 0 ? flipDistPct / atrPercent : 99;
    if (flipDistATR < 0.5) { // within half an ATR of gamma flip
      trades.push({
        strategy: 'Gamma Flip Straddle',
        direction: 'neutral',
        confidence: 'medium',
        score: 65,
        expiration: shortDTE,
        strikes: `ATM straddle at $${Math.round(spotPrice / strikeStep) * strikeStep} — ${flipDistATR.toFixed(2)} ATR from gamma flip`,
        entry: `Enter when spot is within 0.5 ATR ($${(atr14 * 0.5).toFixed(1)}) of gamma flip. Expect explosive move.`,
        risk: `Short-dated = high theta ($${(spotPrice * input.currentIV / Math.sqrt(252) * 0.1).toFixed(2)}/day estimated). Close same/next day. Volatility scalp.`,
        reasoning: [
          `Spot ${flipDistATR.toFixed(2)} ATR from gamma flip ($${gammaFlip.toFixed(0)}) — regime transition zone`,
          'Historically high volatility at the flip point',
          'Dealer hedging reverses — whipsaw expected',
        ],
        tags: ['event-driven', 'volatility-long', 'short-duration'],
      });
    }
  }

  // ─── Max Pain Pin Play — distance in ATR ───
  if (input.nearestDTE <= 3) {
    const mpDistPct = Math.abs(maxPain - spotPrice) / spotPrice * 100;
    const mpDistATR = atrPercent > 0 ? mpDistPct / atrPercent : 0;
    if (mpDistATR > 0.3 && mpDistATR < 3) { // achievable but meaningful
      const mpDir = maxPain > spotPrice ? 'bullish' : 'bearish';
      trades.push({
        strategy: 'Max Pain Reversion',
        direction: mpDir,
        confidence: mpDistATR < 1.5 ? 'medium' : 'low',
        score: mpDistATR < 1.5 ? 60 : 45,
        expiration: shortDTE,
        strikes: mpDir === 'bullish'
          ? `Buy call spread: $${Math.round(spotPrice / strikeStep) * strikeStep} / $${Math.round(maxPain / strikeStep) * strikeStep}`
          : `Buy put spread: $${Math.round(spotPrice / strikeStep) * strikeStep} / $${Math.round(maxPain / strikeStep) * strikeStep}`,
        entry: `Target $${maxPain} by expiration — ${mpDistATR.toFixed(1)} ATR move needed (${input.nearestDTE}d to travel).`,
        risk: 'Only works into expiration. Max risk = debit. Close by expiration day.',
        reasoning: [
          `Max Pain at $${maxPain} — ${mpDistATR.toFixed(1)} ATR from spot (${((maxPain - spotPrice) / spotPrice * 100).toFixed(1)}%)`,
          `${input.nearestDTE}d until expiration — pin effect strengthening`,
          mpDistATR < 1.5 ? 'Distance achievable within normal daily range' : 'Requires above-average move — lower confidence',
        ],
        tags: ['expiration-play', 'mean-reversion', 'short-duration'],
      });
    }
  }

  trades.sort((a, b) => b.score - a.score);
  return trades;
}

// ─── Main Entry ────────────────────────────────────────────

export function generateRecommendations(input: RecommendationInput): RecommendationOutput {
  const signals = scoreSignals(input);
  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
  // Cap total weight to ±0.60 so score stays in [-60, +60] — prevents
  // runaway stacking of many small signals from creating extreme scores
  const cappedWeight = clamp(totalWeight, -0.60, 0.60);
  const biasScore = cappedWeight * 100;

  let overallBias: Direction = 'neutral';
  // Wider neutral band (±20) so the label doesn't flip on minor noise
  if (biasScore > 20) overallBias = 'bullish';
  else if (biasScore < -20) overallBias = 'bearish';

  let volRegime: VolRegime = 'mid';
  if (input.ivRank > 60) volRegime = 'high';
  else if (input.ivRank < 30) volRegime = 'low';

  let gammaRegime: GammaRegime = 'neutral';
  if (input.totalGEX > 0) gammaRegime = 'long';
  else if (input.totalGEX < 0) gammaRegime = 'short';

  const trades = generateTrades(input, signals, overallBias, biasScore, volRegime, gammaRegime);

  // ─── ATR-relative warnings ───
  const warnings: string[] = [];
  const moveSigma = input.dailySigma > 0 ? Math.abs(input.changePercent) / input.dailySigma : 0;

  if (input.nearestDTE <= 1) {
    warnings.push('Nearest expiration is tomorrow — 0DTE risk is extreme. Size accordingly.');
  }
  if (input.ivRank > 85) {
    warnings.push(`IV near 52-week highs (Rank ${input.ivRank}) — avoid buying naked long options; they need a ${(input.currentIV / Math.sqrt(252) * 200).toFixed(0)}%+ move to profit.`);
  }
  if (input.volumePCR > 2) {
    const optVol = input.totalCallVol + input.totalPutVol;
    if (optVol < 1000) {
      warnings.push(`P/C ratio ${input.volumePCR.toFixed(2)} on only ${optVol} total contracts — likely thin-market artifact, not reliable sentiment signal.`);
    } else {
      warnings.push(`Extremely elevated P/C ratio (${input.volumePCR.toFixed(2)}) — could indicate panic hedging or imminent catalyst.`);
    }
  }
  if (input.totalGEX < 0 && input.ivRank > 60) {
    warnings.push('Short gamma + elevated IV = volatile environment. Use defined-risk strategies only.');
  }

  // ATR-relative move warning — not hardcoded %
  if (moveSigma > 2.5) {
    warnings.push(`Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% move is ${moveSigma.toFixed(1)}σ — abnormally large for a stock with ${input.atrPercent.toFixed(1)}% ATR. Wait for price to settle before entering new positions.`);
  } else if (moveSigma > 1.8) {
    warnings.push(`Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% move is ${moveSigma.toFixed(1)}σ — above average for this stock's ${input.atrPercent.toFixed(1)}% daily ATR. Consider waiting for a pullback before entering.`);
  }

  // Move context for display
  const moveContext = moveSigma > 0
    ? `${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% today = ${moveSigma.toFixed(1)}σ move | ATR: ${input.atrPercent.toFixed(1)}% ($${input.atr14.toFixed(2)}) | Avg daily range: ${input.avgDailyRangePct.toFixed(1)}%`
    : '';

  const stockContext = `${input.symbol}: ${input.atrPercent.toFixed(1)}% daily ATR ($${input.atr14.toFixed(2)}), ${(input.hvCurrent * 100).toFixed(0)}% HV20, ${(input.currentIV * 100).toFixed(0)}% IV, ${input.dailySigma.toFixed(2)}% daily 1σ`;

  return {
    symbol: input.symbol,
    spotPrice: input.spotPrice,
    overallBias,
    biasScore: Math.round(biasScore),
    volRegime,
    gammaRegime,
    signals,
    trades,
    warnings,
    moveContext,
    stockContext,
    timestamp: Date.now(),
  };
}

function abbr(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function avgDailyRangePctStr(v: number): string {
  return v > 0 ? `${v.toFixed(1)}%` : 'N/A';
}
