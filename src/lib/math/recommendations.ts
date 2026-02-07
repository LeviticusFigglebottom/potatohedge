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
  if (input.gammaFlip !== null) {
    const distPct = (spotPrice - input.gammaFlip) / spotPrice * 100;
    const distATR = atrPercent > 0 ? Math.abs(distPct) / atrPercent : 0;
    if (distPct > 0.3) {
      signals.push({
        name: 'Gamma Flip',
        direction: 'bullish',
        weight: Math.min(0.3, distATR * 0.15),
        description: `Spot ${distPct.toFixed(1)}% above γ flip ($${input.gammaFlip.toFixed(0)}) — ${distATR.toFixed(1)} ATR into positive gamma, dips get bought`,
      });
    } else if (distPct < -0.3) {
      signals.push({
        name: 'Gamma Flip',
        direction: 'bearish',
        weight: Math.max(-0.3, -distATR * 0.15),
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

  // 3. Call/Put Wall Proximity — measured in ATR
  if (input.callWall !== null) {
    const distPct = (input.callWall - spotPrice) / spotPrice * 100;
    const distATR = atrPercent > 0 ? distPct / atrPercent : 99;
    if (distPct > 0 && distATR < 1.5) {
      signals.push({
        name: 'Call Wall Proximity',
        direction: 'bearish',
        weight: -0.2,
        description: `Call Wall at $${input.callWall} is ${distATR.toFixed(1)} ATR overhead (${distPct.toFixed(1)}%) — strong resistance within ~${Math.ceil(distATR)} day range`,
      });
    } else if (distPct < 0) {
      signals.push({
        name: 'Call Wall Breach',
        direction: 'bullish',
        weight: 0.3,
        description: `Above Call Wall ($${input.callWall}) — dealers chasing, squeeze potential`,
      });
    }
  }

  if (input.putWall !== null) {
    const distPct = (spotPrice - input.putWall) / spotPrice * 100;
    const distATR = atrPercent > 0 ? distPct / atrPercent : 99;
    if (distPct > 0 && distATR < 1.5) {
      signals.push({
        name: 'Put Wall Proximity',
        direction: 'bullish',
        weight: 0.2,
        description: `Put Wall at $${input.putWall} is ${distATR.toFixed(1)} ATR below (${distPct.toFixed(1)}%) — strong support within ~${Math.ceil(distATR)} day range`,
      });
    } else if (distPct < 0) {
      signals.push({
        name: 'Put Wall Breach',
        direction: 'bearish',
        weight: -0.3,
        description: `Below Put Wall ($${input.putWall}) — support broken, downside accelerates`,
      });
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
  if (input.volumePCR > 1.3) {
    signals.push({
      name: 'Volume P/C Ratio',
      direction: 'bearish',
      weight: input.volumePCR > 2 ? -0.35 : -0.25,
      description: `PCR ${input.volumePCR.toFixed(2)}${input.volumePCR > 2 ? ' — extreme' : ''} — heavy put buying, bearish sentiment or hedging demand`,
    });
  } else if (input.volumePCR > 1.0) {
    signals.push({
      name: 'Volume P/C Ratio',
      direction: 'bearish',
      weight: -0.1,
      description: `PCR ${input.volumePCR.toFixed(2)} — slightly put-heavy, mild bearish lean`,
    });
  } else if (input.volumePCR < 0.6) {
    signals.push({
      name: 'Volume P/C Ratio',
      direction: 'bullish',
      weight: 0.25,
      description: `PCR ${input.volumePCR.toFixed(2)} — strong call dominance, bullish flow`,
    });
  } else if (input.volumePCR < 0.8) {
    signals.push({
      name: 'Volume P/C Ratio',
      direction: 'bullish',
      weight: 0.1,
      description: `PCR ${input.volumePCR.toFixed(2)} — call-heavy, mild bullish lean`,
    });
  }

  // 6. DEX Bias
  if (input.totalDEX < 0) {
    signals.push({
      name: 'Dealer Delta',
      direction: 'bullish',
      weight: 0.1,
      description: `Dealers short delta ($${abbr(input.totalDEX)}) — must buy underlying to hedge, supportive flow`,
    });
  } else if (input.totalDEX > 0) {
    signals.push({
      name: 'Dealer Delta',
      direction: 'bearish',
      weight: -0.05,
      description: `Dealers long delta ($${abbr(input.totalDEX)}) — may sell into rallies`,
    });
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

  // 10. Momentum — ATR-RELATIVE, not hardcoded
  // A "big move" is >2σ or >1.5 ATR, NOT a fixed percentage
  const absChange = Math.abs(input.changePercent);
  const moveSigma = dailySigma > 0 ? absChange / dailySigma : 0;
  const moveATR = atrPercent > 0 ? absChange / atrPercent : 0;

  if (moveSigma > 2) {
    const dir = input.changePercent > 0 ? 'bullish' : 'bearish';
    signals.push({
      name: 'Momentum',
      direction: dir,
      weight: dir === 'bullish' ? Math.min(0.2, moveSigma * 0.05) : Math.max(-0.2, -moveSigma * 0.05),
      description: `Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% = ${moveSigma.toFixed(1)}σ move (${moveATR.toFixed(1)}x ATR) — statistically significant for this stock`,
    });
  } else if (moveSigma > 1.2) {
    const dir = input.changePercent > 0 ? 'bullish' : 'bearish';
    signals.push({
      name: 'Momentum',
      direction: dir,
      weight: dir === 'bullish' ? 0.08 : -0.08,
      description: `Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% = ${moveSigma.toFixed(1)}σ (${moveATR.toFixed(1)}x ATR) — above average for this stock's ${atrPercent.toFixed(1)}% daily ATR`,
    });
  } else if (absChange > 0.1) {
    signals.push({
      name: 'Momentum',
      direction: 'neutral',
      weight: 0,
      description: `Today's ${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}% = ${moveSigma.toFixed(1)}σ — within normal range for this stock (${atrPercent.toFixed(1)}% ATR, ${avgDailyRangePctStr(input.avgDailyRangePct)} avg daily range)`,
    });
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
  const biasScore = totalWeight * 100;

  let overallBias: Direction = 'neutral';
  if (biasScore > 15) overallBias = 'bullish';
  else if (biasScore < -15) overallBias = 'bearish';

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
    warnings.push(`Extremely elevated P/C ratio (${input.volumePCR.toFixed(2)}) — could indicate panic hedging or imminent catalyst.`);
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
