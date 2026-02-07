import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60; // Claude can take a moment

interface AnalysisRequest {
  symbol: string;
  mode?: 'trade' | 'fundamental';
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

  // For fundamental mode, fetch live financial data first
  let fundamentals: FundamentalData | null = null;
  if (data.mode === 'fundamental') {
    fundamentals = await fetchYahooFinancials(data.symbol);
  }

  // Build the prompt based on mode
  const prompt = data.mode === 'fundamental'
    ? buildFundamentalPrompt(data, fundamentals)
    : buildPrompt(data);

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

// ─── Yahoo Finance Data Fetching ──────────────────────────────

interface FundamentalData {
  // Profile
  sector?: string;
  industry?: string;
  employees?: number;
  summary?: string;
  // Valuation
  marketCap?: number;
  enterpriseValue?: number;
  trailingPE?: number;
  forwardPE?: number;
  pegRatio?: number;
  priceToSales?: number;
  priceToBook?: number;
  evToEbitda?: number;
  evToRevenue?: number;
  // Financials
  revenue?: number;
  revenueGrowth?: number;
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  ebitda?: number;
  trailingEps?: number;
  forwardEps?: number;
  earningsGrowth?: number;
  // Balance sheet
  totalCash?: number;
  totalDebt?: number;
  debtToEquity?: number;
  // Returns & cashflow
  roe?: number;
  roa?: number;
  freeCashflow?: number;
  operatingCashflow?: number;
  // Dividend
  dividendYield?: number;
  dividendRate?: number;
  payoutRatio?: number;
  exDividendDate?: string;
  // Analyst
  targetMean?: number;
  targetHigh?: number;
  targetLow?: number;
  targetMedian?: number;
  recommendationKey?: string;
  numberOfAnalysts?: number;
  // Recommendation trend (current month)
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
  // Earnings history (last 4 quarters)
  earningsHistory?: { quarter: string; actual: number; estimate: number; surprisePct: number }[];
  nextEarningsDate?: string;
  // 52-week
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  // Other
  sharesOutstanding?: number;
  floatShares?: number;
  shortPercentOfFloat?: number;
  beta?: number;
  bookValue?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function raw(obj: any): number | undefined {
  return obj?.raw ?? obj ?? undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fmt(obj: any): string | undefined {
  return obj?.fmt ?? undefined;
}

async function fetchYahooFinancials(symbol: string): Promise<FundamentalData | null> {
  try {
    const modules = [
      'assetProfile',
      'financialData',
      'defaultKeyStatistics',
      'earningsHistory',
      'earningsTrend',
      'recommendationTrend',
      'calendarEvents',
    ].join(',');

    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return null;

    const profile = result.assetProfile || {};
    const fin = result.financialData || {};
    const stats = result.defaultKeyStatistics || {};
    const earnings = result.earningsHistory?.history || [];
    const recTrend = result.recommendationTrend?.trend?.[0] || {};
    const calendar = result.calendarEvents || {};

    const data: FundamentalData = {
      // Profile
      sector: profile.sector,
      industry: profile.industry,
      employees: raw(profile.fullTimeEmployees),
      summary: profile.longBusinessSummary,
      // Valuation
      marketCap: raw(fin.marketCap ?? stats.marketCap),
      enterpriseValue: raw(stats.enterpriseValue),
      trailingPE: raw(stats.trailingPE ?? fin.trailingPE),
      forwardPE: raw(stats.forwardPE ?? fin.forwardPE),
      pegRatio: raw(stats.pegRatio),
      priceToSales: raw(stats.priceToSalesTrailing12Months),
      priceToBook: raw(stats.priceToBook),
      evToEbitda: raw(stats.enterpriseToEbitda),
      evToRevenue: raw(stats.enterpriseToRevenue),
      // Financials
      revenue: raw(fin.totalRevenue),
      revenueGrowth: raw(fin.revenueGrowth),
      grossMargin: raw(fin.grossMargins),
      operatingMargin: raw(fin.operatingMargins),
      netMargin: raw(fin.profitMargins),
      ebitda: raw(fin.ebitda),
      trailingEps: raw(stats.trailingEps),
      forwardEps: raw(stats.forwardEps),
      earningsGrowth: raw(fin.earningsGrowth),
      // Balance sheet
      totalCash: raw(fin.totalCash),
      totalDebt: raw(fin.totalDebt),
      debtToEquity: raw(fin.debtToEquity),
      // Returns & cashflow
      roe: raw(fin.returnOnEquity),
      roa: raw(fin.returnOnAssets),
      freeCashflow: raw(fin.freeCashflow),
      operatingCashflow: raw(fin.operatingCashflow),
      // Dividend
      dividendYield: raw(stats.lastDividendValue) ? raw(fin.dividendYield) : undefined,
      dividendRate: raw(stats.lastDividendValue),
      payoutRatio: raw(stats.payoutRatio),
      exDividendDate: fmt(calendar.exDividendDate),
      // Analyst
      targetMean: raw(fin.targetMeanPrice),
      targetHigh: raw(fin.targetHighPrice),
      targetLow: raw(fin.targetLowPrice),
      targetMedian: raw(fin.targetMedianPrice),
      recommendationKey: fin.recommendationKey,
      numberOfAnalysts: raw(fin.numberOfAnalystOpinions),
      // Recommendation trend
      strongBuy: recTrend.strongBuy,
      buy: recTrend.buy,
      hold: recTrend.hold,
      sell: recTrend.sell,
      strongSell: recTrend.strongSell,
      // Earnings history
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      earningsHistory: earnings.slice(0, 4).map((e: any) => ({
        quarter: fmt(e.quarter) || 'N/A',
        actual: raw(e.epsActual) ?? 0,
        estimate: raw(e.epsEstimate) ?? 0,
        surprisePct: raw(e.surprisePercent) ?? 0,
      })),
      nextEarningsDate: fmt(calendar.earnings?.earningsDate?.[0]),
      // 52-week
      fiftyTwoWeekHigh: raw(stats.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: raw(stats.fiftyTwoWeekLow),
      // Other
      sharesOutstanding: raw(stats.sharesOutstanding),
      floatShares: raw(stats.floatShares),
      shortPercentOfFloat: raw(stats.shortPercentOfFloat),
      beta: raw(stats.beta),
      bookValue: raw(stats.bookValue),
    };

    return data;
  } catch {
    return null;
  }
}

// ─── Prompt Builders ──────────────────────────────────────────

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

function buildFundamentalPrompt(d: AnalysisRequest, fin: FundamentalData | null): string {
  const dollarFmt = (v: number) => `$${v.toFixed(2)}`;
  const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;
  const bigNum = (n: number) => {
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return `$${n.toLocaleString()}`;
  };

  // Build the live financial data section
  let financialSection: string;
  if (fin && fin.marketCap) {
    const lines: string[] = [];
    lines.push('LIVE FINANCIAL DATA (fetched from Yahoo Finance — use these numbers, they are current)');
    lines.push('');

    // Profile
    if (fin.sector || fin.industry) {
      lines.push(`Sector: ${fin.sector || 'N/A'} | Industry: ${fin.industry || 'N/A'}${fin.employees ? ` | Employees: ${fin.employees.toLocaleString()}` : ''}`);
    }
    if (fin.summary) {
      lines.push(`Business: ${fin.summary.slice(0, 500)}${fin.summary.length > 500 ? '...' : ''}`);
    }
    lines.push('');

    // Valuation
    lines.push('VALUATION');
    lines.push(`• Market Cap: ${bigNum(fin.marketCap)}${fin.enterpriseValue ? ` | EV: ${bigNum(fin.enterpriseValue)}` : ''}`);
    if (fin.trailingPE) lines.push(`• P/E (trailing): ${fin.trailingPE.toFixed(1)}x${fin.forwardPE ? ` | P/E (forward): ${fin.forwardPE.toFixed(1)}x` : ''}`);
    if (fin.pegRatio) lines.push(`• PEG Ratio: ${fin.pegRatio.toFixed(2)}`);
    if (fin.priceToSales) lines.push(`• P/S: ${fin.priceToSales.toFixed(1)}x${fin.priceToBook ? ` | P/B: ${fin.priceToBook.toFixed(1)}x` : ''}`);
    if (fin.evToEbitda) lines.push(`• EV/EBITDA: ${fin.evToEbitda.toFixed(1)}x${fin.evToRevenue ? ` | EV/Revenue: ${fin.evToRevenue.toFixed(1)}x` : ''}`);
    lines.push('');

    // Income
    lines.push('INCOME & GROWTH');
    if (fin.revenue) lines.push(`• Revenue (TTM): ${bigNum(fin.revenue)}${fin.revenueGrowth !== undefined ? ` | YoY Growth: ${(fin.revenueGrowth * 100).toFixed(1)}%` : ''}`);
    if (fin.trailingEps) lines.push(`• EPS (trailing): $${fin.trailingEps.toFixed(2)}${fin.forwardEps ? ` | EPS (forward est.): $${fin.forwardEps.toFixed(2)}` : ''}`);
    if (fin.earningsGrowth !== undefined) lines.push(`• Earnings Growth: ${(fin.earningsGrowth * 100).toFixed(1)}%`);
    if (fin.ebitda) lines.push(`• EBITDA: ${bigNum(fin.ebitda)}`);
    lines.push('');

    // Margins
    lines.push('MARGINS');
    const margins: string[] = [];
    if (fin.grossMargin !== undefined) margins.push(`Gross: ${(fin.grossMargin * 100).toFixed(1)}%`);
    if (fin.operatingMargin !== undefined) margins.push(`Operating: ${(fin.operatingMargin * 100).toFixed(1)}%`);
    if (fin.netMargin !== undefined) margins.push(`Net: ${(fin.netMargin * 100).toFixed(1)}%`);
    if (margins.length) lines.push(`• ${margins.join(' | ')}`);
    lines.push('');

    // Balance sheet & cashflow
    lines.push('BALANCE SHEET & CASHFLOW');
    if (fin.totalCash) lines.push(`• Cash: ${bigNum(fin.totalCash)}${fin.totalDebt ? ` | Debt: ${bigNum(fin.totalDebt)}` : ''}`);
    if (fin.debtToEquity !== undefined) lines.push(`• Debt/Equity: ${fin.debtToEquity.toFixed(1)}%`);
    if (fin.freeCashflow) lines.push(`• Free Cash Flow: ${bigNum(fin.freeCashflow)}${fin.operatingCashflow ? ` | Operating CF: ${bigNum(fin.operatingCashflow)}` : ''}`);
    const fcfYield = fin.freeCashflow && fin.marketCap ? (fin.freeCashflow / fin.marketCap * 100).toFixed(2) : null;
    if (fcfYield) lines.push(`• FCF Yield: ${fcfYield}%`);
    lines.push('');

    // Returns
    lines.push('RETURNS');
    const returns: string[] = [];
    if (fin.roe !== undefined) returns.push(`ROE: ${(fin.roe * 100).toFixed(1)}%`);
    if (fin.roa !== undefined) returns.push(`ROA: ${(fin.roa * 100).toFixed(1)}%`);
    if (returns.length) lines.push(`• ${returns.join(' | ')}`);
    lines.push('');

    // Dividend
    if (fin.dividendYield && fin.dividendYield > 0) {
      lines.push('DIVIDEND');
      lines.push(`• Yield: ${(fin.dividendYield * 100).toFixed(2)}%${fin.dividendRate ? ` ($${fin.dividendRate.toFixed(2)}/share)` : ''}`);
      if (fin.payoutRatio !== undefined) lines.push(`• Payout Ratio: ${(fin.payoutRatio * 100).toFixed(0)}%`);
      if (fin.exDividendDate) lines.push(`• Ex-Dividend: ${fin.exDividendDate}`);
      lines.push('');
    }

    // 52-week & short interest
    lines.push('MARKET DATA');
    if (fin.fiftyTwoWeekHigh && fin.fiftyTwoWeekLow) {
      lines.push(`• 52-week range: $${fin.fiftyTwoWeekLow.toFixed(2)} — $${fin.fiftyTwoWeekHigh.toFixed(2)} (current: ${((d.spotPrice - fin.fiftyTwoWeekLow) / (fin.fiftyTwoWeekHigh - fin.fiftyTwoWeekLow) * 100).toFixed(0)}% of range)`);
    }
    if (fin.beta) lines.push(`• Beta: ${fin.beta.toFixed(2)}`);
    if (fin.sharesOutstanding) lines.push(`• Shares Outstanding: ${(fin.sharesOutstanding / 1e6).toFixed(1)}M${fin.floatShares ? ` | Float: ${(fin.floatShares / 1e6).toFixed(1)}M` : ''}`);
    if (fin.shortPercentOfFloat) lines.push(`• Short Interest (% float): ${(fin.shortPercentOfFloat * 100).toFixed(1)}%`);
    lines.push('');

    // Analyst
    lines.push('ANALYST CONSENSUS');
    if (fin.recommendationKey) lines.push(`• Rating: ${fin.recommendationKey.toUpperCase()}${fin.numberOfAnalysts ? ` (${fin.numberOfAnalysts} analysts)` : ''}`);
    if (fin.targetMean) lines.push(`• Price Target — Mean: $${fin.targetMean.toFixed(2)}${fin.targetMedian ? ` | Median: $${fin.targetMedian.toFixed(2)}` : ''} | Low: $${fin.targetLow?.toFixed(2) ?? 'N/A'} | High: $${fin.targetHigh?.toFixed(2) ?? 'N/A'}`);
    if (fin.strongBuy !== undefined) {
      lines.push(`• Distribution: ${fin.strongBuy} Strong Buy | ${fin.buy} Buy | ${fin.hold} Hold | ${fin.sell} Sell | ${fin.strongSell} Strong Sell`);
    }
    lines.push('');

    // Earnings history
    if (fin.earningsHistory && fin.earningsHistory.length > 0) {
      lines.push('RECENT EARNINGS (last 4 quarters)');
      for (const e of fin.earningsHistory) {
        const beat = e.actual > e.estimate;
        const diff = e.actual - e.estimate;
        lines.push(`• ${e.quarter}: EPS $${e.actual.toFixed(2)} vs est. $${e.estimate.toFixed(2)} (${beat ? 'BEAT' : 'MISSED'} by $${Math.abs(diff).toFixed(2)}, ${e.surprisePct > 0 ? '+' : ''}${(e.surprisePct * 100).toFixed(1)}%)`);
      }
      if (fin.nextEarningsDate) lines.push(`• Next earnings: ${fin.nextEarningsDate}`);
      lines.push('');
    }

    financialSection = lines.join('\n');
  } else {
    financialSection = `LIVE FINANCIAL DATA: ⚠️ Not available (Yahoo Finance fetch failed).
Use your training knowledge for financial metrics, but clearly note all figures as estimates and flag your knowledge cutoff.
The CURRENT stock price is ${dollarFmt(d.spotPrice)} — use this as your anchor. Do NOT cite a price from your training data.`;
  }

  return `You are a senior equity research analyst. Generate a comprehensive fundamental analysis report for **${d.symbol}** trading at ${dollarFmt(d.spotPrice)} (${d.changePct > 0 ? '+' : ''}${d.changePct.toFixed(2)}% today).

IMPORTANT: Live financial data has been fetched and is provided below. Use THESE numbers as your primary source — they are current and accurate. Supplement with your knowledge for qualitative analysis (competitive positioning, recent news, growth narratives), but DO NOT override the quantitative data below with numbers from your training data. If your training data conflicts with the live data, trust the live data.

═══════════════════════════════════════════
${financialSection}
═══════════════════════════════════════════

LIVE MARKET DATA
Current price: ${dollarFmt(d.spotPrice)}
Today's change: ${d.changePct > 0 ? '+' : ''}${d.changePct.toFixed(2)}%
Volume: ${(d.volume / 1e6).toFixed(1)}M (${d.avgVolume > 0 ? ((d.volume / d.avgVolume) * 100).toFixed(0) : '?'}% of avg)
IV Rank: ${d.ivRank}/100 | Current IV: ${pctFmt(d.currentIV)} | HV20: ${pctFmt(d.hv20)}
${d.correlations ? `Beta: ${d.correlations.beta.toFixed(2)} | 30d Alpha: ${d.correlations.alpha30d > 0 ? '+' : ''}${(d.correlations.alpha30d * 100).toFixed(1)}%` : ''}

═══════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════

Using the live data above as your foundation, provide a complete equity research report covering:

## 1. COMPANY OVERVIEW
- What the company does, business segments, competitive moat, TAM and market share

## 2. KEY FINANCIAL METRICS
- Present all the live metrics above in a clean, organized format
- Calculate any derived metrics (FCF yield, ROIC, etc.) from the raw data
- Compare key ratios to sector averages where you can

## 3. RECENT EARNINGS
- Analyze the earnings history data provided above
- Add context from your knowledge: what were the key themes from recent calls?
- Note the next earnings date and what to watch for

## 4. GROWTH DRIVERS & CATALYSTS
- Near-term (1-3 months), medium-term (1-2 years), and long-term secular trends
- Product launches, partnerships, strategic initiatives

## 5. RISKS & HEADWINDS
- Operational, competitive, regulatory, macro, and valuation risks

## 6. RECENT NEWS & SENTIMENT
- Notable recent developments (from your knowledge)
- Analyst consensus is provided in the data above — analyze it
- Insider/institutional trends if notable

## 7. VALUATION ASSESSMENT
- Compare current multiples to historical and peer averages
- DCF-based fair value estimate (rough range)
- Bull / Base / Bear case price targets with reasoning

## 8. BOTTOM LINE
- Buy, Hold, or Sell at current levels?
- What would change your mind?
- Conviction level (1-10) with justification

Be specific, data-driven, and balanced. Use the LIVE numbers provided — do not substitute with older data from training. Format with clear headers.`;
}
