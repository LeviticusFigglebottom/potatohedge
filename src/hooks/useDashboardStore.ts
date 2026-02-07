import { create } from 'zustand';
import type { Quote, OHLCV, OptionsChain, OptionExpiration, Interval } from '@/types/market';
import type { StrikeExposure } from '@/lib/math/blackScholes';

interface Analytics {
  gex: {
    totalGEX: number;
    gammaFlip: number | null;
    callWall: number | null;
    putWall: number | null;
    maxGammaStrike: number;
    exposures: StrikeExposure[];
    spotPrice: number;
  };
  maxPain: { strike: number; totalPain: number; distribution: { strike: number; callPain: number; putPain: number; totalPain: number }[] };
  pcr: { volumePCR: number; oiPCR: number; totalCallVol: number; totalPutVol: number; totalCallOI: number; totalPutOI: number };
  interpretations: string[];
}

interface DashboardStore {
  // State
  symbol: string;
  quote: Quote | null;
  history: OHLCV[];
  chain: OptionsChain | null;
  expirations: OptionExpiration[];
  selectedExpiration: string | null;
  interval: Interval;
  analytics: Analytics | null;

  loading: {
    quote: boolean;
    history: boolean;
    chain: boolean;
    expirations: boolean;
    analytics: boolean;
  };
  error: string | null;
  lastUpdate: number;

  // Actions
  setSymbol: (symbol: string) => void;
  setInterval: (interval: Interval) => void;
  setSelectedExpiration: (exp: string) => void;
  fetchQuote: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  fetchExpirations: () => Promise<void>;
  fetchChain: () => Promise<void>;
  fetchAnalytics: () => Promise<void>;
  loadSymbol: (symbol: string) => Promise<void>;
}

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  symbol: 'SPY',
  quote: null,
  history: [],
  chain: null,
  expirations: [],
  selectedExpiration: null,
  interval: '1D',
  analytics: null,

  loading: {
    quote: false,
    history: false,
    chain: false,
    expirations: false,
    analytics: false,
  },
  error: null,
  lastUpdate: 0,

  setSymbol: (symbol) => set({ symbol: symbol.toUpperCase() }),

  setInterval: (interval) => {
    set({ interval });
    get().fetchHistory();
  },

  setSelectedExpiration: (exp) => {
    set({ selectedExpiration: exp });
    get().fetchChain();
    get().fetchAnalytics();
  },

  fetchQuote: async () => {
    const { symbol } = get();
    set((s) => ({ loading: { ...s.loading, quote: true }, error: null }));
    try {
      const res = await fetch(`/api/market/quote?symbol=${symbol}`);
      if (!res.ok) throw new Error(await res.text());
      const quote = await res.json();
      set((s) => ({ quote, loading: { ...s.loading, quote: false }, lastUpdate: Date.now() }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, quote: false },
        error: err instanceof Error ? err.message : 'Failed to fetch quote',
      }));
    }
  },

  fetchHistory: async () => {
    const { symbol, interval } = get();
    set((s) => ({ loading: { ...s.loading, history: true } }));
    try {
      const res = await fetch(`/api/market/history?symbol=${symbol}&interval=${interval}`);
      if (!res.ok) throw new Error(await res.text());
      const history = await res.json();
      set((s) => ({ history, loading: { ...s.loading, history: false } }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, history: false },
        error: err instanceof Error ? err.message : 'Failed to fetch history',
      }));
    }
  },

  fetchExpirations: async () => {
    const { symbol } = get();
    set((s) => ({ loading: { ...s.loading, expirations: true } }));
    try {
      const res = await fetch(`/api/market/expirations?symbol=${symbol}`);
      if (!res.ok) throw new Error(await res.text());
      const expirations = await res.json();
      // Auto-select nearest expiration
      const nearest = expirations[0]?.date || null;
      set((s) => ({
        expirations,
        selectedExpiration: nearest,
        loading: { ...s.loading, expirations: false },
      }));
      // Fetch chain for nearest expiration
      if (nearest) {
        get().fetchChain();
        get().fetchAnalytics();
      }
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, expirations: false },
        error: err instanceof Error ? err.message : 'Failed to fetch expirations',
      }));
    }
  },

  fetchChain: async () => {
    const { symbol, selectedExpiration } = get();
    if (!selectedExpiration) return;
    set((s) => ({ loading: { ...s.loading, chain: true } }));
    try {
      const res = await fetch(`/api/market/chain?symbol=${symbol}&expiration=${selectedExpiration}`);
      if (!res.ok) throw new Error(await res.text());
      const chain = await res.json();
      set((s) => ({ chain, loading: { ...s.loading, chain: false } }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, chain: false },
        error: err instanceof Error ? err.message : 'Failed to fetch chain',
      }));
    }
  },

  fetchAnalytics: async () => {
    const { symbol, selectedExpiration } = get();
    if (!selectedExpiration) return;
    set((s) => ({ loading: { ...s.loading, analytics: true } }));
    try {
      const res = await fetch(`/api/market/greeks?symbol=${symbol}&expiration=${selectedExpiration}`);
      if (!res.ok) throw new Error(await res.text());
      const analytics = await res.json();
      set((s) => ({ analytics, loading: { ...s.loading, analytics: false } }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, analytics: false },
        error: err instanceof Error ? err.message : 'Failed to fetch analytics',
      }));
    }
  },

  loadSymbol: async (symbol: string) => {
    set({
      symbol: symbol.toUpperCase(),
      quote: null,
      history: [],
      chain: null,
      expirations: [],
      selectedExpiration: null,
      analytics: null,
      error: null,
    });

    // Parallel fetch
    await Promise.allSettled([
      get().fetchQuote(),
      get().fetchHistory(),
      get().fetchExpirations(),
    ]);
  },
}));
