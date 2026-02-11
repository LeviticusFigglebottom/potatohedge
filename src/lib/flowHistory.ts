/**
 * Daily flow tracking with server persistence.
 *
 * When the institutional tab loads, we save a snapshot of market-wide flow metrics.
 * Data is stored in:
 * 1. localStorage (immediate, device-local)
 * 2. Server (Upstash Redis / Vercel Blob) — auto-saved by institutional route + client sync
 *
 * Two scopes:
 * 1. Market-wide: net premium, P/C ratio, sentiment (from all 10 watchlist tickers)
 * 2. Per-ticker: net premium direction for each major ticker
 */

export interface DailyFlowRecord {
  date: string;       // YYYY-MM-DD
  timestamp: number;  // epoch ms

  // Market-wide aggregates
  netPremium: number;          // call premium - put premium ($)
  netCallPremium: number;
  netPutPremium: number;
  totalCallVolume: number;
  totalPutVolume: number;
  putCallRatio: number;
  sentiment: string;           // 'bullish' | 'bearish' | 'neutral'
  contractsAnalyzed: number;
  tickersScanned: number;

  // Per-ticker flow (top 10)
  perTicker: {
    ticker: string;
    netPremium: number;
    callPremium: number;
    putPremium: number;
  }[];

  // Alert summary
  sweepCount: number;
  blockCount: number;
  topAlertPremium: number;   // highest single alert premium

  // Market indicators (if available)
  vixPrice?: number;
  skewValue?: number;
}

const STORAGE_KEY_MARKET = 'optix_flow_history';
const STORAGE_KEY_TICKER = 'optix_flow_ticker_';
const MAX_RECORDS = 365;

// ─── Market-Wide Flow History ───────────────────────────────

export function loadFlowHistory(): DailyFlowRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MARKET);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DailyFlowRecord[];
  } catch {
    return [];
  }
}

export function saveFlowSnapshot(record: DailyFlowRecord): void {
  if (typeof window === 'undefined') return;
  try {
    const history = loadFlowHistory();
    const existingIdx = history.findIndex(r => r.date === record.date);
    if (existingIdx >= 0) {
      history[existingIdx] = record;
    } else {
      history.push(record);
    }
    history.sort((a, b) => a.timestamp - b.timestamp);
    const trimmed = history.slice(-MAX_RECORDS);
    localStorage.setItem(STORAGE_KEY_MARKET, JSON.stringify(trimmed));
  } catch {
    // localStorage full — silently fail
  }

  // Fire-and-forget: sync to server
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'flow', records: [record] }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ─── Per-Ticker Flow History ────────────────────────────────

export interface TickerFlowRecord {
  date: string;
  timestamp: number;
  netPremium: number;
  callPremium: number;
  putPremium: number;
  callVolume: number;
  putVolume: number;
}

export function loadTickerFlowHistory(ticker: string): TickerFlowRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_TICKER}${ticker.toUpperCase()}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TickerFlowRecord[];
  } catch {
    return [];
  }
}

export function saveTickerFlowSnapshot(ticker: string, record: TickerFlowRecord): void {
  if (typeof window === 'undefined') return;
  try {
    const history = loadTickerFlowHistory(ticker);
    const existingIdx = history.findIndex(r => r.date === record.date);
    if (existingIdx >= 0) {
      history[existingIdx] = record;
    } else {
      history.push(record);
    }
    history.sort((a, b) => a.timestamp - b.timestamp);
    const trimmed = history.slice(-MAX_RECORDS);
    localStorage.setItem(`${STORAGE_KEY_TICKER}${ticker.toUpperCase()}`, JSON.stringify(trimmed));
  } catch {
    // silently fail
  }

  // Fire-and-forget: sync per-ticker flow to server
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'flow', ticker: ticker.toUpperCase(), records: [record] }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ─── Server sync ───────────────────────────────────────────

/**
 * Load flow history from server and merge with localStorage.
 * Call once on institutional tab mount.
 */
export async function loadFlowHistoryWithSync(): Promise<DailyFlowRecord[]> {
  const local = loadFlowHistory();

  try {
    const res = await fetch('/api/history?type=flow&days=365', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return local;

    const { records: server } = await res.json() as { records: DailyFlowRecord[] };
    if (!server || server.length === 0) {
      if (local.length > 0) {
        fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'flow', records: local }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
      return local;
    }

    // Merge: server + local, dedup by date
    const byDate = new Map<string, DailyFlowRecord>();
    for (const r of server) byDate.set(r.date, r);
    for (const r of local) {
      const existing = byDate.get(r.date);
      if (!existing || r.timestamp > existing.timestamp) {
        byDate.set(r.date, r);
      }
    }

    const merged = Array.from(byDate.values());
    merged.sort((a, b) => a.timestamp - b.timestamp);
    const trimmed = merged.slice(-MAX_RECORDS);

    try {
      localStorage.setItem(STORAGE_KEY_MARKET, JSON.stringify(trimmed));
    } catch { /* ignore */ }

    if (local.length > server.length) {
      fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'flow', records: trimmed }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }

    return trimmed;
  } catch {
    return local;
  }
}

// ─── Flow Metric Definitions (for chart selector) ──────────

export const FLOW_METRICS: {
  key: keyof Omit<DailyFlowRecord, 'date' | 'timestamp' | 'perTicker' | 'sentiment'>;
  label: string;
  shortLabel: string;
  format: 'currency' | 'number' | 'ratio' | 'count';
  color: string;
}[] = [
  { key: 'netPremium', label: 'Net Premium Flow', shortLabel: 'Net Flow', format: 'currency', color: '#00e676' },
  { key: 'netCallPremium', label: 'Call Premium', shortLabel: 'Call $', format: 'currency', color: '#00e676' },
  { key: 'netPutPremium', label: 'Put Premium', shortLabel: 'Put $', format: 'currency', color: '#ff3d57' },
  { key: 'putCallRatio', label: 'Put/Call Ratio', shortLabel: 'P/C', format: 'ratio', color: '#ffaa00' },
  { key: 'totalCallVolume', label: 'Call Volume', shortLabel: 'Call Vol', format: 'number', color: '#00d4ff' },
  { key: 'totalPutVolume', label: 'Put Volume', shortLabel: 'Put Vol', format: 'number', color: '#b388ff' },
  { key: 'sweepCount', label: 'Sweeps Detected', shortLabel: 'Sweeps', format: 'count', color: '#e040fb' },
  { key: 'blockCount', label: 'Blocks Detected', shortLabel: 'Blocks', format: 'count', color: '#ff6e40' },
  { key: 'contractsAnalyzed', label: 'Contracts Analyzed', shortLabel: 'Contracts', format: 'number', color: '#8888a0' },
];
