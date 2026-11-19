'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, DatabaseZap, Loader2, AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { NoSource } from '@/lib/flowdesk/types';
import type { ApiState } from './useFlowDesk';

export function Panel({ id, title, subtitle, actions, children, className = '' }: { id: string; title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section data-panel={id} className={`bg-bg-secondary border border-border rounded-lg ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-border">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary font-display">{title}</h3>
          {subtitle && <div className="text-[11px] text-text-muted font-mono mt-0.5">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 text-xs">{actions}</div>}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function NoSourceState({ ns }: { ns: NoSource }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-10 px-4" data-state="no-source">
      <DatabaseZap className="w-6 h-6 text-accent-amber" />
      <div className="text-sm font-semibold text-text-primary">No data source configured</div>
      <div className="text-xs text-text-secondary max-w-md">{ns.reason}</div>
      <ul className="text-[11px] font-mono text-text-muted space-y-0.5">
        {ns.needs.map((n) => <li key={n}>needs: {n}</li>)}
      </ul>
      <div className="text-[11px] text-text-muted">Switch to <span className="text-accent-cyan">Demo</span> mode to see this panel with synthetic data.</div>
    </div>
  );
}

/** Render loading / no-source / error states, else children(data). */
export function Gate<T>({ states, children }: { states: ApiState<unknown>[]; children: () => ReactNode }) {
  const ns = states.find((s) => s.noSource)?.noSource;
  if (ns) return <NoSourceState ns={ns} />;
  const err = states.find((s) => s.error)?.error;
  if (err) {
    return (
      <div className="flex items-center gap-2 text-xs text-accent-red py-6 justify-center">
        <AlertTriangle className="w-4 h-4" /> {err}
      </div>
    );
  }
  if (states.some((s) => s.loading || s.data == null)) {
    return <div className="flex items-center justify-center py-10 text-text-muted"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }
  return <>{children()}</>;
}

export function SentimentBadge({ s }: { s: 'Bullish' | 'Bearish' | 'Neutral' }) {
  const cls = s === 'Bullish' ? 'bg-accent-green/10 text-accent-green border-accent-green/30'
    : s === 'Bearish' ? 'bg-accent-red/10 text-accent-red border-accent-red/30'
      : 'bg-bg-tertiary text-text-secondary border-border';
  const Icon = s === 'Bullish' ? TrendingUp : s === 'Bearish' ? TrendingDown : Minus;
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono ${cls}`}><Icon className="w-3 h-3" />{s}</span>;
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-text-secondary hover:text-text-primary">
      <input type="checkbox" className="accent-[#00d4ff]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden">
      {options.map((o) => (
        <button key={String(o.value)} onClick={() => onChange(o.value)}
          className={`px-2 py-1 text-[11px] font-mono ${o.value === value ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<R> {
  key: string;
  label: string;
  value: (r: R) => number | string;
  render?: (r: R) => ReactNode;
  align?: 'left' | 'right';
}

export function SortTable<R>({ rows, columns, initialSort, rowKey, maxRows, testId }: { rows: R[]; columns: Column<R>[]; initialSort: { key: string; dir: 'asc' | 'desc' }; rowKey: (r: R) => string; maxRows?: number; testId?: string }) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) ?? columns[0];
    const out = [...rows].sort((a, b) => {
      const va = col.value(a), vb = col.value(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return maxRows ? out.slice(0, maxRows) : out;
  }, [rows, columns, sort, maxRows]);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono" data-testid={testId}>
        <thead>
          <tr className="text-text-muted border-b border-border">
            {columns.map((c) => (
              <th key={c.key} className={`px-2 py-1.5 font-medium whitespace-nowrap ${c.align === 'left' ? 'text-left' : 'text-right'}`}>
                <button className="inline-flex items-center gap-1 hover:text-text-primary" aria-label={`Sort by ${c.label}`}
                  onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
                  {c.label}
                  {sort.key === c.key && (sort.dir === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)} className="border-b border-border/40 hover:bg-bg-hover/50">
              {columns.map((c) => (
                <td key={c.key} className={`px-2 py-1.5 whitespace-nowrap ${c.align === 'left' ? 'text-left' : 'text-right'} text-text-primary`}>
                  {c.render ? c.render(r) : String(c.value(r))}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={columns.length} className="text-center text-text-muted py-6">No prints in this window</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Signed $ value: sign shown with ▲/▼ glyph so colour is not the only cue. */
export function Signed({ v, fmt }: { v: number; fmt: (v: number) => string }) {
  const cls = v > 0 ? 'text-accent-green' : v < 0 ? 'text-accent-red' : 'text-text-secondary';
  return <span className={cls}>{v > 0 ? '▲ ' : v < 0 ? '▼ ' : ''}{fmt(v)}</span>;
}
