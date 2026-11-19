'use client';

import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { DEFAULT_FLOW_SETTINGS, type DataMode, type FlowSettings, type NoSource, type SourceStatus } from '@/lib/flowdesk/types';
import { enrich, type EnrichedTrade } from '@/lib/flowdesk/flow/aggregate';
import type { ChainSnapshot, OptionTrade } from '@/lib/flowdesk/types';

export type DeskPanel = 'flow' | 'heatmap' | 'greeks' | 'vol' | 'tape' | 'msi' | 'summary' | 'elmod';

interface DeskState {
  mode: DataMode;
  panel: DeskPanel;
  settings: FlowSettings;
  setMode: (m: DataMode) => void;
  setPanel: (p: DeskPanel) => void;
  setSettings: (s: Partial<FlowSettings>) => void;
}

const LS_KEY = 'optix_flowdesk_v1';

function initial(): Pick<DeskState, 'mode' | 'panel' | 'settings'> {
  const base = { mode: 'live' as DataMode, panel: 'flow' as DeskPanel, settings: DEFAULT_FLOW_SETTINGS };
  if (typeof window === 'undefined') return base;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const q = new URLSearchParams(window.location.search);
    return {
      mode: q.get('demo') === '1' ? 'demo' : q.get('demo') === '0' ? 'live' : saved.mode ?? base.mode,
      panel: (q.get('panel') as DeskPanel) || saved.panel || base.panel,
      settings: { ...DEFAULT_FLOW_SETTINGS, ...(saved.settings ?? {}) },
    };
  } catch {
    return base;
  }
}

export const useDesk = create<DeskState>((set, get) => {
  const persist = () => {
    const { mode, panel, settings } = get();
    try { localStorage.setItem(LS_KEY, JSON.stringify({ mode, panel, settings })); } catch { /* ignore */ }
  };
  return {
    ...initial(),
    setMode: (mode) => { set({ mode }); persist(); },
    setPanel: (panel) => { set({ panel }); persist(); },
    setSettings: (s) => { set({ settings: { ...get().settings, ...s } }); persist(); },
  };
});

export interface ApiState<T> {
  data: T | null;
  noSource: NoSource | null;
  error: string | null;
  loading: boolean;
}

/** GET a Flow Desk API endpoint. Responses are {data} | {noSource,...} | {error}. */
export function useApi<T>(url: string | null): ApiState<T> & { reload: () => void } {
  const [state, setState] = useState<ApiState<T>>({ data: null, noSource: null, error: null, loading: !!url });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        if (!alive) return;
        if (body.noSource) setState({ data: null, noSource: body as NoSource, error: null, loading: false });
        else if (body.error) setState({ data: null, noSource: null, error: String(body.error), loading: false });
        else setState({ data: (body.data ?? body) as T, noSource: null, error: null, loading: false });
      })
      .catch((e) => alive && setState({ data: null, noSource: null, error: String(e), loading: false }));
    return () => { alive = false; };
  }, [url, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

export interface DeskStatus {
  mode: DataMode;
  session: string;
  nowMs: number;
  sources: SourceStatus;
  universe: string[];
  summaryBackend: 'worker' | 'sqlite';
}

export function useStatus() {
  const mode = useDesk((s) => s.mode);
  return useApi<DeskStatus>(`/api/flow-desk/status?mode=${mode}`);
}

export function useTrades(symbols: string[], days = 1) {
  const mode = useDesk((s) => s.mode);
  const settings = useDesk((s) => s.settings);
  const key = symbols.join(',');
  const api = useApi<OptionTrade[]>(symbols.length ? `/api/flow-desk/trades?mode=${mode}&days=${days}&symbols=${encodeURIComponent(key)}` : null);
  const enriched = useMemo<EnrichedTrade[] | null>(
    () => (api.data ? enrich(api.data, settings) : null),
    [api.data, settings],
  );
  return { ...api, enriched };
}

export function useChain(symbol: string) {
  const mode = useDesk((s) => s.mode);
  return useApi<ChainSnapshot>(symbol ? `/api/flow-desk/chain?mode=${mode}&symbol=${encodeURIComponent(symbol)}` : null);
}
