'use client';

import { useMemo, useState } from 'react';
import { dealerExposure, filterStrikeRange, GREEKS, totals, type ExposureMode, type GreekKey } from '@/lib/flowdesk/flow/greeks';
import { skewByExpiry, termStructure } from '@/lib/flowdesk/flow/vol';
import type { EnrichedTrade } from '@/lib/flowdesk/flow/aggregate';
import type { ChainSnapshot } from '@/lib/flowdesk/types';
import { C, fmtNum, fmtUsd } from './chart/theme';
import { LinesChart, StrikeBars } from './svgCharts';
import { Panel, Seg, Toggle } from './ui';

/** Fixed categorical order — colour follows the greek, never its rank. */
export const GREEK_META: Record<GreekKey, { label: string; color: string; fmt: (v: number) => string }> = {
  delta: { label: 'DELTA', color: C.cyan, fmt: (v) => fmtUsd(v) },
  gamma: { label: 'GAMMA', color: C.amber, fmt: (v) => fmtUsd(v) },
  vega: { label: 'VEGA', color: C.purple, fmt: (v) => fmtUsd(v) },
  vanna: { label: 'VANNA', color: C.green, fmt: (v) => fmtNum(v) },
  charm: { label: 'CHARM', color: C.pink, fmt: (v) => fmtNum(v) },
};

type Mode = ExposureMode | 'compare';

const MODE_LABEL: Record<Mode, string> = {
  oi: 'Weighted OI', dealer5d: 'Dealer (5d)', flow1d: 'Flow (1d)', combined: 'Combined', compare: 'Compare Greeks',
};

export function DealerGreeksPanel({ symbol, chain, trades1d, trades5d }: { symbol: string; chain: ChainSnapshot; trades1d: EnrichedTrade[]; trades5d: EnrichedTrade[] }) {
  const [mode, setMode] = useState<Mode>('oi');
  const [compareBase, setCompareBase] = useState<ExposureMode>('oi');
  const [range, setRange] = useState<number | null>(10);
  const [expiry, setExpiry] = useState<string>('');
  const [on, setOn] = useState<Record<GreekKey, boolean>>({ delta: true, gamma: true, vega: false, vanna: false, charm: false });
  const expiries = useMemo(() => [...new Set(chain.contracts.map((c) => c.expiry))].sort(), [chain]);
  const base: ExposureMode = mode === 'compare' ? compareBase : mode;
  const rows = useMemo(() => {
    const t1 = trades1d.filter((t) => t.root === symbol);
    const t5 = trades5d.filter((t) => t.root === symbol);
    return filterStrikeRange(dealerExposure({ chain, trades1d: t1, trades5d: t5, mode: base, expiry: expiry || null }), chain.spot, range);
  }, [chain, trades1d, trades5d, symbol, base, expiry, range]);
  const tot = totals(rows);
  const active = GREEKS.filter((g) => on[g]);
  const usesOi = base === 'oi' || base === 'combined';

  return (
    <Panel id="dealer-greeks" title={`Dealer Greek Exposure — ${symbol}${usesOi ? ' (Prior Trading Day)' : ''}`}
      subtitle={`${MODE_LABEL[mode]}${mode === 'compare' ? ` · base: ${MODE_LABEL[compareBase]} · each greek on its own axis` : ''} · ${usesOi ? `OI as of ${chain.oiDate ?? 'prior session'} · ` : ''}dealer convention: +OI calls, −OI puts; flow modes assume dealers take the other side of the aggressor`}
      actions={<>
        <Seg value={mode} onChange={setMode} options={(Object.keys(MODE_LABEL) as Mode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        {mode === 'compare' && <Seg value={compareBase} onChange={setCompareBase} options={(['oi', 'dealer5d', 'flow1d', 'combined'] as ExposureMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))} />}
        <Seg value={range ?? 0} onChange={(v) => setRange(v === 0 ? null : v)} options={[{ value: 0, label: 'All' }, { value: 5, label: '±5%' }, { value: 10, label: '±10%' }, { value: 20, label: '±20%' }]} />
        <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className="bg-bg-tertiary border border-border rounded px-1.5 py-1 font-mono text-[11px] text-text-secondary">
          <option value="">All expiries</option>
          {expiries.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </>}>
      <div className="flex flex-wrap items-center gap-4 mb-3 text-[11px] font-mono">
        {GREEKS.map((g) => (
          <span key={g} className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: GREEK_META[g].color }} />
            <Toggle label={GREEK_META[g].label} checked={on[g]} onChange={(v) => setOn({ ...on, [g]: v })} />
            <span className="text-text-muted">Σ {GREEK_META[g].fmt(tot[g])}</span>
          </span>
        ))}
        <span className="text-text-muted">spot {chain.spot.toFixed(2)}</span>
      </div>
      {active.length === 0 && <div className="text-xs text-text-muted py-6 text-center">Select at least one greek.</div>}
      {mode === 'compare' && active.length > 0 && (
        <LinesChart independentY height={320} xFmt={(x) => String(x)} yFmt={fmtNum} marker={{ x: chain.spot, label: `spot ${chain.spot.toFixed(2)}` }}
          series={active.map((g) => ({ id: g, label: GREEK_META[g].label, color: GREEK_META[g].color, fmt: GREEK_META[g].fmt, points: rows.map((r) => ({ x: r.strike, y: r[g] })) }))} />
      )}
      {mode !== 'compare' && (
        <div className="space-y-3">
          {active.map((g) => (
            <div key={g}>
              <div className="text-[11px] font-mono mb-1" style={{ color: GREEK_META[g].color }}>{GREEK_META[g].label} by strike</div>
              <StrikeBars label={GREEK_META[g].label} rows={rows.map((r) => ({ strike: r.strike, value: r[g] }))} color={GREEK_META[g].color} spot={chain.spot} fmt={GREEK_META[g].fmt} height={active.length > 2 ? 160 : 220} />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Panel 7: Volatility ────────────────────────────────────

const SKEW_COLORS = [C.cyan, C.amber, C.purple, C.green, C.pink, '#8888a0'];

export function VolatilityPanel({ symbol, chain }: { symbol: string; chain: ChainSnapshot }) {
  const term = useMemo(() => termStructure(chain), [chain]);
  const skews = useMemo(() => skewByExpiry(chain), [chain]);
  const [picked, setPicked] = useState<string[]>(() => skews.filter((_, i) => i === 0 || i === 2 || i === 5).map((s) => s.expiry));
  const dayIdx = (e: string) => Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${term[0]?.expiry ?? e}T00:00:00Z`)) / 86400000);
  const shown = skews.filter((s) => picked.includes(s.expiry)).slice(0, SKEW_COLORS.length);
  const colorOf = (e: string) => SKEW_COLORS[skews.findIndex((s) => s.expiry === e) % SKEW_COLORS.length];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4" data-panel="volatility">
      <Panel id="iv-term" title={`IV Term Structure — ${symbol}`} subtitle="ATM IV per expiry (interpolated at spot), calls vs puts">
        <LinesChart height={280} xFmt={(x) => term.find((t) => dayIdx(t.expiry) === x)?.expiry ?? `+${x}d`} yFmt={(v) => `${(v * 100).toFixed(1)}%`}
          xLabels={term.filter((_, i) => i % Math.ceil(term.length / 8) === 0).map((t) => ({ x: dayIdx(t.expiry), label: t.expiry.slice(5) }))}
          series={[
            { id: 'c', label: 'Call IV', color: C.green, points: term.filter((t) => t.callIv != null).map((t) => ({ x: dayIdx(t.expiry), y: t.callIv! })) },
            { id: 'p', label: 'Put IV', color: C.red, dashed: true, points: term.filter((t) => t.putIv != null).map((t) => ({ x: dayIdx(t.expiry), y: t.putIv! })) },
          ]} />
      </Panel>
      <Panel id="iv-skew" title={`Fixed-Strike Skew by Expiry — ${symbol}`} subtitle="OTM IV by strike (puts below spot, calls above) · pick up to 6 expiries"
        actions={<div className="flex flex-wrap gap-1 max-w-[420px]">
          {skews.map((s) => (
            <button key={s.expiry} onClick={() => setPicked((p) => (p.includes(s.expiry) ? p.filter((x) => x !== s.expiry) : [...p, s.expiry].slice(-6)))}
              className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${picked.includes(s.expiry) ? 'border-accent-cyan/50 text-text-primary' : 'border-border text-text-muted'}`}>
              {picked.includes(s.expiry) && <span style={{ color: colorOf(s.expiry) }}>■ </span>}{s.expiry.slice(5)}
            </button>
          ))}
        </div>}>
        <LinesChart height={280} xFmt={(x) => String(x)} yFmt={(v) => `${(v * 100).toFixed(1)}%`} marker={{ x: chain.spot, label: `spot ${chain.spot.toFixed(2)}` }}
          series={shown.map((s) => ({ id: s.expiry, label: s.expiry, color: colorOf(s.expiry), points: s.points.map((p) => ({ x: p.strike, y: p.iv })) }))} />
      </Panel>
    </div>
  );
}
