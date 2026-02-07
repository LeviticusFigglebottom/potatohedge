'use client';

import { useEffect } from 'react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import TickerSearch from '@/components/dashboard/TickerSearch';
import QuoteHeader from '@/components/dashboard/QuoteHeader';
import TabNav from '@/components/dashboard/TabNav';
import AnalyticsCards from '@/components/dashboard/AnalyticsCards';
import PriceChart from '@/components/charts/PriceChart';
import GEXChart from '@/components/charts/GEXChart';
import OptionsChainTable from '@/components/options/OptionsChainTable';
import InterpretationsPanel from '@/components/dashboard/InterpretationsPanel';
import RecommendationsPanel from '@/components/dashboard/RecommendationsPanel';
import DealerTab from '@/components/dashboard/DealerTab';
import VolatilityTab from '@/components/dashboard/VolatilityTab';
import { Activity, Zap } from 'lucide-react';

function OverviewTab() {
  return (
    <div className="space-y-4 animate-fade-in">
      <AnalyticsCards />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-h-[400px]">
          <PriceChart />
        </div>
        <div className="min-h-[400px]">
          <GEXChart compact />
        </div>
      </div>
      <InterpretationsPanel />
      <RecommendationsPanel />
    </div>
  );
}

function ChainTab() {
  return (
    <div className="animate-fade-in min-h-[500px]">
      <OptionsChainTable />
    </div>
  );
}

export default function DashboardPage() {
  const { loadSymbol, symbol, fetchQuote, activeTab } = useDashboardStore();

  useEffect(() => { loadSymbol('SPY'); }, [loadSymbol]);
  useEffect(() => {
    const iv = setInterval(fetchQuote, 30000);
    return () => clearInterval(iv);
  }, [fetchQuote, symbol]);

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-bg-primary/90 backdrop-blur-md border-b border-border">
        <div className="max-w-[1920px] mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent-cyan/30 to-accent-purple/30 flex items-center justify-center border border-accent-cyan/20">
                <Zap className="w-4 h-4 text-accent-cyan" />
              </div>
              <h1 className="text-base font-display font-bold tracking-tight">
                <span className="text-accent-cyan">Opt</span><span className="text-text-primary">ix</span>
              </h1>
            </div>
            <div className="h-5 w-px bg-border mx-1 hidden sm:block" />
            <TickerSearch />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-mono text-text-muted">
              <Activity className="w-3 h-3 text-accent-green" />
              <span className="hidden sm:inline">Tradier + Polygon</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-[1920px] mx-auto px-4 py-4 space-y-4">
        <QuoteHeader />
        <TabNav />
        <div className="min-h-[500px]">
          {activeTab === 'overview' && <OverviewTab />}
          {activeTab === 'dealer' && <DealerTab />}
          {activeTab === 'volatility' && <VolatilityTab />}
          {activeTab === 'chain' && <ChainTab />}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border mt-8">
        <div className="max-w-[1920px] mx-auto px-4 py-3 flex items-center justify-between text-xs font-mono text-text-muted">
          <span>Optix v0.4.0 — Options Analytics Dashboard</span>
          <span>Tradier • Polygon.io • GEX/Vanna/Charm computed locally</span>
        </div>
      </footer>
    </div>
  );
}
