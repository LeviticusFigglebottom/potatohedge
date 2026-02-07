'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatCurrency, formatPercent, formatNumber, colorForChange } from '@/lib/utils/format';
import { TrendingUp, TrendingDown, RefreshCw, Volume2 } from 'lucide-react';

export default function QuoteHeader() {
  const { symbol, quote, loading, fetchQuote, lastUpdate } = useDashboardStore();

  if (loading.quote && !quote) {
    return (
      <div className="flex items-center gap-6 px-1">
        <div className="skeleton w-24 h-8" />
        <div className="skeleton w-32 h-6" />
        <div className="skeleton w-20 h-5" />
      </div>
    );
  }

  if (!quote) return null;

  const isPositive = quote.change >= 0;
  const TrendIcon = isPositive ? TrendingUp : TrendingDown;

  return (
    <div className="flex items-center gap-6 flex-wrap">
      {/* Symbol + Price */}
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-display font-bold text-text-primary tracking-tight">
          {symbol}
        </h1>
        <span className="text-3xl font-mono font-semibold text-text-primary">
          {formatCurrency(quote.last)}
        </span>
      </div>

      {/* Change */}
      <div className={`flex items-center gap-1.5 ${colorForChange(quote.change)}`}>
        <TrendIcon className="w-4 h-4" />
        <span className="font-mono text-sm font-medium">
          {formatCurrency(Math.abs(quote.change))}
        </span>
        <span className={`badge ${isPositive ? 'badge-green' : 'badge-red'}`}>
          {formatPercent(quote.changePct)}
        </span>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-1.5 text-text-secondary">
        <Volume2 className="w-3.5 h-3.5" />
        <span className="text-xs font-mono">
          Vol: {formatNumber(quote.volume, 0)}
        </span>
        {quote.avgVolume > 0 && (
          <span className={`text-xs font-mono ${
            quote.volume > quote.avgVolume * 1.5
              ? 'text-accent-amber'
              : quote.volume > quote.avgVolume
                ? 'text-accent-green'
                : 'text-text-muted'
          }`}>
            ({(quote.volume / quote.avgVolume * 100).toFixed(0)}% avg)
          </span>
        )}
      </div>

      {/* Bid/Ask */}
      <div className="text-xs font-mono text-text-muted hidden md:block">
        {formatCurrency(quote.bid)} × {formatCurrency(quote.ask)}
      </div>

      {/* Refresh */}
      <button
        onClick={fetchQuote}
        className="btn btn-ghost p-1.5"
        title="Refresh quote"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${loading.quote ? 'animate-spin' : ''}`} />
      </button>

      {/* Last update */}
      {lastUpdate > 0 && (
        <span className="text-[10px] font-mono text-text-muted">
          {new Date(lastUpdate).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
