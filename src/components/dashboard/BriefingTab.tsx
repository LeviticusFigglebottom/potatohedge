'use client';

import { useState, useCallback } from 'react';
import {
  Newspaper, Loader2, AlertTriangle, TrendingUp, TrendingDown, Minus,
} from 'lucide-react';

interface BriefingResponse {
  analysis: string;
  stocksScanned: number;
  timestamp: number;
  indices: {
    symbol: string;
    price: number;
    changePct: number;
    bias: string;
    biasScore: number;
    gammaRegime: string;
    volRegime: string;
    ivRank: number;
  }[];
  vix: number;
}

function ChangeChip({ pct }: { pct: number }) {
  const color = pct > 0.3 ? 'text-green-400' : pct < -0.3 ? 'text-red-400' : 'text-text-muted';
  const Icon = pct > 0.3 ? TrendingUp : pct < -0.3 ? TrendingDown : Minus;
  return (
    <span className={`flex items-center gap-1 font-mono text-xs ${color}`}>
      <Icon className="w-3 h-3" />
      {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
    </span>
  );
}

function renderInline(text: string): string {
  return text.replace(/\*\*(.*?)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>');
}

function RenderMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="text-sm font-bold text-accent-cyan uppercase tracking-wider mt-6 mb-2 first:mt-0 border-b border-border/20 pb-1">
          {line.slice(3)}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-sm font-semibold text-text-primary mt-4 mb-1">{line.slice(4)}</h3>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={i} className="flex items-start gap-2 text-sm text-text-secondary ml-2 mb-0.5">
          <span className="text-accent-cyan shrink-0 mt-1">{'>'}</span>
          <span className="leading-relaxed" dangerouslySetInnerHTML={{ __html: renderInline(line.slice(2)) }} />
        </div>
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(
        <p key={i} className="text-sm text-text-secondary leading-relaxed mb-1" dangerouslySetInnerHTML={{ __html: renderInline(line) }} />
      );
    }
  }

  return <>{elements}</>;
}

export default function BriefingTab() {
  const [data, setData] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState('');

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPhase('Scanning 21 stocks across indices, sectors, and Mag7...');

    try {
      const phaseTimer = setTimeout(() => setPhase('Analyzing GEX, IV, flow data for each stock...'), 8000);
      const phaseTimer2 = setTimeout(() => setPhase('Sending to Claude for narrative synthesis...'), 25000);
      const phaseTimer3 = setTimeout(() => setPhase('Claude is writing the briefing...'), 40000);

      const res = await fetch('/api/ai/briefing', {
        method: 'POST',
        signal: AbortSignal.timeout(120000),
      });

      clearTimeout(phaseTimer);
      clearTimeout(phaseTimer2);
      clearTimeout(phaseTimer3);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(text); msg = j.error || msg; } catch { if (text.length < 200) msg = text || msg; }
        throw new Error(msg);
      }

      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate briefing');
    } finally {
      setLoading(false);
      setPhase('');
    }
  }, []);

  // Empty state
  if (!data && !loading && !error) {
    return (
      <div className="panel">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Newspaper className="w-12 h-12 text-text-muted/30 mb-4" />
          <h3 className="text-lg font-semibold text-text-secondary mb-2">AI Daily Briefing</h3>
          <p className="text-sm text-text-muted max-w-lg mb-1">
            Runs full GEX/IV/flow analysis on 3 indices, 11 sector ETFs, and the Mag7 —
            then feeds ALL the data to Claude for intelligent cross-market synthesis.
          </p>
          <p className="text-xs text-text-muted/60 mb-6 max-w-lg">
            Identifies sector rotations, gamma regime divergences, IV mispricing,
            unusual positioning, and actionable trade setups.
          </p>
          <button
            onClick={fetchBriefing}
            className="px-6 py-2.5 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all font-medium flex items-center gap-2"
          >
            <Newspaper className="w-5 h-5" />
            Generate AI Briefing
          </button>
          <p className="text-xs text-text-muted/40 mt-3 font-mono">
            Takes ~30-60 seconds (scans 21 stocks + Claude analysis)
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Newspaper className="w-4 h-4 text-accent-cyan" />
            <span className="panel-title">AI Daily Briefing</span>
            {data && (
              <span className="text-xs text-text-muted font-mono">
                {data.stocksScanned} stocks &bull; {new Date(data.timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
          <button
            onClick={fetchBriefing}
            disabled={loading}
            className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-cyan/30 hover:text-accent-cyan transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Newspaper className="w-3.5 h-3.5" />}
            {loading ? 'Generating...' : 'Regenerate'}
          </button>
        </div>
      </div>

      {error && (
        <div className="panel border border-red-500/30 p-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {loading && (
        <div className="panel p-8">
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-8 h-8 animate-spin text-accent-cyan" />
            <div className="text-center">
              <p className="text-sm text-text-secondary font-mono">{phase}</p>
              <p className="text-xs text-text-muted/60 mt-1 font-mono">This can take 30-60 seconds</p>
            </div>
            <div className="w-64 h-1 bg-bg-tertiary rounded-full overflow-hidden">
              <div className="h-full bg-accent-cyan/50 rounded-full animate-pulse" style={{ width: '60%' }} />
            </div>
          </div>
        </div>
      )}

      {data && (
        <>
          {data.indices.length > 0 && (
            <div className="panel overflow-hidden">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border/20">
                {data.indices.map(idx => (
                  <div key={idx.symbol} className="bg-bg-secondary px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-text-muted">{idx.symbol}</span>
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        idx.bias === 'bullish' ? 'bg-green-500/15 text-green-400' :
                        idx.bias === 'bearish' ? 'bg-red-500/15 text-red-400' :
                        'bg-bg-tertiary text-text-muted'
                      }`}>
                        {idx.biasScore > 0 ? '+' : ''}{idx.biasScore}
                      </span>
                    </div>
                    <div className="text-sm font-mono font-semibold text-text-primary">${idx.price.toFixed(2)}</div>
                    <div className="flex items-center justify-between mt-0.5">
                      <ChangeChip pct={idx.changePct} />
                      <span className="text-[10px] font-mono text-text-muted">
                        {idx.gammaRegime}γ IV{idx.ivRank}
                      </span>
                    </div>
                  </div>
                ))}
                {data.vix > 0 && (
                  <div className="bg-bg-secondary px-4 py-3">
                    <div className="text-xs font-mono text-text-muted mb-1">VIX</div>
                    <div className={`text-sm font-mono font-semibold ${data.vix > 25 ? 'text-red-400' : data.vix < 15 ? 'text-green-400' : 'text-text-primary'}`}>
                      {data.vix.toFixed(2)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="panel">
            <div className="px-5 py-4">
              <RenderMarkdown text={data.analysis} />
            </div>
          </div>

          <div className="text-center text-[10px] text-text-muted/40 font-mono py-2">
            Generated by Claude Sonnet &bull; {data.stocksScanned} securities analyzed &bull;
            GEX/IV/Flow computed locally from Tradier + Polygon data
          </div>
        </>
      )}
    </div>
  );
}
