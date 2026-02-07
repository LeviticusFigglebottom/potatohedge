import { create } from 'zustand';
import type { Quote, OHLCV, OptionsChain, OptionExpiration, Interval } from '@/types/market';
import type { StrikeExposure } from '@/lib/math/blackScholes';

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
  snapshotCount: number;
}

export type TabId = 'overview' | 'chain' | 'dealer' | 'volatility' | 'analytics';

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
  loading: Record<string, boolean>;
  error: string | null;
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
  loadSymbol: (s: string) => Promise<void>;
}

const api = async (path: string) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text().catch(() => 'Error')}`);
  return res.json();
};

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  activeTab: 'overview',
  setActiveTab: (tab) => set({ activeTab: tab }),

  symbol: 'SPY', quote: null, history: [], chain: null,
  expirations: [], selectedExpiration: null, interval: '1D',
  multiGEX: null, snapshot: null, recommendations: null,
  loading: {}, error: null, lastUpdate: 0,

  setSymbol: (symbol) => set({ symbol: symbol.toUpperCase() }),
  setInterval: (interval) => { set({ interval }); get().fetchHistory(); },
  setSelectedExpiration: (exp) => { set({ selectedExpiration: exp }); get().fetchChain(); },

  fetchQuote: async () => {
    set(s => ({ loading: { ...s.loading, quote: true }, error: null }));
    try {
      const quote = await api(`/api/market/quote?symbol=${get().symbol}`);
      set(s => ({ quote, loading: { ...s.loading, quote: false }, lastUpdate: Date.now() }));
    } catch (e) { set(s => ({ loading: { ...s.loading, quote: false }, error: (e as Error).message })); }
  },

  fetchHistory: async () => {
    set(s => ({ loading: { ...s.loading, history: true } }));
    try {
      const history = await api(`/api/market/history?symbol=${get().symbol}&interval=${get().interval}`);
      set(s => ({ history, loading: { ...s.loading, history: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, history: false }, error: (e as Error).message })); }
  },

  fetchExpirations: async () => {
    set(s => ({ loading: { ...s.loading, expirations: true } }));
    try {
      const expirations = await api(`/api/market/expirations?symbol=${get().symbol}`);
      const nearest = expirations[0]?.date || null;
      set(s => ({ expirations, selectedExpiration: nearest, loading: { ...s.loading, expirations: false } }));
      if (nearest) get().fetchChain();
    } catch (e) { set(s => ({ loading: { ...s.loading, expirations: false }, error: (e as Error).message })); }
  },

  fetchChain: async () => {
    const { symbol, selectedExpiration } = get();
    if (!selectedExpiration) return;
    set(s => ({ loading: { ...s.loading, chain: true } }));
    try {
      const chain = await api(`/api/market/chain?symbol=${symbol}&expiration=${selectedExpiration}`);
      set(s => ({ chain, loading: { ...s.loading, chain: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, chain: false }, error: (e as Error).message })); }
  },

  fetchMultiGEX: async () => {
    set(s => ({ loading: { ...s.loading, multiGEX: true } }));
    try {
      const multiGEX = await api(`/api/market/multi-gex?symbol=${get().symbol}&max=4`);
      set(s => ({ multiGEX, loading: { ...s.loading, multiGEX: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, multiGEX: false }, error: (e as Error).message })); }
  },

  fetchSnapshot: async () => {
    set(s => ({ loading: { ...s.loading, snapshot: true } }));
    try {
      const snapshot = await api(`/api/market/snapshot?symbol=${get().symbol}`);
      set(s => ({ snapshot, loading: { ...s.loading, snapshot: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, snapshot: false }, error: (e as Error).message })); }
  },

  fetchRecommendations: async () => {
    set(s => ({ loading: { ...s.loading, recommendations: true } }));
    try {
      const recommendations = await api(`/api/market/recommendations?symbol=${get().symbol}`);
      set(s => ({ recommendations, loading: { ...s.loading, recommendations: false } }));
    } catch (e) { set(s => ({ loading: { ...s.loading, recommendations: false }, error: (e as Error).message })); }
  },

  loadSymbol: async (symbol: string) => {
    set({
      symbol: symbol.toUpperCase(), quote: null, history: [], chain: null,
      expirations: [], selectedExpiration: null, multiGEX: null, snapshot: null,
      recommendations: null, error: null,
    });
    await Promise.allSettled([get().fetchQuote(), get().fetchHistory(), get().fetchExpirations()]);
    Promise.allSettled([get().fetchMultiGEX(), get().fetchSnapshot(), get().fetchRecommendations()]);
  },
}));
