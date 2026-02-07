'use client';

import { useState, useCallback, useEffect } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { Sparkles, AlertTriangle, Loader2, RefreshCw, Brain } from 'lucide-react';

export default function AIAnalysisPanel() {
  const {
    symbol, quote, multiGEX, snapshot, recommendations, correlations,
  } = useDashboardStore();

  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>('');
  const [tokens, setTokens] = useState<{ input: number; output: number } | null>(null);

  // Reset when ticker changes
  useEffect(() => {
    setAnalysis(null);
    setError(null);
    setModel('');
    setTokens(null);
  }, [symbol]);

  const runAnalysis = useCallback(async () => {
    if (!quote || !multiGEX) {
      setError('Wait for market data to load first.');
      return;
    }

    setLoading(true);
    setError(null);
    setAnalysis(null);

    try {
      // Collect ALL available data into the payload
      const payload = {
        symbol,
        spotPrice: quote.last,
        change: quote.change,
        changePct: quote.changePct,
        volume: quote.volume,
        avgVolume: quote.avgVolume,
        bid: quote.bid,
        ask: quote.ask,

        // Dealer
        totalGEX: multiGEX.aggregated.totalGEX,
        totalDEX: multiGEX.aggregated.totalDEX,
        totalVanna: multiGEX.aggregated.totalVanna,
        totalCharm: multiGEX.aggregated.totalCharm,
        gammaFlip: multiGEX.aggregated.gammaFlip,
        callWall: multiGEX.aggregated.callWall,
        putWall: multiGEX.aggregated.putWall,
        maxPain: multiGEX.maxPain.strike,

        perExpiration: multiGEX.perExpiration.map(e => ({
          exp: e.expiration,
          dte: e.dte,
          gex: e.totalGEX,
          dex: e.totalDEX,
          vanna: e.totalVanna,
          charm: e.totalCharm,
          pcr: e.volumePCR,
          callVol: e.callVolume,
          putVol: e.putVolume,
        })),

        // Volume
        volumePCR: multiGEX.volume.volumePCR,
        oiPCR: multiGEX.volume.oiPCR,
        totalCallVol: multiGEX.volume.totalCallVol,
        totalPutVol: multiGEX.volume.totalPutVol,
        totalCallOI: multiGEX.volume.totalCallOI,
        totalPutOI: multiGEX.volume.totalPutOI,

        // IV
        currentIV: snapshot?.iv.currentIV ?? 0,
        ivRank: snapshot?.iv.ivRank ?? 0,
        ivPercentile: snapshot?.iv.ivPercentile ?? 0,
        iv30dMA: snapshot?.iv.iv30dMA ?? 0,
        iv52wHigh: snapshot?.iv.iv52wHigh ?? 0,
        iv52wLow: snapshot?.iv.iv52wLow ?? 0,
        hv20: snapshot?.historicalVol.hv20 ?? 0,
        hv60: snapshot?.historicalVol.hv60 ?? 0,
        ivHvRatio: snapshot?.iv.ivHvRatio ?? 0,

        termStructure: (snapshot?.termStructure ?? []).map(t => ({
          exp: t.expiration,
          dte: t.dte,
          atmIV: t.atmIV,
        })),

        // Skew
        skewBias: multiGEX.context.skew.skewBias,
        skewRatio: multiGEX.context.skew.skewRatio,

        // ATR (from recommendations if available)
        atr14: 0,
        atrPercent: 0,
        dailySigma: 0,
        avgDailyRangePct: 0,

        // Context
        dealerContext: multiGEX.context.dealer.interpretation,
        volumeContext: multiGEX.context.volume.interpretation,
        skewContext: multiGEX.context.skew.interpretation,
        oiContext: multiGEX.context.oi.interpretation,
        ivContext: snapshot?.iv.interpretation ?? '',

        // Recommendations engine output
        overallBias: recommendations?.overallBias ?? 'unknown',
        biasScore: recommendations?.biasScore ?? 0,
        volRegime: recommendations?.volRegime ?? 'unknown',
        gammaRegime: recommendations?.gammaRegime ?? 'unknown',
        signals: recommendations?.signals ?? [],
        engineTrades: (recommendations?.trades ?? []).map(t => ({
          strategy: t.strategy,
          direction: t.direction,
          score: t.score,
          reasoning: t.reasoning,
        })),
        warnings: recommendations?.warnings ?? [],
        moveContext: recommendations?.moveContext ?? '',
        stockContext: recommendations?.stockContext ?? '',

        // Correlations
        correlations: correlations ? {
          beta: correlations.marketRelative.beta,
          marketCorrelation: correlations.marketRelative.correlation,
          alpha30d: correlations.marketRelative.alpha30d,
          alpha90d: correlations.marketRelative.alpha90d,
          drawdownRatio: correlations.marketRelative.drawdownBehavior.ratio,
          rallyRatio: correlations.marketRelative.rallyBehavior.ratio,
          ivRegime: {
            lowVolAvg20d: correlations.ivRegime.lowIV.avgReturn20d,
            highVolAvg20d: correlations.ivRegime.highIV.avgReturn20d,
            lowVolWinRate: correlations.ivRegime.lowIV.winRate5d,
            insight: correlations.ivRegime.insight,
          },
          volPricing: {
            overPricingRate: correlations.volPricing.overPricingRate,
            avgImpliedMove: correlations.volPricing.avgImpliedMove,
            avgRealizedMove: correlations.volPricing.avgRealizedMove,
            insight: correlations.volPricing.insight,
          },
          meanReversion: {
            bounceRateAfterDrops: correlations.meanReversion.afterBigDown.reversalRate,
            pullbackRateAfterRallies: correlations.meanReversion.afterBigUp.reversalRate,
            avgRecovery5d: correlations.meanReversion.afterBigDown.avgNext5dReturn,
            insight: correlations.meanReversion.insight,
          },
          sectorRelative: correlations.sectorRelative ? {
            sectorETF: correlations.sectorRelative.sectorETF,
            sectorCorrelation: correlations.sectorRelative.correlation,
            relativeStrength30d: correlations.sectorRelative.relativeStrength30d,
            divergenceDays: correlations.sectorRelative.divergenceDays,
            insight: correlations.sectorRelative.insight,
          } : null,
          anomalies: correlations.anomalies.map(a => a.description),
          strongestInsights: correlations.strongestInsights.slice(0, 6).map(i => `${i.label}: ${i.value}`),
        } : null,
      };

      // Parse stockContext to extract ATR values if available
      if (recommendations?.stockContext) {
        const atrMatch = recommendations.stockContext.match(/([\d.]+)% daily ATR \(\$([\d.]+)\)/);
        if (atrMatch) {
          payload.atrPercent = parseFloat(atrMatch[1]);
          payload.atr14 = parseFloat(atrMatch[2]);
        }
        const sigmaMatch = recommendations.stockContext.match(/([\d.]+)% daily 1σ/);
        if (sigmaMatch) {
          payload.dailySigma = parseFloat(sigmaMatch[1]);
        }
      }
      if (recommendations?.moveContext) {
        const rangeMatch = recommendations.moveContext.match(/Avg daily range: ([\d.]+)%/);
        if (rangeMatch) {
          payload.avgDailyRangePct = parseFloat(rangeMatch[1]);
        }
      }

      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const result = await res.json();
      setAnalysis(result.analysis);
      setModel(result.model || '');
      setTokens(result.usage ? { input: result.usage.input_tokens, output: result.usage.output_tokens } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, [symbol, quote, multiGEX, snapshot, recommendations, correlations]);

  // Don't show if no data
  if (!quote) return null;

  return (
    <div className="space-y-3">
      {/* Trigger Button */}
      {!analysis && !loading && (
        <button
          onClick={runAnalysis}
          disabled={!multiGEX}
          className={`w-full group relative overflow-hidden rounded-lg border transition-all duration-300 ${
            multiGEX
              ? 'border-purple-500/40 hover:border-purple-400/60 bg-gradient-to-r from-purple-500/10 via-bg-secondary to-purple-500/10 hover:from-purple-500/20 hover:via-purple-500/5 hover:to-purple-500/20 cursor-pointer'
              : 'border-border/30 bg-bg-secondary opacity-50 cursor-not-allowed'
          }`}
        >
          <div className="px-6 py-4 flex items-center justify-center gap-3">
            <Brain className={`w-5 h-5 ${multiGEX ? 'text-purple-400 group-hover:text-purple-300' : 'text-text-muted'}`} />
            <div className="text-left">
              <span className={`text-sm font-semibold ${multiGEX ? 'text-purple-300 group-hover:text-purple-200' : 'text-text-muted'}`}>
                Ask Claude to Analyze {symbol}
              </span>
              <p className="text-xs text-text-muted mt-0.5">
                {multiGEX
                  ? 'Sends all GEX, IV, flow, dealer, volatility, and correlation data to Claude for deep analysis'
                  : 'Waiting for market data to load...'}
              </p>
            </div>
            <Sparkles className={`w-4 h-4 ${multiGEX ? 'text-purple-400/60' : 'text-text-muted/40'}`} />
          </div>
          {/* Animated gradient border effect */}
          {multiGEX && (
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
              <div className="absolute inset-[-1px] rounded-lg bg-gradient-to-r from-purple-500/20 via-cyan-500/10 to-purple-500/20 blur-sm" />
            </div>
          )}
        </button>
      )}

      {/* Loading State */}
      {loading && (
        <div className="panel border border-purple-500/30">
          <div className="px-6 py-8 flex flex-col items-center gap-4">
            <div className="relative">
              <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
              <Sparkles className="w-4 h-4 text-purple-300 absolute -top-1 -right-1 animate-pulse" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-purple-300">Claude is analyzing {symbol}...</p>
              <p className="text-xs text-text-muted mt-1">
                Processing dealer positioning, volatility surface, options flow, and ATR profile
              </p>
            </div>
            <div className="flex gap-2 flex-wrap justify-center mt-2">
              {['GEX/DEX', 'IV Rank', 'Term Structure', 'Skew', 'PCR', 'ATR', 'Key Levels', 'Correlations'].map(tag => (
                <span key={tag} className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-300/60 border border-purple-500/20">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="panel border border-accent-red/30 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-accent-red shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm text-accent-red font-semibold">Analysis Failed</p>
            <p className="text-xs text-text-muted mt-0.5">{error}</p>
          </div>
          <button onClick={runAnalysis} className="text-xs text-accent-cyan hover:underline shrink-0">
            Retry
          </button>
        </div>
      )}

      {/* Analysis Result */}
      {analysis && (
        <div className="panel border border-purple-500/30 animate-fade-in">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-purple-400" />
              <span className="text-xs font-mono font-semibold text-purple-300 uppercase tracking-wider">
                Claude Analysis — {symbol}
              </span>
              {model && (
                <span className="text-[10px] font-mono text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded">
                  {model.replace('claude-', '').replace(/-\d{8}$/, '')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {tokens && (
                <span className="text-[10px] font-mono text-text-muted">
                  {(tokens.input + tokens.output).toLocaleString()} tokens
                </span>
              )}
              <button
                onClick={runAnalysis}
                className="flex items-center gap-1.5 text-xs font-mono text-purple-400 hover:text-purple-300 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                Re-analyze
              </button>
            </div>
          </div>

          {/* Content — rendered as formatted text */}
          <div className="px-5 py-4 ai-analysis-content">
            <AnalysisRenderer text={analysis} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Parse Claude's markdown-like response into styled React elements */
function AnalysisRenderer({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      elements.push(<div key={key++} className="h-2" />);
      continue;
    }

    // Headers (## or **HEADER**)
    if (trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
      const level = trimmed.startsWith('### ') ? 3 : 2;
      const text = trimmed.replace(/^#{2,3}\s+/, '');
      elements.push(
        <h3 key={key++} className={`${level === 2 ? 'text-sm font-bold text-purple-300 mt-4 mb-2 uppercase tracking-wider border-b border-purple-500/20 pb-1' : 'text-sm font-semibold text-text-primary mt-3 mb-1'}`}>
          {text}
        </h3>
      );
      continue;
    }

    // Bold headers like **MARKET REGIME SUMMARY**
    if (/^\*\*[A-Z][^*]+\*\*$/.test(trimmed)) {
      const text = trimmed.replace(/\*\*/g, '');
      elements.push(
        <h3 key={key++} className="text-sm font-bold text-purple-300 mt-4 mb-2 uppercase tracking-wider border-b border-purple-500/20 pb-1">
          {text}
        </h3>
      );
      continue;
    }

    // Numbered items (1. **Strategy** — ...)
    if (/^\d+\.\s/.test(trimmed)) {
      elements.push(
        <div key={key++} className="text-sm text-text-secondary leading-relaxed ml-2 mb-1">
          <InlineFormatter text={trimmed} />
        </div>
      );
      continue;
    }

    // Bullet points
    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      const content = trimmed.replace(/^[-•*]\s+/, '');
      elements.push(
        <div key={key++} className="flex items-start gap-2 ml-3 mb-1">
          <span className="text-purple-400/60 mt-1 shrink-0 text-[10px]">▸</span>
          <span className="text-sm text-text-secondary leading-relaxed">
            <InlineFormatter text={content} />
          </span>
        </div>
      );
      continue;
    }

    // Horizontal rules
    if (/^[-=─═]{3,}$/.test(trimmed)) {
      elements.push(<hr key={key++} className="border-border/30 my-3" />);
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={key++} className="text-sm text-text-secondary leading-relaxed mb-1">
        <InlineFormatter text={trimmed} />
      </p>
    );
  }

  return <div>{elements}</div>;
}

/** Handle inline formatting: **bold**, `code`, numbers with $ */
function InlineFormatter({ text }: { text: string }) {
  // Split on bold markers and code markers
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\$\d[\d,.]+)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="text-text-primary font-semibold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code key={i} className="text-accent-cyan font-mono text-xs bg-bg-tertiary px-1 py-0.5 rounded">{part.slice(1, -1)}</code>;
        }
        // Highlight dollar amounts
        if (/^\$\d/.test(part)) {
          return <span key={i} className="text-accent-cyan font-mono">{part}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
