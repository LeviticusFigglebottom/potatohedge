import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60; // Claude can take a moment

interface AnalysisRequest {
  symbol: string;
  spotPrice: number;
  change: number;
  changePct: number;
  volume: number;
  avgVolume: number;
  bid: number;
  ask: number;

  // Dealer positioning
  totalGEX: number;
  totalDEX: number;
  totalVanna: number;
  totalCharm: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number;

  // Per-expiration breakdown
  perExpiration: {
    exp: string;
    dte: number;
    gex: number;
    dex: number;
    vanna: number;
    charm: number;
    pcr: number;
    callVol: number;
    putVol: number;
  }[];

  // Volume/Flow
  volumePCR: number;
  oiPCR: number;
  totalCallVol: number;
  totalPutVol: number;
  totalCallOI: number;
  totalPutOI: number;

  // Volatility
  currentIV: number;
  ivRank: number;
  ivPercentile: number;
  iv30dMA: number;
  iv52wHigh: number;
  iv52wLow: number;
  hv20: number;
  hv60: number;
  ivHvRatio: number;

  // Term structure
  termStructure: { exp: string; dte: number; atmIV: number }[];

  // Skew
  skewBias: string;
  skewRatio: number;

  // ATR / Stock profile
  atr14: number;
  atrPercent: number;
  dailySigma: number;
  avgDailyRangePct: number;

  // Context interpretations (from our engine)
  dealerContext: string;
  volumeContext: string;
  skewContext: string;
  oiContext: string;
  ivContext: string;

  // Recommendation engine output
  overallBias: string;
  biasScore: number;
  volRegime: string;
  gammaRegime: string;
  signals: { name: string; direction: string; weight: number; description: string }[];
  engineTrades: { strategy: string; direction: string; score: number; reasoning: string[] }[];
  warnings: string[];
  moveContext: string;
  stockContext: string;

  // Correlations
  correlations: {
    beta: number;
    marketCorrelation: number;
    alpha30d: number;
    alpha90d: number;
    drawdownRatio: number;
    rallyRatio: number;
    ivRegime: {
      lowVolAvg20d: number;
      highVolAvg20d: number;
      lowVolWinRate: number;
      insight: string;
    };
    volPricing: {
      overPricingRate: number;
      avgImpliedMove: number;
      avgRealizedMove: number;
      insight: string;
    };
    meanReversion: {
      bounceRateAfterDrops: number;
      pullbackRateAfterRallies: number;
      avgRecovery5d: number;
      insight: string;
    };
    sectorRelative: {
      sectorETF: string;
      sectorCorrelation: number;
      relativeStrength30d: number;
      divergenceDays: number;
      insight: string;
    } | null;
    anomalies: string[];
    strongestInsights: string[];
  } | null;
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }

  let data: AnalysisRequest;
  try {
    data = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Build the comprehensive prompt
  const prompt = buildPrompt(data);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'Unknown error');
      return NextResponse.json({ error: `Claude API error: ${response.status} — ${err}` }, { status: 500 });
    }

    const result = await response.json();
    const text = result.content
      ?.filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('\n') || 'No response generated.';

    return NextResponse.json({ analysis: text, model: result.model, usage: result.usage });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function buildPrompt(d: AnalysisRequest): string {
  const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;
  const dollarFmt = (v: number) => `$${v.toFixed(2)}`;
  const abbrNum = (n: number) => {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '+';
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  };

  const moveSigma = d.dailySigma > 0 ? Math.abs(d.changePct) / d.dailySigma : 0;
  const moveATR = d.atrPercent > 0 ? Math.abs(d.changePct) / d.atrPercent : 0;

  return `You are an expert options strategist and quantitative analyst. Analyze the following LIVE market data for ${d.symbol} and provide specific, actionable options trade recommendations.

═══════════════════════════════════════════
MARKET DATA SNAPSHOT — ${d.symbol}
═══════════════════════════════════════════

PRICE ACTION
• Spot: ${dollarFmt(d.spotPrice)} | Change: ${d.changePct > 0 ? '+' : ''}${d.changePct.toFixed(2)}% (${dollarFmt(d.change)})
• Today's move: ${moveSigma.toFixed(1)}σ (${moveATR.toFixed(1)}x ATR) — ${moveSigma > 2.5 ? 'ABNORMALLY LARGE' : moveSigma > 1.5 ? 'above average' : 'within normal range'}
• Volume: ${(d.volume / 1e6).toFixed(1)}M (${d.avgVolume > 0 ? ((d.volume / d.avgVolume) * 100).toFixed(0) : '?'}% of avg)
• Bid/Ask: ${dollarFmt(d.bid)} × ${dollarFmt(d.ask)}

STOCK VOLATILITY PROFILE
• 14-day ATR: ${dollarFmt(d.atr14)} (${d.atrPercent.toFixed(2)}% of price)
• Daily 1σ: ${d.dailySigma.toFixed(2)}% | Avg daily range: ${d.avgDailyRangePct.toFixed(2)}%
• HV20: ${pctFmt(d.hv20)} | HV60: ${pctFmt(d.hv60)}

IMPLIED VOLATILITY
• Current ATM IV: ${pctFmt(d.currentIV)}
• IV Rank: ${d.ivRank}/100 | IV Percentile: ${d.ivPercentile}%
• 52-week range: ${pctFmt(d.iv52wLow)} — ${pctFmt(d.iv52wHigh)} | 30d MA: ${pctFmt(d.iv30dMA)}
• IV/HV Ratio: ${d.ivHvRatio.toFixed(2)} — ${d.ivHvRatio > 1.3 ? 'options OVERPRICED vs realized' : d.ivHvRatio < 0.85 ? 'options UNDERPRICED vs realized' : 'fairly priced'}

IV TERM STRUCTURE${d.termStructure.length > 0 ? ' (' + (d.termStructure[0]?.atmIV < (d.termStructure[d.termStructure.length - 1]?.atmIV || 0) ? 'CONTANGO' : 'BACKWARDATION') + ')' : ''}
${d.termStructure.map(t => `  ${t.exp} (${t.dte}d): ${pctFmt(t.atmIV)}`).join('\n') || '  No data'}

DEALER POSITIONING (aggregated across ${d.perExpiration.length} expirations)
• Net GEX: ${abbrNum(d.totalGEX)} — Dealers are ${d.totalGEX > 0 ? 'LONG gamma (suppress volatility, mean-reversion)' : 'SHORT gamma (amplify moves, trend-following)'}
• Net DEX: ${abbrNum(d.totalDEX)} — Dealers ${d.totalDEX < 0 ? 'short delta (must BUY to hedge = supportive)' : 'long delta (may sell into rallies)'}
• Net Vanna: ${abbrNum(d.totalVanna)} | Net Charm: ${abbrNum(d.totalCharm)}
• Gamma Flip: ${d.gammaFlip ? dollarFmt(d.gammaFlip) + ` (spot is ${((d.spotPrice - d.gammaFlip) / d.spotPrice * 100).toFixed(1)}% ${d.spotPrice > d.gammaFlip ? 'ABOVE' : 'BELOW'})` : 'N/A'}
• Call Wall: ${d.callWall ? dollarFmt(d.callWall) + ` (${((d.callWall - d.spotPrice) / d.spotPrice * 100).toFixed(1)}% above = ${d.atrPercent > 0 ? ((d.callWall - d.spotPrice) / d.spotPrice * 100 / d.atrPercent).toFixed(1) : '?'} ATR)` : 'N/A'}
• Put Wall: ${d.putWall ? dollarFmt(d.putWall) + ` (${((d.spotPrice - d.putWall) / d.spotPrice * 100).toFixed(1)}% below = ${d.atrPercent > 0 ? ((d.spotPrice - d.putWall) / d.spotPrice * 100 / d.atrPercent).toFixed(1) : '?'} ATR)` : 'N/A'}
• Max Pain: ${dollarFmt(d.maxPain)} (${((d.maxPain - d.spotPrice) / d.spotPrice * 100).toFixed(1)}% from spot)

PER-EXPIRATION BREAKDOWN
${d.perExpiration.map(e => `  ${e.exp} (${e.dte}d): GEX ${abbrNum(e.gex)} | DEX ${abbrNum(e.dex)} | Vanna ${abbrNum(e.vanna)} | Charm ${abbrNum(e.charm)} | PCR ${e.pcr.toFixed(2)} | Calls ${(e.callVol / 1e3).toFixed(1)}K Puts ${(e.putVol / 1e3).toFixed(1)}K`).join('\n') || '  No data'}

OPTIONS FLOW
• Volume P/C Ratio: ${d.volumePCR.toFixed(3)} — ${d.volumePCR > 1.3 ? 'HEAVY put buying' : d.volumePCR < 0.7 ? 'HEAVY call buying' : 'relatively balanced'}
• OI P/C Ratio: ${d.oiPCR.toFixed(3)}
• Total call volume: ${(d.totalCallVol / 1e3).toFixed(1)}K | Total put volume: ${(d.totalPutVol / 1e3).toFixed(1)}K
• Total call OI: ${(d.totalCallOI / 1e3).toFixed(1)}K | Total put OI: ${(d.totalPutOI / 1e3).toFixed(1)}K

SKEW
• Bias: ${d.skewBias} | OTM Put/Call IV Ratio: ${d.skewRatio.toFixed(2)}x

OUR ENGINE'S SIGNALS (for context)
• Overall bias: ${d.overallBias} (score: ${d.biasScore})
• Vol regime: ${d.volRegime} | Gamma regime: ${d.gammaRegime}
${d.signals.map(s => `  [${s.direction}] ${s.name}: ${s.description} (weight: ${(s.weight * 100).toFixed(0)})`).join('\n')}

OUR ENGINE'S CONTEXTUAL ANALYSIS
• Dealer: ${d.dealerContext || 'N/A'}
• Volume: ${d.volumeContext || 'N/A'}
• Skew: ${d.skewContext || 'N/A'}
• OI: ${d.oiContext || 'N/A'}
• IV: ${d.ivContext || 'N/A'}

${d.warnings.length > 0 ? `WARNINGS: ${d.warnings.join(' | ')}` : ''}

${d.correlations ? `HISTORICAL CORRELATIONS & CROSS-REFERENCES (~500 days)
• Beta: ${d.correlations.beta.toFixed(2)} | Market Correlation: ${d.correlations.marketCorrelation.toFixed(2)}
• 30d Alpha: ${d.correlations.alpha30d > 0 ? '+' : ''}${(d.correlations.alpha30d * 100).toFixed(1)}% | 90d Alpha: ${d.correlations.alpha90d > 0 ? '+' : ''}${(d.correlations.alpha90d * 100).toFixed(1)}%
• Drawdown behavior: ${d.correlations.drawdownRatio.toFixed(1)}x SPY during selloffs | Rally behavior: ${d.correlations.rallyRatio.toFixed(1)}x SPY during rallies
• IV Regime: Low-vol 20d avg ${(d.correlations.ivRegime.lowVolAvg20d * 100).toFixed(1)}% | High-vol 20d avg ${(d.correlations.ivRegime.highVolAvg20d * 100).toFixed(1)}% | Low-vol 5d win rate: ${(d.correlations.ivRegime.lowVolWinRate * 100).toFixed(0)}%
• Vol Pricing: Options overpriced ${(d.correlations.volPricing.overPricingRate * 100).toFixed(0)}% of the time | Avg implied 5d move: ${(d.correlations.volPricing.avgImpliedMove * 100).toFixed(2)}% vs realized: ${(d.correlations.volPricing.avgRealizedMove * 100).toFixed(2)}%
• Mean Reversion: ${(d.correlations.meanReversion.bounceRateAfterDrops * 100).toFixed(0)}% bounce rate after 2σ+ drops | ${(d.correlations.meanReversion.pullbackRateAfterRallies * 100).toFixed(0)}% pullback rate after 2σ+ rallies | Avg 5d recovery: ${(d.correlations.meanReversion.avgRecovery5d * 100).toFixed(2)}%
${d.correlations.sectorRelative ? `• Sector (${d.correlations.sectorRelative.sectorETF}): Correlation ${d.correlations.sectorRelative.sectorCorrelation.toFixed(2)} | Rel strength 30d: ${d.correlations.sectorRelative.relativeStrength30d > 0 ? '+' : ''}${(d.correlations.sectorRelative.relativeStrength30d * 100).toFixed(1)}% | ${d.correlations.sectorRelative.divergenceDays} divergence days in 60d` : ''}
${d.correlations.anomalies.length > 0 ? `• Anomalies: ${d.correlations.anomalies.join(' | ')}` : ''}
• Strongest Signals: ${d.correlations.strongestInsights.join(' | ')}

CORRELATION INSIGHTS
• ${d.correlations.ivRegime.insight}
• ${d.correlations.volPricing.insight}
• ${d.correlations.meanReversion.insight}
${d.correlations.sectorRelative ? `• ${d.correlations.sectorRelative.insight}` : ''}` : ''}

═══════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════

Based on ALL the above data, provide 2-4 specific options trade recommendations. For each trade:

1. **Strategy** — exact strategy name (e.g., "Bull Put Spread", "Long Straddle", "Jade Lizard", etc.)
2. **Strikes & Expiration** — specific strike prices and target DTE, justified by the GEX levels, ATR, and term structure
3. **Entry Criteria** — when exactly to enter (price level, IV condition, or timing)
4. **Target & Stop** — profit target and stop loss, both in dollar and percentage terms
5. **Max Risk / Reward** — defined risk amounts
6. **Reasoning** — connect EVERY data point that supports this trade. Reference specific numbers from the data above. Explain the confluence of signals.
7. **What Could Go Wrong** — specific risks unique to this trade given the current data

Also provide:
- A brief **Market Regime Summary** (2-3 sentences synthesizing all the data into a cohesive picture)
- **Historical Context** — reference the correlation data: how does this stock typically behave in the current vol regime? Is the current IV fairly priced based on historical over/under-pricing patterns? Does the mean-reversion tendency favor any strategy? How is it performing vs its sector?
- **What to Watch** — key levels or events that would invalidate the thesis
- Rate your overall **conviction level** (1-10) and explain why

Be specific, quantitative, and reference the actual data. Do NOT give generic advice. Every recommendation should be traceable back to specific data points above. Think like a professional options desk analyst writing a trade memo.

Format your response using clear headers and be concise but thorough.`;
}
