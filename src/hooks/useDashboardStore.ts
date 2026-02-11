import { create } from 'zustand';
import type { Quote, OHLCV, OptionsChain, OptionExpiration, Interval } from '@/types/market';
import type { StrikeExposure } from '@/lib/math/blackScholes';
import type { CorrelationResult } from '@/lib/math/correlations';
import { saveMetricSnapshot, loadMetricHistory, loadMetricHistoryWithSync, type DailyMetricRecord } from '@/lib/metricHistory';

// ─── Phase 2 Types ─────────────────────────────────────────

interface PerExpData {
  expiration: string; dte: number;
  totalGEX: number; totalDEX: number; totalVanna: number; totalCharm: number;
  callVolume: number; putVolume: number; callOI: number; putOI: number;
  volumePCR: number; oiPCR: number;
  exposures: StrikeExposure[];
}

interface ContextBlock {
  dealer: { gexRegime: string; dexBias: string; spotVsGammaFlip: string; keyLevels: { level: string; price: number; distance: number; interpretation: string }[]; interpretation: string };
  volume: { callVolRatio: number; putVolRatio: number; totalVolRatio: number; pcrToday: number; pcrAvg: number; interpretation: string };
  skew: { skew25d: number; skewRatio: number; skewBias: string; interpretation: string };
  oi: { topCallStrikes: { strike: number; oi: number; pctOfTotal: number }[]; topPutStrikes: { strike: number; oi: number; pctOfTotal: number }[]; interpretation: string };
}

export interface MultiGEXData {
  spotPrice: number;
  expirationsCovered: string[];
  aggregated: {
    totalGEX: number; totalDEX: number; totalVanna: number; totalCharm: number;
    gammaFlip: number | null; callWall: number | null; putWall: number | null;
    exposures: StrikeExposure[];
  };
  perExpiration: PerExpData[];
  volume: { totalCallVol: number; totalPutVol: number; totalCallOI: number; totalPutOI: number; volumePCR: number; oiPCR: number };
  maxPain: { strike: number; totalPain: number; distribution: { strike: number; callPain: number; putPain: number; totalPain: number }[] };
  context: ContextBlock;
}

export interface SnapshotData {
  spotPrice: number;
  iv: { currentIV: number; ivRank: number; ivPercentile: number; iv30dMA: number; iv52wHigh: number; iv52wLow: number; hvCurrent: number; ivHvRatio: number; interpretation: string };
  termStructure: { expiration: string; dte: number; atmIV: number }[];
  skewSurface: { expiration: string; dte: number; points: { strike: number; iv: number; type: string; delta: number }[] }[];
  historicalVol: { hv20: number; hv60: number };
  ivTimeSeries?: { time: number; hv20: number; ivProxy: number; ivRank: number }[];
  vix?: { price: number; change: number; changePct: number } | null;
  vixTimeSeries?: { time: number; vix: number }[];
  snapshotCount: number;
}

export type TabId = 'overview' | 'chain' | 'dealer' | 'volatility' | 'analytics' | 'screener' | 'institutional' | 'briefing' | 'paper';

export interface RecommendationData {
  symbol: string;
  spotPrice: number;
  overallBias: 'bullish' | 'bearish' | 'neutral';
  biasScore: number;
  volRegime: 'high' | 'mid' | 'low';
  gammaRegime: 'long' | 'short' | 'neutral';
  signals: { name: string; direction: string; weight: number; description: string }[];
  trades: {
    strategy: string; direction: string; confidence: string; score: number;
    expiration: string; strikes: string; entry: string; risk: string;
    reasoning: string[]; tags: string[];
  }[];
  warnings: string[];
  moveContext: string;
  stockContext: string;
}

interface DashboardStore {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  symbol: string;
  quote: Quote | null;
  history: OHLCV[];
  chain: OptionsChain | null;
  expirations: OptionExpiration[];
  selectedExpiration: string | null;
  interval: Interval;
  multiGEX: MultiGEXData | null;
  snapshot: SnapshotData | null;
  recommendations: RecommendationData | null;
  correlations: CorrelationResult | null;
  metricHistory: DailyMetricRecord[];
  loading: Record<string, boolean>;
  error: string | null;
  errors: string[];
  diagnostics: { debug?: unknown; health?: unknown; ranAt?: string } | null;
  lastUpdate: number;

  setSymbol: (s: string) => void;
  setInterval: (i: Interval) => void;
  setSelectedExpiration: (e: string) => void;
  fetchQuote: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  fetchExpirations: () => Promise<void>;
  fetchChain: () => Promise<void>;
  fetchMultiGEX: () => Promise<void>;
  fetchSnapshot: () => Promise<void>;
  fetchRecommendations: () => Promise<void>;
  fetchCorrelations: () => Promise<void>;
  loadSymbol: (s: string) => Promise<void>;
  saveAndLoadMetricHistory: () => void;
  runDiagnostics: () => Promise<void>;
}

const api = async (path: string) => {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.text().catch(() => 'Error');
    // Truncate HTML bodies to show just enough to identify the error type
    const isHtml = body.includes('<!DOCTYPE') || body.includes('<html');
    const truncated = isHtml ? `[HTML error page - serverless function crashed]` : (body.length > 300 ? body.slice(0, 200) + '...' : body);
    throw new Error(`[${path}] ${res.status}: ${truncated}`);
  }
  return res.json();
};

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  activeTab: 'overview',
  setActiveTab: (tab) => set({ activeTab: tab }),

  symbol: 'SPY', quote: null, history: [], chain: null,
  expirations: [], selectedExpiration: null, interval: '1D',
  multiGEX: null, snapshot: null, recommendations: null, correlations: null,
  metricHistory: [],
  loading: {}, error: null, errors: [], diagnostics: null, lastUpdate: 0,

  setSymbol: (symbol) => set({ symbol: symbol.toUpperCase() }),
  setInterval: (interval) => { set({ interval }); get().fetchHistory(); },
  setSelectedExpiration: (exp) => { set({ selectedExpiration: exp }); get().fetchChain(); },

  fetchQuote: async () => {
    set(s => ({ loading: { ...s.loading, quote: true } }));
    try {
      const quote = await api(`/api/market/quote?symbol=${get().symbol}`);
      set(s => ({ quote, loading: { ...s.loading, quote: false }, lastUpdate: Date.now() }));
    } catch (e) { set(s => ({ loading: { ...s.loading, quote: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  fetchHistory: async () => {
    set(s => ({ loading: { ...s.loading, history: true } }));
    try {
      const history = await api(`/api/market/history?symbol=${get().symbol}&interval=${get().interval}`);
      set(s => ({ history, loading: { ...s.loading, history: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, history: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  fetchExpirations: async () => {
    set(s => ({ loading: { ...s.loading, expirations: true } }));
    try {
      const expirations = await api(`/api/market/expirations?symbol=${get().symbol}`);
      const nearest = expirations[0]?.date || null;
      set(s => ({ expirations, selectedExpiration: nearest, loading: { ...s.loading, expirations: false } }));
      if (nearest) get().fetchChain();
    } catch (e) { set(s => ({ loading: { ...s.loading, expirations: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  fetchChain: async () => {
    const { symbol, selectedExpiration } = get();
    if (!selectedExpiration) return;
    set(s => ({ loading: { ...s.loading, chain: true } }));
    try {
      const chain = await api(`/api/market/chain?symbol=${symbol}&expiration=${selectedExpiration}`);
      set(s => ({ chain, loading: { ...s.loading, chain: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, chain: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  fetchMultiGEX: async () => {
    set(s => ({ loading: { ...s.loading, multiGEX: true } }));
    try {
      const multiGEX = await api(`/api/market/multi-gex?symbol=${get().symbol}&max=4`);
      set(s => ({ multiGEX, loading: { ...s.loading, multiGEX: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, multiGEX: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  fetchSnapshot: async () => {
    set(s => ({ loading: { ...s.loading, snapshot: true } }));
    try {
      const snapshot = await api(`/api/market/snapshot?symbol=${get().symbol}`);
      set(s => ({ snapshot, loading: { ...s.loading, snapshot: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, snapshot: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  fetchRecommendations: async () => {
    set(s => ({ loading: { ...s.loading, recommendations: true } }));
    try {
      const data = await api(`/api/market/recommendations?symbol=${get().symbol}`);
      // Validate response shape — stripped/debug routes may return different shapes
      const valid = data && Array.isArray(data.signals) && Array.isArray(data.trades);
      set(s => ({ recommendations: valid ? data : null, loading: { ...s.loading, recommendations: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, recommendations: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  fetchCorrelations: async () => {
    set(s => ({ loading: { ...s.loading, correlations: true } }));
    try {
      const correlations = await api(`/api/market/correlations?symbol=${get().symbol}`);
      set(s => ({ correlations, loading: { ...s.loading, correlations: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, correlations: false }, error: (e as Error).message, errors: [...s.errors, (e as Error).message] })); }
  },

  saveAndLoadMetricHistory: () => {
    // Capture symbol at call time to prevent race condition on rapid symbol switching
    const { symbol, quote, multiGEX, snapshot } = get();
    const capturedSymbol = symbol;

    // Need at least some data to save a meaningful record
    if (!multiGEX && !snapshot && !quote) {
      // No data at all — just try to load existing history
      loadMetricHistoryWithSync(capturedSymbol).then(merged => {
        // Only update state if we're still on the same symbol
        if (get().symbol === capturedSymbol && merged.length > 0) set({ metricHistory: merged });
      }).catch(() => {
        if (get().symbol !== capturedSymbol) return;
        const existing = loadMetricHistory(capturedSymbol);
        if (existing.length > 0) set({ metricHistory: existing });
      });
      return;
    }

    // Build record — use ET date for consistency with market calendar
    const now = new Date();
    const date = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const record: DailyMetricRecord = {
      date,
      timestamp: Date.now(),
      spotPrice: multiGEX?.spotPrice ?? quote?.last ?? 0,
      volumePCR: multiGEX?.volume?.volumePCR ?? 0,
      oiPCR: multiGEX?.volume?.oiPCR ?? 0,
      totalCallVol: multiGEX?.volume?.totalCallVol ?? 0,
      totalPutVol: multiGEX?.volume?.totalPutVol ?? 0,
      totalGEX: multiGEX?.aggregated?.totalGEX ?? 0,
      totalDEX: multiGEX?.aggregated?.totalDEX ?? 0,
      totalVanna: multiGEX?.aggregated?.totalVanna ?? 0,
      totalCharm: multiGEX?.aggregated?.totalCharm ?? 0,
      ivRank: snapshot?.iv?.ivRank ?? 0,
      currentIV: snapshot?.iv?.currentIV ?? 0,
      hvCurrent: snapshot?.iv?.hvCurrent ?? 0,
      gammaFlip: multiGEX?.aggregated?.gammaFlip ?? null,
      callWall: multiGEX?.aggregated?.callWall ?? null,
      putWall: multiGEX?.aggregated?.putWall ?? null,
      maxPain: multiGEX?.maxPain?.strike ?? 0,
    };
    saveMetricSnapshot(capturedSymbol, record);

    // Only update state if still on same symbol
    if (get().symbol === capturedSymbol) {
      set({ metricHistory: loadMetricHistory(capturedSymbol) });
    }

    // Async: merge with server data (updates state when ready)
    loadMetricHistoryWithSync(capturedSymbol).then(merged => {
      if (get().symbol === capturedSymbol && merged.length > 0) set({ metricHistory: merged });
    }).catch(() => {});
  },

  runDiagnostics: async () => {
    const sym = get().symbol || 'SPY';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diag: Record<string, any> = { ranAt: new Date().toISOString() };

    // Test 1: bare debug endpoint
    try {
      const r = await fetch('/api/debug');
      diag.debug = r.ok ? await r.json() : { status: r.status, html: r.headers.get('content-type')?.includes('html') };
    } catch (e) { diag.debug = { error: (e as Error).message }; }

    // Test 2: health endpoint (imports all modules)
    try {
      const r = await fetch('/api/health');
      diag.health = r.ok ? await r.json() : { status: r.status, html: r.headers.get('content-type')?.includes('html') };
    } catch (e) { diag.health = { error: (e as Error).message }; }

    // Test 3: stripped /recommendations (bare minimum — just returns JSON)
    try {
      const r = await fetch(`/api/market/recommendations?symbol=${sym}`);
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) {
        diag.recsStripped = { _status: r.status, ...(await r.json()) };
      } else {
        diag.recsStripped = { _status: r.status, html: ct.includes('html'), contentType: ct };
      }
    } catch (e) { diag.recsStripped = { error: (e as Error).message }; }

    // Test 4: new /recs endpoint (full computation at fresh path — step-by-step diagnostics)
    try {
      const r = await fetch(`/api/market/recs?symbol=${sym}`);
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) {
        diag.recsFull = { _status: r.status, ...(await r.json()) };
      } else {
        diag.recsFull = { _status: r.status, html: ct.includes('html'), contentType: ct };
      }
    } catch (e) { diag.recsFull = { error: (e as Error).message }; }

    set({ diagnostics: diag });
  },

  loadSymbol: async (symbol: string) => {
    set({
      symbol: symbol.toUpperCase(), quote: null, history: [], chain: null,
      expirations: [], selectedExpiration: null, multiGEX: null, snapshot: null,
      recommendations: null, correlations: null, metricHistory: [], error: null, errors: [],
    });
    const existing = loadMetricHistory(symbol.toUpperCase());
    if (existing.length > 0) set({ metricHistory: existing });

    // Run diagnostics in background while loading data
    get().runDiagnostics();

    await Promise.allSettled([get().fetchQuote(), get().fetchHistory(), get().fetchExpirations()]);
    await Promise.allSettled([get().fetchMultiGEX(), get().fetchSnapshot(), get().fetchRecommendations(), get().fetchCorrelations()]);
    get().saveAndLoadMetricHistory();
  },
}));
