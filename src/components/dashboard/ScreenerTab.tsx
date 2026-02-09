'use client';

import { useState, useCallback, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { STOCK_UNIVERSE } from '@/lib/stockUniverse';
import { Radar, Download, ArrowUpDown, Filter, Loader2, AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { ScreenerResult } from '@/app/api/market/screener/route';

type SortKey = 'symbol' | 'biasScore' | 'spotPrice' | 'changePercent' | 'ivRank' | 'currentIV' | 'volumePCR';
type SortDir = 'asc' | 'desc';
type BiasFilter = 'all' | 'bullish' | 'bearish' | 'extreme';

export default function ScreenerTab() {
  const { loadSymbol, setActiveTab } = useDashboardStore();

  const [results, setResults] = useState<ScreenerResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, current: '' });
  const [sortKey, setSortKey] = useState<SortKey>('biasScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [biasFilter, setBiasFilter] = useState<BiasFilter>('all');
  const [minScore, setMinScore] = useState(0);
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startScan = useCallback(async () => {
    if (scanning) {
      // Abort current scan
      abortRef.current?.abort();
      setScanning(false);
      return;
    }

    setScanning(true);
    setResults([]);
    setProgress({ completed: 0, total: 0, current: '' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/market/screener', { signal: controller.signal });
      if (!res.ok || !res.body) throw new Error('Screener API error');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Accumulate results from progress events so partial scans still
      // show data even if the serverless function times out before 'done'
      const accumulated: ScreenerResult[] = [];
      let gotDone = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));

            if (data.type === 'start') {
              setProgress(p => ({ ...p, total: data.total }));
            } else if (data.type === 'progress') {
              setProgress({ completed: data.completed, total: data.total, current: data.current });
              // Accumulate full results as they stream in
              if (data.result && data.result.symbol) {
                accumulated.push(data.result as ScreenerResult);
                // Update displayed results every 10 stocks so user sees live progress
                if (accumulated.length % 10 === 0) {
                  const sorted = [...accumulated].sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));
                  setResults(sorted);
                }
              }
            } else if (data.type === 'done') {
              // Final sorted results from server (if we get here)
              gotDone = true;
              setResults(data.results);
              setLastScanTime(new Date().toLocaleString());
            }
          } catch { /* skip malformed events */ }
        }
      }

      // If stream ended without 'done' (serverless timeout), finalize accumulated results
      if (!gotDone && accumulated.length > 0) {
        const sorted = accumulated.sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));
        setResults(sorted);
        setLastScanTime(`${new Date().toLocaleString()} (partial: ${accumulated.length} stocks)`);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Screener error:', err);
      }
    } finally {
      setScanning(false);
    }
  }, [scanning]);

  const navigateToStock = useCallback((symbol: string) => {
    loadSymbol(symbol);
    setActiveTab('overview');
  }, [loadSymbol, setActiveTab]);

  // Sort + filter
  const filteredResults = results
    .filter(r => {
      if (minScore > 0 && Math.abs(r.biasScore) < minScore) return false;
      if (biasFilter === 'bullish' && r.overallBias !== 'bullish') return false;
      if (biasFilter === 'bearish' && r.overallBias !== 'bearish') return false;
      if (biasFilter === 'extreme' && Math.abs(r.biasScore) < 30) return false;
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'symbol': cmp = a.symbol.localeCompare(b.symbol); break;
        case 'biasScore': cmp = Math.abs(a.biasScore) - Math.abs(b.biasScore); break;
        case 'spotPrice': cmp = a.spotPrice - b.spotPrice; break;
        case 'changePercent': cmp = a.changePercent - b.changePercent; break;
        case 'ivRank': cmp = a.ivRank - b.ivRank; break;
        case 'currentIV': cmp = a.currentIV - b.currentIV; break;
        case 'volumePCR': cmp = a.volumePCR - b.volumePCR; break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const exportCSV = useCallback(() => {
    if (filteredResults.length === 0) return;

    const headers = ['Symbol', 'Price', 'Change%', 'Bias', 'Score', 'Vol Regime', 'Gamma Regime', 'IV', 'IV Rank', 'PCR', 'Top Signal', 'Gamma Flip', 'Call Wall', 'Put Wall', 'Swap Maturities Today', 'Swap Notional ($M)', 'Days to Cover', 'Reg SHO', 'Warnings'];
    const rows = filteredResults.map(r => [
      r.symbol,
      r.spotPrice.toFixed(2),
      r.changePercent.toFixed(2),
      r.overallBias,
      r.biasScore.toString(),
      r.volRegime,
      r.gammaRegime,
      (r.currentIV * 100).toFixed(1) + '%',
      r.ivRank.toString(),
      r.volumePCR.toFixed(2),
      r.topSignal,
      r.gammaFlip?.toFixed(2) || 'N/A',
      r.callWall?.toFixed(2) || 'N/A',
      r.putWall?.toFixed(2) || 'N/A',
      r.swapMaturitiesToday.toString(),
      (r.swapNotionalToday / 1e6).toFixed(1),
      r.daysToCover > 0 ? r.daysToCover.toFixed(1) : 'N/A',
      r.regSHO ? 'YES' : '',
      r.warnings.join('; '),
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `optix-screener-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredResults]);

  const biasColor = (bias: string, score: number) => {
    if (bias === 'bullish') return score > 40 ? 'text-green-400' : 'text-green-500/80';
    if (bias === 'bearish') return score < -40 ? 'text-red-400' : 'text-red-500/80';
    return 'text-text-muted';
  };

  const biasIcon = (bias: string) => {
    if (bias === 'bullish') return <TrendingUp className="w-3.5 h-3.5" />;
    if (bias === 'bearish') return <TrendingDown className="w-3.5 h-3.5" />;
    return <Minus className="w-3.5 h-3.5" />;
  };

  const scoreBg = (score: number) => {
    const abs = Math.abs(score);
    if (abs >= 50) return score > 0 ? 'bg-green-500/20 border-green-500/30' : 'bg-red-500/20 border-red-500/30';
    if (abs >= 30) return score > 0 ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20';
    return 'bg-bg-tertiary border-border/30';
  };

  const SortHeader = ({ label, sortKeyVal, className = '' }: { label: string; sortKeyVal: SortKey; className?: string }) => (
    <th
      className={`px-3 py-2 text-left text-xs font-mono text-text-muted cursor-pointer hover:text-text-secondary transition-colors ${className}`}
      onClick={() => handleSort(sortKeyVal)}
    >
      <span className="flex items-center gap-1">
        {label}
        {sortKey === sortKeyVal && (
          <ArrowUpDown className={`w-3 h-3 text-accent-cyan ${sortDir === 'asc' ? 'rotate-180' : ''}`} />
        )}
      </span>
    </th>
  );

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Radar className="w-4 h-4 text-accent-cyan" />
            <span className="panel-title">Market Screener</span>
            <span className="text-xs text-text-muted font-mono">
              {STOCK_UNIVERSE.length} stocks
            </span>
          </div>
          <div className="flex items-center gap-3">
            {lastScanTime && (
              <span className="text-xs text-text-muted font-mono">
                Last scan: {lastScanTime}
              </span>
            )}
            <button
              onClick={startScan}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${
                scanning
                  ? 'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30'
                  : 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30'
              }`}
            >
              {scanning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Stop ({progress.completed}/{progress.total})
                </>
              ) : (
                <>
                  <Radar className="w-4 h-4" />
                  Scan All
                </>
              )}
            </button>
          </div>
        </div>

        {/* Progress */}
        {scanning && (
          <div className="px-4 pb-3">
            <div className="flex items-center gap-3 mb-1.5">
              <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-accent-cyan to-accent-purple rounded-full transition-all duration-300"
                  style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                />
              </div>
              <span className="text-xs font-mono text-text-muted min-w-[80px] text-right">
                {progress.completed}/{progress.total}
              </span>
            </div>
            <span className="text-xs font-mono text-accent-cyan">
              Analyzing {progress.current}...
            </span>
          </div>
        )}

        {/* Filters + Export */}
        {results.length > 0 && (
          <div className="px-4 pb-3 flex flex-wrap items-center gap-3 border-t border-border/20 pt-3">
            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-text-muted" />
              <span className="text-xs text-text-muted font-mono">Filter:</span>
            </div>

            <div className="flex items-center gap-1 bg-bg-tertiary rounded-md p-0.5">
              {(['all', 'bullish', 'bearish', 'extreme'] as BiasFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setBiasFilter(f)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-all ${
                    biasFilter === f
                      ? f === 'bullish' ? 'bg-green-500/20 text-green-400'
                        : f === 'bearish' ? 'bg-red-500/20 text-red-400'
                        : f === 'extreme' ? 'bg-purple-500/20 text-purple-400'
                        : 'bg-accent-cyan/20 text-accent-cyan'
                      : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  {f === 'extreme' ? '|Score|>30' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-text-muted font-mono">Min |Score|:</span>
              <input
                type="number"
                value={minScore}
                onChange={(e) => setMinScore(Math.max(0, parseInt(e.target.value) || 0))}
                className="w-14 bg-bg-tertiary border border-border/30 rounded px-2 py-1 text-xs font-mono text-text-primary focus:border-accent-cyan/50 focus:outline-none"
              />
            </div>

            <div className="flex-1" />

            <span className="text-xs text-text-muted font-mono">
              {filteredResults.length}/{results.length} shown
            </span>

            <button
              onClick={exportCSV}
              className="px-3 py-1.5 rounded-md text-xs font-mono bg-bg-tertiary border border-border/30 text-text-secondary hover:border-accent-cyan/30 hover:text-accent-cyan transition-all flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          </div>
        )}
      </div>

      {/* Results Table */}
      {results.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <SortHeader label="Symbol" sortKeyVal="symbol" />
                  <SortHeader label="Price" sortKeyVal="spotPrice" />
                  <SortHeader label="Chg%" sortKeyVal="changePercent" />
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Bias</th>
                  <SortHeader label="|Score|" sortKeyVal="biasScore" />
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Vol</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Gamma</th>
                  <SortHeader label="IV" sortKeyVal="currentIV" />
                  <SortHeader label="IV Rank" sortKeyVal="ivRank" />
                  <SortHeader label="PCR" sortKeyVal="volumePCR" />
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Top Signal</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Key Levels</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Swaps</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">SI/DTC</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.map((r, idx) => (
                  <tr
                    key={r.symbol}
                    className={`border-b border-border/10 hover:bg-bg-hover/50 cursor-pointer transition-colors ${
                      idx % 2 === 0 ? 'bg-bg-secondary/30' : ''
                    }`}
                    onClick={() => navigateToStock(r.symbol)}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-text-primary">{r.symbol}</span>
                        {r.warnings.length > 0 && (
                          <span title={r.warnings.join('\n')}><AlertTriangle className="w-3 h-3 text-yellow-500" /></span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-text-secondary">
                      ${r.spotPrice.toFixed(2)}
                    </td>
                    <td className={`px-3 py-2 font-mono ${r.changePercent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%
                    </td>
                    <td className="px-3 py-2">
                      <span className={`flex items-center gap-1 ${biasColor(r.overallBias, r.biasScore)}`}>
                        {biasIcon(r.overallBias)}
                        <span className="text-xs font-mono capitalize">{r.overallBias}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold border ${scoreBg(r.biasScore)}`}>
                        {r.biasScore > 0 ? '+' : ''}{r.biasScore}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                        r.volRegime === 'high' ? 'bg-orange-500/15 text-orange-400' :
                        r.volRegime === 'low' ? 'bg-blue-500/15 text-blue-400' :
                        'bg-bg-tertiary text-text-muted'
                      }`}>
                        {r.volRegime}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                        r.gammaRegime === 'long' ? 'bg-green-500/15 text-green-400' :
                        r.gammaRegime === 'short' ? 'bg-red-500/15 text-red-400' :
                        'bg-bg-tertiary text-text-muted'
                      }`}>
                        {r.gammaRegime}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-text-secondary text-xs">
                      {(r.currentIV * 100).toFixed(1)}%
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <div className="w-10 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              r.ivRank > 70 ? 'bg-orange-500' : r.ivRank < 30 ? 'bg-blue-400' : 'bg-accent-cyan/60'
                            }`}
                            style={{ width: `${Math.min(100, r.ivRank)}%` }}
                          />
                        </div>
                        <span className="text-xs font-mono text-text-muted">{r.ivRank}</span>
                      </div>
                    </td>
                    <td className={`px-3 py-2 font-mono text-xs ${
                      r.volumePCR > 1.3 ? 'text-red-400' : r.volumePCR < 0.7 ? 'text-green-400' : 'text-text-muted'
                    }`}>
                      {r.volumePCR.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted font-mono max-w-[180px] truncate" title={r.topSignal}>
                      {r.topSignal}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-text-muted">
                      <div className="flex flex-col gap-0.5">
                        {r.gammaFlip && <span>γF: ${r.gammaFlip.toFixed(0)}</span>}
                        {r.callWall && <span className="text-green-500/70">CW: ${r.callWall.toFixed(0)}</span>}
                        {r.putWall && <span className="text-red-500/70">PW: ${r.putWall.toFixed(0)}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-text-muted">
                      {r.swapMaturitiesToday > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          <span className={r.swapMaturitiesToday > 100 ? 'text-orange-400' : ''}>
                            {r.swapMaturitiesToday} today
                          </span>
                          {r.swapNotionalToday > 0 && (
                            <span className="text-text-muted/60">
                              ${(r.swapNotionalToday / 1e6).toFixed(0)}M
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-muted/30">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">
                      <div className="flex flex-col gap-0.5">
                        {r.daysToCover > 0 ? (
                          <span className={r.daysToCover > 5 ? 'text-orange-400' : r.daysToCover > 2 ? 'text-yellow-400' : 'text-text-muted'}>
                            {r.daysToCover.toFixed(1)}d
                          </span>
                        ) : (
                          <span className="text-text-muted/30">—</span>
                        )}
                        {r.regSHO && (
                          <span className="text-red-400 font-semibold" title="On Reg SHO Threshold List — persistent FTDs">
                            RegSHO
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!scanning && results.length === 0 && (
        <div className="panel">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Radar className="w-12 h-12 text-text-muted/30 mb-4" />
            <h3 className="text-lg font-semibold text-text-secondary mb-2">Market Screener</h3>
            <p className="text-sm text-text-muted max-w-md mb-1">
              Scan {STOCK_UNIVERSE.length} stocks across all sectors for extreme directional signals.
              Identifies the strongest bullish and bearish setups based on GEX positioning,
              options flow, IV regime, and dealer exposure.
            </p>
            <p className="text-xs text-text-muted/60 mb-6 max-w-md">
              The consensus bias reflects a <strong>1-7 day</strong> forward outlook based on current
              options market positioning. Scores above |30| are notable; above |50| are extreme.
            </p>
            <button
              onClick={startScan}
              className="px-6 py-2.5 rounded-lg bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all font-medium flex items-center gap-2"
            >
              <Radar className="w-5 h-5" />
              Start Full Scan
            </button>
            <p className="text-xs text-text-muted/40 mt-3 font-mono">
              Takes ~2-4 minutes depending on API response times
            </p>
          </div>
        </div>
      )}

      {/* Stats Summary */}
      {results.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="panel p-3">
            <div className="text-xs text-text-muted font-mono mb-1">Bullish</div>
            <div className="text-xl font-bold text-green-400">
              {results.filter(r => r.overallBias === 'bullish').length}
            </div>
          </div>
          <div className="panel p-3">
            <div className="text-xs text-text-muted font-mono mb-1">Bearish</div>
            <div className="text-xl font-bold text-red-400">
              {results.filter(r => r.overallBias === 'bearish').length}
            </div>
          </div>
          <div className="panel p-3">
            <div className="text-xs text-text-muted font-mono mb-1">Neutral</div>
            <div className="text-xl font-bold text-text-muted">
              {results.filter(r => r.overallBias === 'neutral').length}
            </div>
          </div>
          <div className="panel p-3">
            <div className="text-xs text-text-muted font-mono mb-1">Extreme (|Score|{'>'}50)</div>
            <div className="text-xl font-bold text-purple-400">
              {results.filter(r => Math.abs(r.biasScore) > 50).length}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
