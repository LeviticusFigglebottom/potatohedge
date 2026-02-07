'use client';

import { useDashboardStore } from '@/hooks/useDashboardStore';
import { formatNumber, formatCurrency } from '@/lib/utils/format';
import GEXChart from '@/components/charts/GEXChart';
import { Shield, ArrowUp, ArrowDown, Minus, AlertTriangle, Zap, BarChart3, ChevronRight } from 'lucide-react';

function KeyLevelsTable() {
  const { multiGEX, quote } = useDashboardStore();
  if (!multiGEX) return null;

  const { aggregated, maxPain, spotPrice } = multiGEX;
  const levels = [
    aggregated.callWall && { label: 'Call Wall', price: aggregated.callWall, type: 'resistance' as const, color: 'text-accent-green' },
    aggregated.putWall && { label: 'Put Wall', price: aggregated.putWall, type: 'support' as const, color: 'text-accent-red' },
    aggregated.gammaFlip && { label: 'Gamma Flip', price: aggregated.gammaFlip, type: 'pivot' as const, color: 'text-accent-amber' },
    maxPain && { label: 'Max Pain', price: maxPain.strike, type: 'magnet' as const, color: 'text-accent-cyan' },
  ].filter(Boolean) as { label: string; price: number; type: string; color: string }[];

  levels.sort((a, b) => b.price - a.price);

  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">Key Levels</span></div>
      <div className="divide-y divide-border/30">
        {levels.map((l) => {
          const dist = ((l.price - spotPrice) / spotPrice) * 100;
          return (
            <div key={l.label} className="px-4 py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {l.type === 'resistance' ? <ArrowUp className="w-3 h-3 text-accent-green" /> :
                  l.type === 'support' ? <ArrowDown className="w-3 h-3 text-accent-red" /> :
                  l.type === 'pivot' ? <AlertTriangle className="w-3 h-3 text-accent-amber" /> :
                  <Minus className="w-3 h-3 text-accent-cyan" />}
                <span className="text-sm font-medium text-text-primary">{l.label}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className={`font-mono text-sm font-semibold ${l.color}`}>{formatCurrency(l.price)}</span>
                <span className={`font-mono text-xs ${dist > 0 ? 'text-accent-green' : dist < 0 ? 'text-accent-red' : 'text-text-muted'}`}>
                  {dist > 0 ? '+' : ''}{dist.toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })}
        <div className="px-4 py-2.5 flex items-center justify-between bg-bg-tertiary/30">
          <span className="text-sm font-medium text-accent-cyan">SPOT</span>
          <span className="font-mono text-sm font-bold text-accent-cyan">{formatCurrency(spotPrice)}</span>
        </div>
      </div>
    </div>
  );
}

function PerExpirationTable() {
  const { multiGEX } = useDashboardStore();
  if (!multiGEX?.perExpiration?.length) return null;

  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">Per-Expiration Breakdown</span></div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-text-muted border-b border-border">
              <th className="px-3 py-2 text-left">Exp</th>
              <th className="px-3 py-2 text-right">DTE</th>
              <th className="px-3 py-2 text-right">GEX</th>
              <th className="px-3 py-2 text-right">DEX</th>
              <th className="px-3 py-2 text-right">Vanna</th>
              <th className="px-3 py-2 text-right">Charm</th>
              <th className="px-3 py-2 text-right">P/C Vol</th>
              <th className="px-3 py-2 text-right">Call Vol</th>
              <th className="px-3 py-2 text-right">Put Vol</th>
            </tr>
          </thead>
          <tbody>
            {multiGEX.perExpiration.map((exp) => (
              <tr key={exp.expiration} className="border-b border-border/30 hover:bg-bg-hover/30">
                <td className="px-3 py-2 text-accent-cyan">{exp.expiration.slice(5)}</td>
                <td className="px-3 py-2 text-right text-text-secondary">{exp.dte}d</td>
                <td className={`px-3 py-2 text-right font-medium ${exp.totalGEX >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                  {formatNumber(exp.totalGEX)}
                </td>
                <td className={`px-3 py-2 text-right ${exp.totalDEX >= 0 ? 'text-text-secondary' : 'text-accent-amber'}`}>
                  {formatNumber(exp.totalDEX)}
                </td>
                <td className="px-3 py-2 text-right text-accent-purple">{formatNumber(exp.totalVanna)}</td>
                <td className="px-3 py-2 text-right text-text-secondary">{formatNumber(exp.totalCharm)}</td>
                <td className={`px-3 py-2 text-right ${exp.volumePCR > 1.2 ? 'text-accent-red' : exp.volumePCR < 0.7 ? 'text-accent-green' : 'text-text-secondary'}`}>
                  {exp.volumePCR.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right text-accent-green">{formatNumber(exp.callVolume, 0)}</td>
                <td className="px-3 py-2 text-right text-accent-red">{formatNumber(exp.putVolume, 0)}</td>
              </tr>
            ))}
            {/* Totals row */}
            <tr className="bg-bg-tertiary/30 font-medium">
              <td className="px-3 py-2 text-text-primary">TOTAL</td>
              <td className="px-3 py-2"></td>
              <td className={`px-3 py-2 text-right ${multiGEX.aggregated.totalGEX >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {formatNumber(multiGEX.aggregated.totalGEX)}
              </td>
              <td className={`px-3 py-2 text-right ${multiGEX.aggregated.totalDEX >= 0 ? 'text-text-primary' : 'text-accent-amber'}`}>
                {formatNumber(multiGEX.aggregated.totalDEX)}
              </td>
              <td className="px-3 py-2 text-right text-accent-purple">{formatNumber(multiGEX.aggregated.totalVanna)}</td>
              <td className="px-3 py-2 text-right">{formatNumber(multiGEX.aggregated.totalCharm)}</td>
              <td className="px-3 py-2 text-right">{multiGEX.volume.volumePCR.toFixed(2)}</td>
              <td className="px-3 py-2 text-right text-accent-green">{formatNumber(multiGEX.volume.totalCallVol, 0)}</td>
              <td className="px-3 py-2 text-right text-accent-red">{formatNumber(multiGEX.volume.totalPutVol, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DealerInterpretation() {
  const { multiGEX } = useDashboardStore();
  const ctx = multiGEX?.context;
  if (!ctx) return null;

  const sections = [
    { icon: Shield, title: 'Dealer Positioning', text: ctx.dealer.interpretation, color: 'text-accent-cyan' },
    { icon: BarChart3, title: 'Volume Analysis', text: ctx.volume.interpretation, color: 'text-accent-green' },
    { icon: Zap, title: 'Skew Analysis', text: ctx.skew.interpretation, color: 'text-accent-purple' },
    { icon: BarChart3, title: 'OI Concentration', text: ctx.oi.interpretation, color: 'text-accent-amber' },
  ].filter(s => s.text && s.text.length > 0);

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-accent-cyan" />
          Market Context & Interpretation
        </span>
      </div>
      <div className="divide-y divide-border/30">
        {sections.map((s, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <s.icon className={`w-3.5 h-3.5 ${s.color}`} />
              <span className="text-xs font-mono font-semibold uppercase tracking-wider text-text-secondary">{s.title}</span>
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{s.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DealerTab() {
  const { multiGEX, loading } = useDashboardStore();

  if (loading.multiGEX && !multiGEX) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="panel p-8 flex items-center justify-center">
          <div className="flex items-center gap-3 text-text-muted font-mono">
            <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
            Computing dealer positioning across multiple expirations...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* GEX Chart + Key Levels side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-h-[350px]">
          <GEXChart />
        </div>
        <KeyLevelsTable />
      </div>

      {/* Interpretation */}
      <DealerInterpretation />

      {/* Per-expiration breakdown */}
      <PerExpirationTable />
    </div>
  );
}
