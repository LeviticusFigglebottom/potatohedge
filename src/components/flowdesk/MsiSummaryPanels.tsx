'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { computeMsiComponents, MSI_COMPONENTS } from '@/lib/flowdesk/msi/components';
import { computeMsiComposite, validateMsiConfig, type MsiConfig } from '@/lib/flowdesk/msi/composite';
import { intradayFlow, type EnrichedTrade } from '@/lib/flowdesk/flow/aggregate';
import type { ChainSnapshot } from '@/lib/flowdesk/types';
import type { StoredSummary } from '@/lib/flowdesk/summaryStore';
import { C, deskChart, etTime, fmtNum, fmtUsd } from './chart/theme';
import { Sparkline } from './svgCharts';
import { Gate, Panel, Signed, SortTable, type Column } from './ui';
import { useApi, useDesk } from './useFlowDesk';

const LS_MSI = 'optix_flowdesk_msi_override';

const COMPONENT_COLORS = [C.amber, C.cyan, C.pink, C.purple, C.green, '#8888a0', C.red];

function fmtComponent(id: string, v: number): string {
  if (id.startsWith('entropy')) return v.toFixed(3);
  if (id === 'flow_skew') return v.toFixed(2);
  return fmtUsd(v);
}

export function MsiPanel({ symbol, chain, trades }: { symbol: string; chain: ChainSnapshot; trades: EnrichedTrade[] }) {
  const cfgApi = useApi<{ config: MsiConfig; source: string }>('/api/flow-desk/msi-config');
  const [override, setOverride] = useState<MsiConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftErr, setDraftErr] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_MSI);
      if (raw) { const v = validateMsiConfig(JSON.parse(raw)); if (v.ok) setOverride(v.config); }
    } catch { /* ignore */ }
  }, []);

  const serverCfg = cfgApi.data && 'config' in cfgApi.data ? cfgApi.data.config : null;
  const config = override ?? serverCfg;
  const own = useMemo(() => trades.filter((t) => t.root === symbol), [trades, symbol]);
  const samples = useMemo(() => computeMsiComponents(chain, own, intradayFlow(own, { rthOnly: true }), 5), [chain, own]);
  const msi = useMemo(() => (config ? computeMsiComposite(samples, config) : []), [samples, config]);

  const el = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<'Line'> | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const ready = !!config;
  useEffect(() => {
    if (!ready || !el.current) return;
    const c = deskChart(el.current);
    chart.current = c;
    series.current = c.addLineSeries({ color: C.cyan, lineWidth: 2, title: 'MSI' });
    series.current.createPriceLine({ price: 50, color: C.muted, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: 'neutral' });
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, [ready]);
  useEffect(() => {
    series.current?.setData(msi.map((p) => ({ time: etTime(p.time), value: p.value })));
    chart.current?.timeScale().fitContent();
  }, [msi, ready]);

  const startEdit = () => { setDraft(JSON.stringify(config, null, 2)); setDraftErr(null); setEditing(true); };
  const apply = () => {
    try {
      const v = validateMsiConfig(JSON.parse(draft));
      if (!v.ok) { setDraftErr(v.error); return; }
      localStorage.setItem(LS_MSI, JSON.stringify(v.config));
      setOverride(v.config);
      setEditing(false);
    } catch (e) { setDraftErr((e as Error).message); }
  };
  const reset = () => { localStorage.removeItem(LS_MSI); setOverride(null); setEditing(false); };
  const last = msi[msi.length - 1];

  return (
    <Panel id="msi" title={`MSI – Market Stability Index — ${symbol}`}
      subtitle={<>
        {config ? `${config.name} v${config.version} · normalize: ${config.normalize} · output: ${config.output.transform}` : 'loading config…'}
        {' · '}source: {override ? 'local override (this browser)' : cfgApi.data?.source ?? '—'}
        {config?.status && <span className="text-accent-amber"> · {config.status}</span>}
      </>}
      actions={<>
        <button onClick={startEdit} className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary font-mono text-[11px]">Edit formula (JSON)</button>
        {override && <button onClick={reset} className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary font-mono text-[11px]">Reset to server config</button>}
      </>}>
      <Gate states={[cfgApi]}>{() => (
        <>
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-2xl font-display font-semibold text-text-primary">{last ? last.value.toFixed(1) : '—'}</span>
            <span className="text-[11px] font-mono text-text-muted">composite (0–{config?.output.scale}) · 5-minute samples, RTH</span>
          </div>
          <div ref={el} className="h-[240px] w-full" />
          {editing && (
            <div className="mt-3 space-y-2">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
                className="w-full h-64 bg-bg-primary border border-border rounded p-2 font-mono text-[11px] text-text-primary" />
              {draftErr && <div className="text-[11px] text-accent-red font-mono">{draftErr}</div>}
              <div className="flex gap-2 text-[11px] font-mono">
                <button onClick={apply} className="px-2 py-1 rounded bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30">Apply</button>
                <button onClick={() => setEditing(false)} className="px-2 py-1 rounded border border-border text-text-secondary">Cancel</button>
                <span className="text-text-muted self-center">Component ids: {MSI_COMPONENTS.map((c) => c.id).join(', ')}</span>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 mt-3">
            {MSI_COMPONENTS.map((c, i) => {
              const vals = samples.map((s) => s.values[c.id]);
              const w = config?.components.find((x) => x.id === c.id);
              return (
                <div key={c.id} className="bg-bg-tertiary/60 border border-border rounded p-2" data-msi-component={c.id}>
                  <div className="flex justify-between text-[10px] font-mono text-text-muted">
                    <span>{c.label}</span>
                    <span>{w ? `w=${w.weight}${w.invert ? ' (inv)' : ''}` : 'unused'}</span>
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <span className="text-sm font-mono text-text-primary">{vals.length ? fmtComponent(c.id, vals[vals.length - 1]) : '—'}</span>
                    {vals.length > 1 && <Sparkline values={vals} color={COMPONENT_COLORS[i]} />}
                  </div>
                  <div className="text-[9px] font-mono text-text-muted">{c.id} · {c.unit}</div>
                </div>
              );
            })}
          </div>
        </>
      )}</Gate>
    </Panel>
  );
}

// ─── Panel 10: Daily per-root summary ───────────────────────

const summaryColumns: Column<StoredSummary>[] = [
  { key: 'root', label: 'root', value: (r) => r.root, align: 'left', render: (r) => <span className="text-accent-cyan">{r.root}</span> },
  { key: 'date', label: 'date', value: (r) => r.date, align: 'left' },
  { key: 'prem', label: 'total_net_premium', value: (r) => r.total_net_premium, render: (r) => <Signed v={r.total_net_premium} fmt={fmtUsd} /> },
  { key: 'delta', label: 'total_net_delta', value: (r) => r.total_net_delta, render: (r) => <Signed v={r.total_net_delta} fmt={(v) => fmtNum(v)} /> },
  { key: 'vega', label: 'total_net_vega', value: (r) => r.total_net_vega, render: (r) => <Signed v={r.total_net_vega} fmt={fmtUsd} /> },
];

export function DailySummaryPanel() {
  const mode = useDesk((s) => s.mode);
  const api = useApi<StoredSummary[]>(`/api/flow-desk/summary?mode=${mode}&days=30`);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const autoRan = useRef(false);

  const compute = async (days: number) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/flow-desk/summary?mode=${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) });
      const body = await r.json();
      if (body.noSource) setMsg(`No data source configured: ${body.reason}`);
      else if (body.error) setMsg(body.error);
      else setMsg(`Saved ${body.written} rows to ${body.backend}`);
      api.reload();
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (mode === 'demo' && !autoRan.current && api.data && api.data.length === 0) { autoRan.current = true; void compute(5); }
  }, [mode, api.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Panel id="daily-summary" title="Daily Per-Root Summary"
      subtitle="Persisted per (root, date): total_net_premium = Σ bullish-signed premium (Call − Put) · total_net_delta = Σ aggressor-signed contracts × 100 × Δ · total_net_vega = Σ signed × 100 × vega"
      actions={<>
        <button disabled={busy} onClick={() => compute(1)} className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary font-mono text-[11px] disabled:opacity-50">Compute today &amp; save</button>
        <button disabled={busy} onClick={() => compute(5)} className="px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary font-mono text-[11px] disabled:opacity-50">Backfill 5 sessions</button>
      </>}>
      {msg && <div className="text-[11px] font-mono text-text-secondary mb-2">{msg}</div>}
      <Gate states={[api]}>{() => (
        <SortTable rows={api.data ?? []} columns={summaryColumns} rowKey={(r) => `${r.root}|${r.date}`} initialSort={{ key: 'date', dir: 'desc' }} testId="daily-summary-table" />
      )}</Gate>
    </Panel>
  );
}
