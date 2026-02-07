'use client';

import { useEffect } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import TickerSearch from '@/components/dashboard/TickerSearch';
import QuoteHeader from '@/components/dashboard/QuoteHeader';
import PriceChart from '@/components/charts/PriceChart';
import GEXChart from '@/components/charts/GEXChart';
import OptionsChainTable from '@/components/options/OptionsChainTable';
import AnalyticsCards from '@/components/dashboard/AnalyticsCards';
import InterpretationsPanel from '@/components/dashboard/InterpretationsPanel';
import { Activity, Zap } from 'lucide-react';

export default function DashboardPage() {
  const { loadSymbol, symbol, fetchQuote } = useDashboardStore();

  // Initial load
  useEffect(() => {
    loadSymbol('SPY');
  }, [loadSymbol]);

  // Auto-refresh quote every 30s
  useEffect(() => {
    const interval = setInterval(fetchQuote, 30000);
    return () => clearInterval(interval);
  }, [fetchQuote, symbol]);

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Top bar */}
      <header className="sticky top-0 z-50 bg-bg-primary/90 backdrop-blur-md border-b border-border">
        <div className="max-w-[1920px] mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent-cyan/30 to-accent-purple/30 flex items-center justify-center border border-accent-cyan/20">
                <Zap className="w-4 h-4 text-accent-cyan" />
              </div>
              <h1 className="text-base font-display font-bold tracking-tight">
                <span className="text-accent-cyan">Opt</span>
                <span className="text-text-primary">ix</span>
              </h1>
            </div>
            <div className="h-5 w-px bg-border mx-1 hidden sm:block" />
            <TickerSearch />
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-mono text-text-muted">
              <Activity className="w-3 h-3 text-accent-green" />
              <span className="hidden sm:inline">Connected</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-[1920px] mx-auto px-4 py-4 space-y-4">
        {/* Quote header */}
        <section>
          <QuoteHeader />
        </section>

        {/* Analytics cards row */}
        <section>
          <AnalyticsCards />
        </section>

        {/* Chart + GEX row */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 min-h-[400px]">
            <PriceChart />
          </div>
          <div className="min-h-[400px]">
            <GEXChart />
          </div>
        </section>

        {/* Interpretations */}
        <section>
          <InterpretationsPanel />
        </section>

        {/* Options chain */}
        <section className="min-h-[500px]">
          <OptionsChainTable />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-8">
        <div className="max-w-[1920px] mx-auto px-4 py-3 flex items-center justify-between text-xs font-mono text-text-muted">
          <span>Optix v0.1.0 — Self-hosted Options Analytics</span>
          <span>Data: Tradier ORATS • GEX computed locally</span>
        </div>
      </footer>
    </div>
  );
}
