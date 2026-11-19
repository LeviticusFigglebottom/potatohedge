'use client';

import { useMemo } from 'react';
import { Settings2, FlaskConical, Radio } from 'lucide-react';
import { useDashboardStore } from '@/hooks/useDashboardStore';
import { useChain, useDesk, useStatus, useTrades, type ApiState, type DeskPanel } from './useFlowDesk';
import { ByExpirationPanel, OptionsFlowPanel, RecentFlowPanel, TopSymbolsPanel } from './FlowPanels';
import { FlowHeatmapPanel, TapePanel } from './HeatmapTapePanels';
import { DealerGreeksPanel, VolatilityPanel } from './GreeksVolPanels';
import { DailySummaryPanel, MsiPanel } from './MsiSummaryPanels';
import { ElmoDPanel } from './ElmoDPanel';
import { Gate, Panel, Seg, Toggle } from './ui';

const PANELS: { id: DeskPanel; label: string }[] = [
  { id: 'flow', label: 'Flow' },
  { id: 'heatmap', label: 'Heatmap' },
  { id: 'greeks', label: 'Dealer Greeks' },
  { id: 'vol', label: 'Volatility' },
  { id: 'tape', label: 'Tape' },
  { id: 'msi', label: 'MSI' },
  { id: 'summary', label: 'Daily Summary' },
  { id: 'elmod', label: 'ELMo-D Chart' },
];

function SettingsBar() {
  const { settings, setSettings } = useDesk();
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-text-secondary bg-bg-secondary border border-border rounded-lg px-3 py-2" data-panel="settings">
      <Settings2 className="w-3.5 h-3.5 text-text-muted" />
      <span>Top Symbols / Recent net:</span>
      <Seg value={settings.symbolsNet} onChange={(v) => setSettings({ symbolsNet: v })} options={[{ value: 'call_minus_put', label: 'Call − Put' }, { value: 'call_plus_put', label: 'Call + Put' }]} />
      <span>By-Expiration net:</span>
      <Seg value={settings.expirationNet} onChange={(v) => setSettings({ expirationNet: v })} options={[{ value: 'call_plus_put', label: 'Call + Put' }, { value: 'call_minus_put', label: 'Call − Put' }]} />
      <Toggle label={`Exclude |Δ| > ${settings.deepItmDelta} from sentiment`} checked={settings.excludeDeepItm} onChange={(v) => setSettings({ excludeDeepItm: v })} />
      <span>Recent window:</span>
      <Seg value={settings.recentWindowMin} onChange={(v) => setSettings({ recentWindowMin: v })} options={[{ value: 15, label: '15m' }, { value: 30, label: '30m' }, { value: 60, label: '60m' }]} />
    </div>
  );
}

export default function FlowDeskTab() {
  const symbol = useDashboardStore((s) => s.symbol) || 'SPY';
  const { mode, setMode, panel, setPanel } = useDesk();
  const status = useStatus();
  const universe = useMemo(() => {
    const u = status.data?.universe ?? [];
    return u.length ? [...new Set([symbol, ...u])] : [];
  }, [status.data, symbol]);
  const needsMarket = panel !== 'summary' && panel !== 'elmod';
  const tradesAll = useTrades(needsMarket && (panel === 'flow' || panel === 'tape') ? universe : needsMarket ? [symbol] : [], 1);
  const trades5d = useTrades(panel === 'greeks' ? [symbol] : [], 5);
  const chain = useChain(needsMarket ? symbol : '');
  const src = status.data?.sources;

  return (
    <div className="space-y-3 animate-fade-in" data-tab="flowdesk">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap items-center gap-1" aria-label="Flow Desk panels">
          {PANELS.map((p) => (
            <button key={p.id} onClick={() => setPanel(p.id)} data-subtab={p.id}
              className={`px-3 py-1.5 rounded-md text-xs font-medium border ${panel === p.id ? 'border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan' : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'}`}>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className="text-text-muted">{symbol} · session {status.data?.session ?? '…'}</span>
          <button onClick={() => setMode('live')} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${mode === 'live' ? 'border-accent-green/40 text-accent-green bg-accent-green/10' : 'border-border text-text-muted'}`}><Radio className="w-3 h-3" />Live</button>
          <button onClick={() => setMode('demo')} className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${mode === 'demo' ? 'border-accent-amber/40 text-accent-amber bg-accent-amber/10' : 'border-border text-text-muted'}`}><FlaskConical className="w-3 h-3" />Demo</button>
          {src && mode === 'live' && (
            <span className="text-text-muted">
              chain/bars: {src.tradier ? 'Tradier' : src.polygon ? 'Polygon' : 'none'} · prints: {src.tradePrints ? 'Polygon' : 'none'}
            </span>
          )}
        </div>
      </div>
      {mode === 'demo' && <div className="text-[11px] font-mono text-accent-amber bg-accent-amber/5 border border-accent-amber/20 rounded px-3 py-1.5">DEMO MODE — synthetic, deterministic data. Nothing here is real market data.</div>}
      {(panel === 'flow' || panel === 'tape') && <SettingsBar />}

      {panel === 'flow' && (
        <Framed id="options-flow" title="Options Flow" states={[status, tradesAll]}>{() => (
          <div className="space-y-4">
            <OptionsFlowPanel symbol={symbol} trades={tradesAll.enriched!} />
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
              <TopSymbolsPanel trades={tradesAll.enriched!} />
              <RecentFlowPanel trades={tradesAll.enriched!} nowMs={status.data!.nowMs} />
            </div>
            <ByExpirationPanel trades={tradesAll.enriched!} />
          </div>
        )}</Framed>
      )}
      {panel === 'heatmap' && (
        <Framed id="flow-heatmap" title="Option Heatmap (Flow)" states={[tradesAll, chain]}>{() => <FlowHeatmapPanel symbol={symbol} trades={tradesAll.enriched!} spot={chain.data!.spot} />}</Framed>
      )}
      {panel === 'greeks' && (
        <Framed id="dealer-greeks" title="Dealer Greek Exposure" states={[chain, tradesAll, trades5d]}>{() => <DealerGreeksPanel symbol={symbol} chain={chain.data!} trades1d={tradesAll.enriched!} trades5d={trades5d.enriched!} />}</Framed>
      )}
      {panel === 'vol' && (
        <Framed id="volatility" title="Volatility" states={[chain]}>{() => <VolatilityPanel symbol={symbol} chain={chain.data!} />}</Framed>
      )}
      {panel === 'tape' && (
        <Framed id="tape" title="Tape" states={[tradesAll]}>{() => <TapePanel trades={tradesAll.enriched!} />}</Framed>
      )}
      {panel === 'msi' && (
        <Framed id="msi" title="MSI – Market Stability Index" states={[chain, tradesAll]}>{() => <MsiPanel symbol={symbol} chain={chain.data!} trades={tradesAll.enriched!} />}</Framed>
      )}
      {panel === 'summary' && <DailySummaryPanel />}
      {panel === 'elmod' && <ElmoDPanel symbol={symbol} />}
    </div>
  );
}

/** Render the panel when every request is ready; otherwise the state message inside a panel frame. */
function Framed({ id, title, states, children }: { id: string; title: string; states: ApiState<unknown>[]; children: () => React.ReactNode }) {
  const ready = states.every((st) => !st.loading && !st.noSource && !st.error && st.data != null);
  if (ready) return <>{children()}</>;
  return <Panel id={id} title={title}><Gate states={states}>{() => null}</Gate></Panel>;
}
