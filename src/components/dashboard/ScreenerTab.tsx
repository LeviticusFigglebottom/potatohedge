'use client';

import { useState, useCallback, useRef } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { STOCK_UNIVERSE, getTop500Symbols, getUniverseSymbols } from '@/lib/stockUniverse';
import { Radar, Download, ArrowUpDown, Filter, Loader2, AlertTriangle, TrendingUp, TrendingDown, Minus, Crosshair, CheckCircle2, ListChecks } from 'lucide-react';
import type { ScreenerResult } from '@/app/api/market/screener/route';
import { addSignal, loadSignals } from '@/lib/signalTracker';

type SortKey = 'symbol' | 'biasScore' | 'spotPrice' | 'changePercent' | 'ivRank' | 'currentIV' | 'volumePCR';
type SortDir = 'asc' | 'desc';
type BiasFilter = 'all' | 'bullish' | 'bearish' | 'extreme';

const SCREENER_CACHE_KEY = 'optix-screener-cache';

function loadScreenerCache(): { results: ScreenerResult[]; timestamp: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SCREENER_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveScreenerCache(results: ScreenerResult[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SCREENER_CACHE_KEY, JSON.stringify({ results, timestamp: Date.now() }));
  } catch { /* storage full or unavailable */ }
}

function formatAge(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

export default function ScreenerTab() {
  const { loadSymbol, setActiveTab } = useDashboardStore();

  const [results, setResults] = useState<ScreenerResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0, current: '' });
  const [sortKey, setSortKey] = useState<SortKey>('biasScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [biasFilter, setBiasFilter] = useState<BiasFilter>('all');
  const [minScore, setMinScore] = useState(0);
  const [scanTimestamp, setScanTimestamp] = useState<number | null>(null);
  const [trackedSymbols, setTrackedSymbols] = useState<Set<string>>(new Set());
  const [includeRetail, setIncludeRetail] = useState(false);
  const [scanLog, setScanLog] = useState<{ chunk: number; sent: number; received: number; ms: number; error?: string; retry?: number }[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Load cached screener results + tracked symbols on mount
  useState(() => {
    const existing = loadSignals();
    setTrackedSymbols(new Set(existing.map(s => s.symbol)));
    const cached = loadScreenerCache();
    if (cached && cached.results.length > 0) {
      setResults(cached.results);
      setScanTimestamp(cached.timestamp);
    }
  });

  // Process one SSE stream chunk, accumulating results
  const processStream = useCallback(async (
    res: Response,
    accumulated: ScreenerResult[],
    globalOffset: number,
    globalTotal: number,
    signal: AbortSignal,
  ) => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (signal.aborted) { reader.cancel(); break; }
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));

          if (data.type === 'progress') {
            setProgress({
              completed: globalOffset + data.completed,
              total: globalTotal,
              current: data.current,
            });
            if (data.result && data.result.symbol) {
              accumulated.push(data.result as ScreenerResult);
              // Live-update displayed results every 10 stocks
              if (accumulated.length % 10 === 0) {
                const sorted = [...accumulated].sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));
                setResults(sorted);
              }
            }
          } else if (data.type === 'done' && data.results) {
            // Server sent final sorted results for this chunk — merge any we missed
            for (const r of data.results as ScreenerResult[]) {
              if (!accumulated.some(a => a.symbol === r.symbol)) {
                accumulated.push(r);
              }
            }
          }
        } catch { /* skip malformed events */ }
      }
    }
  }, []);

  const CHUNK_SIZE = 20; // 20 stocks per chunk — Tradier rate limits need smaller batches

  /**
   * Scan a single chunk of symbols, returning the number of results received.
   * Appends results to `accumulated`, logs to `chunkLog`, and updates state.
   */
  const scanChunk = useCallback(async (
    symbols: string[],
    chunkIdx: number,
    accumulated: ScreenerResult[],
    chunkLog: { chunk: number; sent: number; received: number; ms: number; error?: string; retry?: number }[],
    globalOffset: number,
    globalTotal: number,
    controller: AbortController,
    retryPass?: number,
  ): Promise<number> => {
    const scanUrl = `/api/market/screener?symbols=${symbols.join(',')}`;
    const beforeCount = accumulated.length;
    const chunkStart = Date.now();

    // Per-chunk abort: auto-timeout at 55s (Vercel kills at 60s) + user abort
    const chunkAbort = new AbortController();
    const timeout = setTimeout(() => chunkAbort.abort(), 55000);
    const onMainAbort = () => chunkAbort.abort();
    controller.signal.addEventListener('abort', onMainAbort);

    try {
      const res = await fetch(scanUrl, { signal: chunkAbort.signal });
      if (!res.ok || !res.body) {
        chunkLog.push({ chunk: chunkIdx, sent: symbols.length, received: 0, ms: Date.now() - chunkStart, error: `HTTP ${res.status}`, retry: retryPass });
        setScanLog([...chunkLog]);
        return 0;
      }

      await processStream(res, accumulated, globalOffset, globalTotal, chunkAbort.signal);
      const received = accumulated.length - beforeCount;
      chunkLog.push({ chunk: chunkIdx, sent: symbols.length, received, ms: Date.now() - chunkStart, retry: retryPass });
      setScanLog([...chunkLog]);
      return received;
    } catch (err) {
      // Propagate user abort but handle chunk timeout gracefully
      if ((err as Error).name === 'AbortError' && controller.signal.aborted) throw err;
      const received = accumulated.length - beforeCount;
      const isTimeout = (err as Error).name === 'AbortError' && !controller.signal.aborted;
      chunkLog.push({
        chunk: chunkIdx, sent: symbols.length, received,
        ms: Date.now() - chunkStart,
        error: isTimeout ? 'timeout (55s)' : (err as Error).message,
        retry: retryPass,
      });
      setScanLog([...chunkLog]);
      return received;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onMainAbort);
    }
  }, [processStream]);

  const startScan = useCallback(async () => {
    if (scanning) {
      abortRef.current?.abort();
      setScanning(false);
      return;
    }

    setScanning(true);
    setResults([]);
    setScanLog([]);

    const controller = new AbortController();
    abortRef.current = controller;

    const allSymbols = includeRetail ? getUniverseSymbols() : getTop500Symbols();
    setProgress({ completed: 0, total: allSymbols.length, current: '' });

    const accumulated: ScreenerResult[] = [];
    const chunkLog: { chunk: number; sent: number; received: number; ms: number; error?: string; retry?: number }[] = [];
    let chunkCounter = 0;

    try {
      // ═══════════════════════════════════════════════════
      // PASS 1: Initial scan of all symbols
      // ═══════════════════════════════════════════════════
      let consecutiveEmpty = 0;

      for (let i = 0; i < allSymbols.length; i += CHUNK_SIZE) {
        if (controller.signal.aborted) break;

        const chunk = allSymbols.slice(i, i + CHUNK_SIZE);
        chunkCounter++;
        const totalChunks = Math.ceil(allSymbols.length / CHUNK_SIZE);

        const received = await scanChunk(chunk, chunkCounter, accumulated, chunkLog, i, allSymbols.length, controller);
        console.log(`[Screener] Chunk ${chunkCounter}/${totalChunks}: ${received}/${chunk.length} in pass 1`);

        // Track empty responses for adaptive pacing
        if (received === 0) {
          consecutiveEmpty++;
        } else {
          consecutiveEmpty = 0;
        }

        // Inter-chunk delay — Tradier needs generous pacing between chunks
        if (i + CHUNK_SIZE < allSymbols.length && !controller.signal.aborted) {
          if (consecutiveEmpty >= 3) {
            setProgress(p => ({ ...p, current: `API cooldown — pausing 15s (${accumulated.length} stocks so far)` }));
            await new Promise(r => setTimeout(r, 15000));
            consecutiveEmpty = 0;
          } else if (consecutiveEmpty >= 1) {
            setProgress(p => ({ ...p, current: `Rate limit recovery — pausing 8s...` }));
            await new Promise(r => setTimeout(r, 8000));
          } else {
            // Normal: 5s gap between chunks for Tradier rate limit headroom
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      // ═══════════════════════════════════════════════════
      // PASS 2+3: Retry any missed symbols
      // ═══════════════════════════════════════════════════
      const MAX_RETRY_PASSES = 2;

      for (let retryPass = 1; retryPass <= MAX_RETRY_PASSES; retryPass++) {
        if (controller.signal.aborted) break;

        // Find symbols that weren't in any accumulated result
        const scannedSymbols = new Set(accumulated.map(r => r.symbol));
        const missed = allSymbols.filter(s => !scannedSymbols.has(s));

        if (missed.length === 0) {
          console.log(`[Screener] All ${allSymbols.length} symbols scanned — no retry needed`);
          break;
        }

        console.log(`[Screener] Retry pass ${retryPass}: ${missed.length} missed symbols`);
        setProgress(p => ({
          ...p,
          current: `Retrying ${missed.length} missed stocks (pass ${retryPass}/${MAX_RETRY_PASSES}) — cooling down 5s...`,
        }));

        // Brief cooldown before retry
        await new Promise(r => setTimeout(r, 5000));

        consecutiveEmpty = 0;
        for (let i = 0; i < missed.length; i += CHUNK_SIZE) {
          if (controller.signal.aborted) break;

          const chunk = missed.slice(i, i + CHUNK_SIZE);
          chunkCounter++;

          const received = await scanChunk(chunk, chunkCounter, accumulated, chunkLog, 0, allSymbols.length, controller, retryPass);
          console.log(`[Screener] Retry ${retryPass} chunk: ${received}/${chunk.length}`);

          // Update live results
          if (accumulated.length > 0 && accumulated.length % 5 === 0) {
            const sorted = [...accumulated].sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));
            setResults(sorted);
          }

          if (received === 0) consecutiveEmpty++;
          else consecutiveEmpty = 0;

          // Generous delays during retries — Tradier rate limits need recovery time
          if (i + CHUNK_SIZE < missed.length && !controller.signal.aborted) {
            if (consecutiveEmpty >= 2) {
              setProgress(p => ({ ...p, current: `Pausing 10s before next retry chunk...` }));
              await new Promise(r => setTimeout(r, 10000));
              consecutiveEmpty = 0;
            } else {
              await new Promise(r => setTimeout(r, 5000));
            }
          }
        }

        setProgress(p => ({ ...p, completed: accumulated.length }));
      }

      // ═══════════════════════════════════════════════════
      // Finalize and persist
      // ═══════════════════════════════════════════════════
      const scannedFinal = new Set(accumulated.map(r => r.symbol));
      const stillMissed = allSymbols.filter(s => !scannedFinal.has(s));
      if (stillMissed.length > 0) {
        console.warn(`[Screener] ${stillMissed.length} symbols still missed after retries: ${stillMissed.slice(0, 10).join(', ')}...`);
      }

      if (accumulated.length > 0) {
        const sorted = accumulated.sort((a, b) => Math.abs(b.biasScore) - Math.abs(a.biasScore));
        setResults(sorted);
        saveScreenerCache(sorted);
      }
      setScanTimestamp(Date.now());
    } catch (err) {
      if ((err as Error).name === 'AbortError') { /* expected */ }
    } finally {
      setScanning(false);
    }
  }, [scanning, includeRetail, scanChunk]);

  const navigateToStock = useCallback((symbol: string) => {
    loadSymbol(symbol);
    setActiveTab('overview');
  }, [loadSymbol, setActiveTab]);

  const handleTrackSignal = useCallback(async (r: ScreenerResult, e: React.MouseEvent) => {
    e.stopPropagation();
    // Fetch fresh quote — entry price MUST be current
    let entryPrice = 0;
    try {
      const res = await fetch(`/api/market/quote?symbol=${r.symbol}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const q = await res.json();
        if (q.last > 0) entryPrice = q.last;
      }
    } catch { /* will check below */ }

    if (entryPrice <= 0) {
      console.warn(`Signal Tracker: could not get fresh price for ${r.symbol}, skipping`);
      return;
    }

    addSignal({
      symbol: r.symbol,
      entryPrice,
      bias: r.overallBias,
      biasScore: r.biasScore,
      gammaRegime: r.gammaRegime,
      volRegime: r.volRegime,
      ivRank: r.ivRank,
      topSignal: r.topSignal,
      gammaFlip: r.gammaFlip,
      callWall: r.callWall,
      putWall: r.putWall,
      source: 'screener',
    });
    setTrackedSymbols(prev => new Set(prev).add(r.symbol));
  }, []);

  const [trackingAll, setTrackingAll] = useState(false);

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

  const handleTrackAll = useCallback(async () => {
    // Only track high-conviction signals: |score| >= 50
    const untracked = filteredResults.filter(r => !trackedSymbols.has(r.symbol) && Math.abs(r.biasScore) >= 50);
    if (untracked.length === 0) return;

    setTrackingAll(true);
    try {
      // Batch-fetch fresh quotes — 40 symbols per request to stay within API limits
      const symbols = untracked.map(r => r.symbol);
      const freshPrices: Record<string, number> = {};
      const BATCH_SIZE = 40;

      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        try {
          const res = await fetch(`/api/market/quotes?symbols=${batch.join(',')}`, {
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data)) {
              for (const q of data) {
                if (q.symbol && q.last > 0) freshPrices[q.symbol] = q.last;
              }
            }
          }
        } catch { /* continue with next batch */ }
      }

      const newTracked = new Set(trackedSymbols);
      let skippedNoPrice = 0;
      for (const r of untracked) {
        const price = freshPrices[r.symbol];
        // Only track if we got a fresh price — never use stale scan data
        if (!price || price <= 0) {
          skippedNoPrice++;
          continue;
        }
        addSignal({
          symbol: r.symbol,
          entryPrice: price,
          bias: r.overallBias,
          biasScore: r.biasScore,
          gammaRegime: r.gammaRegime,
          volRegime: r.volRegime,
          ivRank: r.ivRank,
          topSignal: r.topSignal,
          gammaFlip: r.gammaFlip,
          callWall: r.callWall,
          putWall: r.putWall,
          source: 'screener',
        });
        newTracked.add(r.symbol);
      }
      if (skippedNoPrice > 0) {
        console.warn(`Signal Tracker: skipped ${skippedNoPrice} stocks (no fresh price available)`);
      }
      setTrackedSymbols(newTracked);
    } finally {
      setTrackingAll(false);
    }
  }, [filteredResults, trackedSymbols]);

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
              {includeRetail ? STOCK_UNIVERSE.length : getTop500Symbols().length} stocks
            </span>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs font-mono text-text-muted cursor-pointer select-none" title="Include smaller-cap retail favorites (adds ~50 stocks)">
              <input
                type="checkbox"
                checked={includeRetail}
                onChange={(e) => setIncludeRetail(e.target.checked)}
                disabled={scanning}
                className="accent-accent-cyan"
              />
              +Retail
            </label>
            {scanTimestamp && (
              <span className={`text-xs font-mono ${Date.now() - scanTimestamp > 3600000 ? 'text-yellow-400' : 'text-text-muted'}`}
                title={new Date(scanTimestamp).toLocaleString()}>
                Scanned: {formatAge(scanTimestamp)}
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

        {/* Chunk Log (scan debugging) */}
        {scanLog.length > 0 && (
          <div className="px-4 pb-3 border-t border-border/20 pt-2">
            <details className="text-xs font-mono">
              <summary className="text-text-muted cursor-pointer hover:text-text-secondary">
                Scan Log: {scanLog.reduce((s, c) => s + c.received, 0)} stocks from {scanLog.length} chunks
                {scanLog.some(c => c.retry) && <span className="text-accent-cyan ml-2">(+{scanLog.filter(c => c.retry).length} retries)</span>}
                {scanLog.some(c => c.error) && <span className="text-yellow-400 ml-2">({scanLog.filter(c => c.error).length} errors)</span>}
              </summary>
              <div className="mt-1.5 space-y-0.5">
                {scanLog.map((c, i) => (
                  <div key={i} className={`flex items-center gap-2 ${c.error ? 'text-yellow-400' : c.received === c.sent ? 'text-text-muted' : 'text-amber-400/70'}`}>
                    <span>{c.retry ? `Retry${c.retry}` : 'Chunk'} {c.chunk}:</span>
                    <span>{c.received}/{c.sent}</span>
                    <span className="text-text-muted/50">{(c.ms / 1000).toFixed(1)}s</span>
                    {c.error && <span className="text-red-400 truncate">{c.error}</span>}
                    {!c.error && c.received < c.sent && <span className="text-amber-400/50">(rate limited)</span>}
                  </div>
                ))}
              </div>
            </details>
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
              onClick={handleTrackAll}
              disabled={trackingAll || filteredResults.filter(r => !trackedSymbols.has(r.symbol) && Math.abs(r.biasScore) >= 50).length === 0}
              className="px-3 py-1.5 rounded-md text-xs font-mono bg-accent-cyan/10 border border-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/20 transition-all flex items-center gap-1.5 disabled:opacity-40"
              title="Track all stocks with |Score| >= 50"
            >
              <ListChecks className="w-3.5 h-3.5" />
              {trackingAll ? 'Tracking...' : `Track |50|+ (${filteredResults.filter(r => !trackedSymbols.has(r.symbol) && Math.abs(r.biasScore) >= 50).length})`}
            </button>
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

      {/* Results — Mobile Card Layout */}
      {results.length > 0 && (
        <div className="md:hidden space-y-2">
          {filteredResults.slice(0, 50).map(r => (
            <div
              key={r.symbol}
              className="panel p-3 cursor-pointer hover:border-accent-cyan/30 transition-colors"
              onClick={() => navigateToStock(r.symbol)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-text-primary text-sm">{r.symbol}</span>
                  <span className={`flex items-center gap-0.5 ${biasColor(r.overallBias, r.biasScore)}`}>
                    {biasIcon(r.overallBias)}
                    <span className="text-[10px] font-mono capitalize">{r.overallBias}</span>
                  </span>
                  {r.warnings.length > 0 && <AlertTriangle className="w-3 h-3 text-yellow-500" />}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold border ${scoreBg(r.biasScore)}`}>
                    {r.biasScore > 0 ? '+' : ''}{r.biasScore}
                  </span>
                  {trackedSymbols.has(r.symbol) ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-accent-cyan" />
                  ) : (
                    <button onClick={(e) => handleTrackSignal(r, e)} className="p-0.5 text-text-muted hover:text-accent-cyan">
                      <Crosshair className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs font-mono">
                <div>
                  <div className="text-[9px] text-text-muted">Price</div>
                  <div className="text-text-secondary">${r.spotPrice.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-[9px] text-text-muted">Change</div>
                  <div className={r.changePercent >= 0 ? 'text-green-400' : 'text-red-400'}>
                    {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-text-muted">IV Rank</div>
                  <div className="flex items-center gap-1">
                    <div className="w-8 h-1 bg-bg-tertiary rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${r.ivRank > 70 ? 'bg-orange-500' : r.ivRank < 30 ? 'bg-blue-400' : 'bg-accent-cyan/60'}`} style={{ width: `${Math.min(100, r.ivRank)}%` }} />
                    </div>
                    <span className="text-text-muted">{r.ivRank}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-text-muted">PCR</div>
                  <div className={r.volumePCR > 1.3 ? 'text-red-400' : r.volumePCR < 0.7 ? 'text-green-400' : 'text-text-muted'}>{r.volumePCR.toFixed(2)}</div>
                </div>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                    r.volRegime === 'high' ? 'bg-orange-500/15 text-orange-400' : r.volRegime === 'low' ? 'bg-blue-500/15 text-blue-400' : 'bg-bg-tertiary text-text-muted'
                  }`}>{r.volRegime} vol</span>
                  <span className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                    r.gammaRegime === 'long' ? 'bg-green-500/15 text-green-400' : r.gammaRegime === 'short' ? 'bg-red-500/15 text-red-400' : 'bg-bg-tertiary text-text-muted'
                  }`}>{r.gammaRegime}γ</span>
                </div>
                <span className="text-[10px] font-mono text-text-muted truncate max-w-[120px]">{r.topSignal}</span>
              </div>
            </div>
          ))}
          {filteredResults.length > 50 && (
            <div className="text-center text-xs font-mono text-text-muted py-2">
              Showing 50 of {filteredResults.length} — use desktop for full table
            </div>
          )}
        </div>
      )}

      {/* Results Table — Desktop */}
      {results.length > 0 && (
        <div className="panel overflow-hidden hidden md:block">
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
                  <th className="px-3 py-2 text-center text-xs font-mono text-text-muted w-16">Track</th>
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
                    <td className="px-3 py-2 text-center">
                      {trackedSymbols.has(r.symbol) ? (
                        <span className="text-accent-cyan"><CheckCircle2 className="w-3.5 h-3.5 inline" /></span>
                      ) : (
                        <button
                          onClick={(e) => handleTrackSignal(r, e)}
                          title={`Track ${r.symbol} signal`}
                          className="p-1 rounded hover:bg-accent-cyan/15 text-text-muted hover:text-accent-cyan transition-colors"
                        >
                          <Crosshair className="w-3.5 h-3.5" />
                        </button>
                      )}
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
              Scan {getTop500Symbols().length} top market-cap stocks across all sectors for extreme directional signals.
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
              Takes ~5-8 minutes — uses same Tradier data as Overview for consistent scores
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
