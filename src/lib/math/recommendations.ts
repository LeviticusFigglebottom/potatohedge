/**
 * Trade Recommendation Engine
 *
 * Synthesizes all available data into scored, actionable trade ideas:
 * - Price action & key levels (gamma flip, walls, max pain)
 * - Dealer positioning (GEX regime, DEX bias)
 * - Volatility regime (IV rank, IV/HV, term structure)
 * - Options flow (PCR, volume ratios, OI concentration)
 * - Skew bias
 *
 * Outputs specific strategies with strikes, expirations, and reasoning.
 */

export type Direction = 'bullish' | 'bearish' | 'neutral';
export type VolRegime = 'high' | 'mid' | 'low';
export type GammaRegime = 'long' | 'short' | 'neutral';
export type Confidence = 'high' | 'medium' | 'low';

export interface Signal {
  name: string;
  direction: Direction;
  weight: number;       // -1 to +1 (bearish to bullish)
  description: string;
}

export interface TradeIdea {
  strategy: string;       // e.g. "Bull Put Spread", "Long Call", "Iron Condor"
  direction: Direction;
  confidence: Confidence;
  score: number;          // 0-100
  expiration: string;     // target DTE range
  strikes: string;        // strike selection guidance
  entry: string;          // when/how to enter
  risk: string;           // risk management
  reasoning: string[];    // bullet points of why
  tags: string[];         // e.g. ["premium-selling", "mean-reversion"]
}

export interface RecommendationOutput {
  symbol: string;
  spotPrice: number;
  overallBias: Direction;
  biasScore: number;     // -100 to +100
  volRegime: VolRegime;
  gammaRegime: GammaRegime;
  signals: Signal[];
  trades: TradeIdea[];
  warnings: string[];
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
  // Price
  changePercent: number;
  // Expirations available
  nearestExp: string;
  nearestDTE: number;
  weeklyExp?: string;
  monthlyExp?: string;
}

// ─── Signal Scoring ────────────────────────────────────────

function scoreSignals(input: RecommendationInput): Signal[] {
  const signals: Signal[] = [];
  const { spotPrice } = input;

  // 1. GEX Regime
  if (input.totalGEX > 0) {
    signals.push({
      name: 'GEX Regime',
      direction: 'neutral',
      weight: 0.1, // long gamma suppresses moves — slightly bullish bias (mean-reversion)
      description: `Dealers long gamma ($${abbr(input.totalGEX)}) — expect mean-reversion, sell volatility`,
    });
  } else if (input.totalGEX < 0) {
    signals.push({
      name: 'GEX Regime',
      direction: 'neutral',
      weight: 0, // short gamma amplifies — could go either way
      description: `Dealers short gamma ($${abbr(input.totalGEX)}) — amplified moves, trend-following favored`,
    });
  }

  // 2. Gamma Flip Position
  if (input.gammaFlip !== null) {
    const dist = (spotPrice - input.gammaFlip) / spotPrice;
    if (dist > 0.005) {
      signals.push({
        name: 'Gamma Flip',
        direction: 'bullish',
        weight: Math.min(0.3, dist * 5),
        description: `Spot ${(dist * 100).toFixed(1)}% above γ flip ($${input.gammaFlip.toFixed(0)}) — positive gamma territory, dips get bought`,
      });
    } else if (dist < -0.005) {
      signals.push({
        name: 'Gamma Flip',
        direction: 'bearish',
        weight: Math.max(-0.3, dist * 5),
        description: `Spot ${(Math.abs(dist) * 100).toFixed(1)}% below γ flip ($${input.gammaFlip.toFixed(0)}) — negative gamma, sells accelerate`,
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

  // 3. Call/Put Wall Magnets
  if (input.callWall !== null) {
    const distToCallWall = (input.callWall - spotPrice) / spotPrice;
    if (distToCallWall > 0 && distToCallWall < 0.03) {
      signals.push({
        name: 'Call Wall Proximity',
        direction: 'bearish',
        weight: -0.2,
        description: `Approaching Call Wall ($${input.callWall}) — ${(distToCallWall * 100).toFixed(1)}% away, strong resistance`,
      });
    } else if (distToCallWall < 0) {
      signals.push({
        name: 'Call Wall Breach',
        direction: 'bullish',
        weight: 0.3,
        description: `Above Call Wall ($${input.callWall}) — dealers chasing, squeeze potential`,
      });
    }
  }

  if (input.putWall !== null) {
    const distToPutWall = (spotPrice - input.putWall) / spotPrice;
    if (distToPutWall > 0 && distToPutWall < 0.03) {
      signals.push({
        name: 'Put Wall Proximity',
        direction: 'bullish',
        weight: 0.2,
        description: `Near Put Wall ($${input.putWall}) — ${(distToPutWall * 100).toFixed(1)}% above, strong support`,
      });
    } else if (distToPutWall < 0) {
      signals.push({
        name: 'Put Wall Breach',
        direction: 'bearish',
        weight: -0.3,
        description: `Below Put Wall ($${input.putWall}) — support broken, downside accelerates`,
      });
    }
  }

  // 4. Max Pain Magnet
  const maxPainDist = (input.maxPain - spotPrice) / spotPrice;
  if (Math.abs(maxPainDist) > 0.01) {
    signals.push({
      name: 'Max Pain Magnet',
      direction: maxPainDist > 0 ? 'bullish' : 'bearish',
      weight: Math.max(-0.15, Math.min(0.15, maxPainDist * 3)),
      description: `Max pain at $${input.maxPain} (${maxPainDist > 0 ? '+' : ''}${(maxPainDist * 100).toFixed(1)}%) — gravitational pull toward expiration`,
    });
  }

  // 5. PCR Signal
  if (input.volumePCR > 1.3) {
    signals.push({
      name: 'Volume P/C Ratio',
      direction: 'bearish',
      weight: -0.25,
      description: `PCR ${input.volumePCR.toFixed(2)} — heavy put buying, bearish sentiment or hedging demand`,
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
      description: `IV Rank ${input.ivRank} — elevated implied vol, favor selling premium`,
    });
  } else if (input.ivRank < 25) {
    signals.push({
      name: 'IV Rank',
      direction: 'neutral',
      weight: 0,
      description: `IV Rank ${input.ivRank} — low implied vol, options are cheap, favor buying`,
    });
  }

  // 8. IV/HV Divergence
  if (input.ivHvRatio > 1.3) {
    signals.push({
      name: 'IV/HV Spread',
      direction: 'neutral',
      weight: 0,
      description: `IV/HV ${input.ivHvRatio.toFixed(2)} — implied vol overpricing realized moves, edge in selling`,
    });
  } else if (input.ivHvRatio < 0.85 && input.ivHvRatio > 0) {
    signals.push({
      name: 'IV/HV Spread',
      direction: 'neutral',
      weight: 0,
      description: `IV/HV ${input.ivHvRatio.toFixed(2)} — options underpriced vs realized movement`,
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

  // 10. Recent Price Action
  if (input.changePercent > 2) {
    signals.push({
      name: 'Momentum',
      direction: 'bullish',
      weight: 0.15,
      description: `Strong rally today (+${input.changePercent.toFixed(1)}%) — bullish momentum`,
    });
  } else if (input.changePercent < -2) {
    signals.push({
      name: 'Momentum',
      direction: 'bearish',
      weight: -0.15,
      description: `Sharp sell-off today (${input.changePercent.toFixed(1)}%) — bearish momentum`,
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
  const { spotPrice, callWall, putWall, gammaFlip, maxPain } = input;

  // Determine DTE targets
  const shortDTE = input.nearestDTE <= 5 ? `${input.nearestDTE}d (${input.nearestExp})` : `3-7 DTE`;
  const medDTE = '14-21 DTE';
  const longDTE = '30-45 DTE';

  // ─── HIGH IV: Sell Premium ───
  if (volRegime === 'high') {
    if (bias === 'bullish' || bias === 'neutral') {
      trades.push({
        strategy: 'Bull Put Spread (Credit)',
        direction: 'bullish',
        confidence: bias === 'bullish' ? 'high' : 'medium',
        score: bias === 'bullish' ? 80 : 65,
        expiration: longDTE,
        strikes: putWall
          ? `Sell put near $${Math.round(putWall)}, buy $${Math.round(putWall - (spotPrice * 0.02))} — use put wall as support`
          : `Sell ~0.30Δ put, buy 1-2 strikes below`,
        entry: 'Enter on up days when IV is still elevated. Target ~1/3 width of spread in credit.',
        risk: 'Max loss = spread width - credit. Close at 50% profit or if short strike is breached.',
        reasoning: [
          `IV Rank ${input.ivRank} — options overpriced, edge in selling`,
          bias === 'bullish' ? 'Directional signals lean bullish' : 'Neutral bias allows defined-risk credit',
          gammaRegime === 'long' ? 'Long gamma regime — mean-reversion supports short puts' : '',
          putWall ? `Put Wall at $${putWall.toFixed(0)} provides natural support` : '',
        ].filter(Boolean),
        tags: ['premium-selling', 'defined-risk', 'theta-positive'],
      });
    }

    if (bias === 'bearish' || bias === 'neutral') {
      trades.push({
        strategy: 'Bear Call Spread (Credit)',
        direction: 'bearish',
        confidence: bias === 'bearish' ? 'high' : 'medium',
        score: bias === 'bearish' ? 80 : 65,
        expiration: longDTE,
        strikes: callWall
          ? `Sell call near $${Math.round(callWall)}, buy $${Math.round(callWall + (spotPrice * 0.02))} — use call wall as resistance`
          : `Sell ~0.30Δ call, buy 1-2 strikes above`,
        entry: 'Enter on down days when IV pops. Target ~1/3 width in credit.',
        risk: 'Max loss = spread width - credit. Close at 50% profit.',
        reasoning: [
          `IV Rank ${input.ivRank} — rich premium to sell`,
          bias === 'bearish' ? 'Directional signals lean bearish' : 'Neutral allows credit collection',
          callWall ? `Call Wall at $${callWall.toFixed(0)} caps upside` : '',
        ].filter(Boolean),
        tags: ['premium-selling', 'defined-risk', 'theta-positive'],
      });
    }

    if (bias === 'neutral' && gammaRegime === 'long') {
      trades.push({
        strategy: 'Iron Condor',
        direction: 'neutral',
        confidence: 'high',
        score: 85,
        expiration: longDTE,
        strikes: `Sell calls at $${callWall ? Math.round(callWall) : Math.round(spotPrice * 1.03)}, sell puts at $${putWall ? Math.round(putWall) : Math.round(spotPrice * 0.97)}. Wings $${Math.round(spotPrice * 0.02)} beyond.`,
        entry: 'Enter when IV is above 30d MA. Collect both sides of credit.',
        risk: 'Max loss on either side. Close at 50% profit. Manage tested side at 2x credit received.',
        reasoning: [
          `IV Rank ${input.ivRank} — premium-rich environment`,
          'Long gamma regime — dealers suppress breakouts, pinning action',
          callWall ? `Call Wall $${callWall.toFixed(0)} + Put Wall $${putWall?.toFixed(0)} define the range` : 'GEX walls define the expected range',
          `Max Pain at $${maxPain} — expiration pin likely`,
        ].filter(Boolean),
        tags: ['premium-selling', 'range-bound', 'theta-positive', 'highest-conviction'],
      });
    }
  }

  // ─── LOW IV: Buy Premium ───
  if (volRegime === 'low') {
    if (bias === 'bullish') {
      trades.push({
        strategy: 'Bull Call Debit Spread',
        direction: 'bullish',
        confidence: Math.abs(biasScore) > 30 ? 'high' : 'medium',
        score: Math.abs(biasScore) > 30 ? 75 : 60,
        expiration: medDTE,
        strikes: callWall
          ? `Buy ATM call ($${Math.round(spotPrice)}), sell call at $${Math.round(callWall)} — target call wall`
          : `Buy ATM, sell 2-3% OTM`,
        entry: 'Enter on pullbacks to support. IV is cheap — time decay less punishing.',
        risk: 'Max risk = debit paid. Take profit at 50-100% of debit.',
        reasoning: [
          `IV Rank ${input.ivRank} — options are cheap, good entry for directional bets`,
          'Bullish directional signals support upside targeting',
          callWall ? `Call Wall at $${callWall.toFixed(0)} = realistic price target` : '',
          gammaRegime === 'short' ? 'Short gamma — moves will be amplified in your favor' : '',
        ].filter(Boolean),
        tags: ['premium-buying', 'defined-risk', 'directional'],
      });
    }

    if (bias === 'bearish') {
      trades.push({
        strategy: 'Bear Put Debit Spread',
        direction: 'bearish',
        confidence: Math.abs(biasScore) > 30 ? 'high' : 'medium',
        score: Math.abs(biasScore) > 30 ? 75 : 60,
        expiration: medDTE,
        strikes: putWall
          ? `Buy ATM put ($${Math.round(spotPrice)}), sell put at $${Math.round(putWall)} — target put wall`
          : `Buy ATM, sell 2-3% OTM`,
        entry: 'Enter on failed rallies or rejection at resistance.',
        risk: 'Max risk = debit paid. Take profit at 50-100%.',
        reasoning: [
          `IV Rank ${input.ivRank} — cheap options, favorable for buying`,
          'Bearish signals support downside targeting',
          putWall ? `Put Wall at $${putWall.toFixed(0)} as downside target` : '',
          gammaRegime === 'short' ? 'Short gamma amplifies the move' : '',
        ].filter(Boolean),
        tags: ['premium-buying', 'defined-risk', 'directional'],
      });
    }

    if (gammaRegime === 'short') {
      trades.push({
        strategy: 'Long Straddle / Strangle',
        direction: 'neutral',
        confidence: input.ivHvRatio < 0.85 ? 'high' : 'medium',
        score: input.ivHvRatio < 0.85 ? 80 : 60,
        expiration: medDTE,
        strikes: `Buy ATM straddle ($${Math.round(spotPrice)}) or strangle ($${Math.round(spotPrice * 0.98)}P / $${Math.round(spotPrice * 1.02)}C)`,
        entry: 'Enter when IV is near 52w lows. Need a 1-2% move to profit.',
        risk: 'Max risk = premium paid. Close if IV compresses further. Manage at 21 DTE.',
        reasoning: [
          `IV Rank ${input.ivRank} — vol is cheap, straddles underpriced`,
          input.ivHvRatio < 0.85 ? `IV/HV ${input.ivHvRatio.toFixed(2)} — implied well below realized, edge in buying vol` : '',
          'Short gamma regime — dealer hedging amplifies moves in either direction',
          'Non-directional — profits from movement regardless of direction',
        ].filter(Boolean),
        tags: ['premium-buying', 'volatility-long', 'non-directional'],
      });
    }
  }

  // ─── MID IV: Context-Dependent ───
  if (volRegime === 'mid') {
    if (bias === 'bullish' && Math.abs(biasScore) > 20) {
      trades.push({
        strategy: 'Call Debit Spread',
        direction: 'bullish',
        confidence: Math.abs(biasScore) > 40 ? 'high' : 'medium',
        score: Math.min(75, 50 + Math.abs(biasScore)),
        expiration: medDTE,
        strikes: callWall
          ? `Buy slightly ITM call, sell at $${Math.round(callWall)}`
          : 'Buy ATM, sell 2-3% OTM',
        entry: 'Enter on pullbacks. Risk 1-2% of account.',
        risk: 'Max risk = debit. Target 50-100% return on debit.',
        reasoning: [
          'Mid-range IV — spreads offer best risk/reward',
          `Bullish bias score: ${biasScore > 0 ? '+' : ''}${biasScore.toFixed(0)}`,
          ...signals.filter(s => s.direction === 'bullish').map(s => s.description).slice(0, 2),
        ],
        tags: ['defined-risk', 'directional'],
      });
    }

    if (bias === 'bearish' && Math.abs(biasScore) > 20) {
      trades.push({
        strategy: 'Put Debit Spread',
        direction: 'bearish',
        confidence: Math.abs(biasScore) > 40 ? 'high' : 'medium',
        score: Math.min(75, 50 + Math.abs(biasScore)),
        expiration: medDTE,
        strikes: putWall
          ? `Buy slightly ITM put, sell at $${Math.round(putWall)}`
          : 'Buy ATM, sell 2-3% OTM',
        entry: 'Enter on failed rallies or breakdown below support.',
        risk: 'Max risk = debit. Target 50-100% return.',
        reasoning: [
          'Mid-range IV — spreads optimal',
          `Bearish bias score: ${biasScore.toFixed(0)}`,
          ...signals.filter(s => s.direction === 'bearish').map(s => s.description).slice(0, 2),
        ],
        tags: ['defined-risk', 'directional'],
      });
    }
  }

  // ─── Gamma Flip Play (any IV) ───
  if (gammaFlip !== null && Math.abs(spotPrice - gammaFlip) / spotPrice < 0.015) {
    trades.push({
      strategy: 'Gamma Flip Straddle',
      direction: 'neutral',
      confidence: 'medium',
      score: 65,
      expiration: shortDTE,
      strikes: `ATM straddle at $${Math.round(spotPrice)} — near gamma flip`,
      entry: 'Enter when spot is within 1% of gamma flip. Expect explosive move in either direction.',
      risk: 'Short-dated = high theta. Close same day or next day. This is a volatility scalp.',
      reasoning: [
        `Spot right at gamma flip ($${gammaFlip.toFixed(0)}) — regime transition zone`,
        'Historically high volatility at the flip point',
        'Dealer hedging reverses — whipsaw expected',
      ],
      tags: ['event-driven', 'volatility-long', 'short-duration'],
    });
  }

  // ─── Max Pain Pin Play (near expiration) ───
  if (input.nearestDTE <= 3 && Math.abs(maxPain - spotPrice) / spotPrice > 0.01) {
    const mpDir = maxPain > spotPrice ? 'bullish' : 'bearish';
    trades.push({
      strategy: 'Max Pain Reversion',
      direction: mpDir,
      confidence: 'medium',
      score: 60,
      expiration: shortDTE,
      strikes: mpDir === 'bullish'
        ? `Buy call spread: $${Math.round(spotPrice)} / $${Math.round(maxPain)}`
        : `Buy put spread: $${Math.round(spotPrice)} / $${Math.round(maxPain)}`,
      entry: `Target $${maxPain} by expiration. Enter early in the week for Friday expiry.`,
      risk: 'Only works into expiration. Max risk = debit. Close by expiration day.',
      reasoning: [
        `Max Pain at $${maxPain} — ${((maxPain - spotPrice) / spotPrice * 100).toFixed(1)}% from spot`,
        `${input.nearestDTE}d until expiration — pin effect strengthening`,
        'Market makers profit when price gravitates toward max pain',
      ],
      tags: ['expiration-play', 'mean-reversion', 'short-duration'],
    });
  }

  // Sort by score
  trades.sort((a, b) => b.score - a.score);

  return trades;
}

// ─── Main Entry ────────────────────────────────────────────

export function generateRecommendations(input: RecommendationInput): RecommendationOutput {
  const signals = scoreSignals(input);

  // Compute overall bias
  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0);
  const biasScore = totalWeight * 100; // -100 to +100

  let overallBias: Direction = 'neutral';
  if (biasScore > 15) overallBias = 'bullish';
  else if (biasScore < -15) overallBias = 'bearish';

  // Volatility regime
  let volRegime: VolRegime = 'mid';
  if (input.ivRank > 60) volRegime = 'high';
  else if (input.ivRank < 30) volRegime = 'low';

  // Gamma regime
  let gammaRegime: GammaRegime = 'neutral';
  if (input.totalGEX > 0) gammaRegime = 'long';
  else if (input.totalGEX < 0) gammaRegime = 'short';

  // Generate trades
  const trades = generateTrades(input, signals, overallBias, biasScore, volRegime, gammaRegime);

  // Warnings
  const warnings: string[] = [];
  if (input.nearestDTE <= 1) warnings.push('Nearest expiration is tomorrow — 0DTE risk is extreme. Size accordingly.');
  if (input.ivRank > 85) warnings.push('IV near 52-week highs — avoid buying naked long options, they need a huge move to profit.');
  if (input.volumePCR > 2) warnings.push('Extremely elevated put/call ratio — could indicate panic hedging or imminent catalyst.');
  if (input.totalGEX < 0 && input.ivRank > 60) warnings.push('Short gamma + high IV = volatile environment. Use defined-risk strategies only.');
  if (Math.abs(input.changePercent) > 3) warnings.push(`Large intraday move (${input.changePercent > 0 ? '+' : ''}${input.changePercent.toFixed(1)}%) — wait for price to settle before entering new positions.`);

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
