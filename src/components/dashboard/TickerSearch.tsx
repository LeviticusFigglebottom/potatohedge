'use client';

import { useState, useRef, useCallback } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { useDashboardStore } from '@/hooks/useDashboardStore';

const POPULAR_TICKERS = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'AMZN', 'META', 'MSFT', 'AMD', 'IWM'];

export default function TickerSearch() {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { symbol, loadSymbol, loading } = useDashboardStore();
  const isLoading = loading.quote || loading.history;

  const handleSubmit = useCallback((ticker?: string) => {
    const sym = (ticker || input).trim().toUpperCase();
    if (sym && sym !== symbol) {
      loadSymbol(sym);
      setInput('');
      setFocused(false);
      inputRef.current?.blur();
    }
  }, [input, symbol, loadSymbol]);

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 200)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder={`Search ticker...`}
            className="input pl-9 pr-3 w-full font-mono text-sm"
            spellCheck={false}
          />
          {isLoading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-accent-cyan animate-spin" />
          )}
        </div>

        <span className="text-xs text-text-muted font-mono hidden sm:inline">
          Active: <span className="text-accent-cyan font-semibold">{symbol}</span>
        </span>
      </div>

      {/* Quick ticker dropdown */}
      {focused && (
        <div className="absolute top-full left-0 mt-1 w-full max-w-xs bg-bg-secondary border border-border rounded-lg shadow-xl z-50 overflow-hidden animate-fade-in">
          <div className="px-3 py-2 border-b border-border">
            <span className="text-xs font-mono text-text-muted uppercase tracking-wider">Popular</span>
          </div>
          <div className="p-2 flex flex-wrap gap-1.5">
            {POPULAR_TICKERS.map((t) => (
              <button
                key={t}
                onClick={() => handleSubmit(t)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-all ${
                  t === symbol
                    ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
