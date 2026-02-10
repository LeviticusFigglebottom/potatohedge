/**
 * Daily metric tracking with server persistence.
 *
 * Each time the dashboard loads fresh data, we save a snapshot of key metrics.
 * Data is stored in:
 * 1. localStorage (immediate, device-local)
 * 2. Server (Upstash Redis / Vercel Blob) via /api/history endpoint
 *
 * On load, merges server history with localStorage for the most complete dataset.
 */

export interface DailyMetricRecord {
  date: string;       // YYYY-MM-DD
  timestamp: number;  // epoch ms
  spotPrice: number;
  volumePCR: number;
  oiPCR: number;
  totalCallVol: number;
  totalPutVol: number;
  totalGEX: number;
  totalDEX: number;
  totalVanna: number;
  totalCharm: number;
  ivRank: number;
  currentIV: number;
  hvCurrent: number;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number;
}

const STORAGE_PREFIX = 'optix_history_';
const MAX_RECORDS = 365;

function storageKey(symbol: string): string {
  return `${STORAGE_PREFIX}${symbol.toUpperCase()}`;
}

// ─── localStorage (device-local) ───────────────────────────

export function loadMetricHistory(symbol: string): DailyMetricRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DailyMetricRecord[];
  } catch {
    return [];
  }
}

export function saveMetricSnapshot(symbol: string, record: DailyMetricRecord): void {
  if (typeof window === 'undefined') return;
  try {
    const history = loadMetricHistory(symbol);

    // Replace today's record if it exists, otherwise append
    const existingIdx = history.findIndex(r => r.date === record.date);
    if (existingIdx >= 0) {
      history[existingIdx] = record;
    } else {
      history.push(record);
    }

    // Sort chronologically and trim to max
    history.sort((a, b) => a.timestamp - b.timestamp);
    const trimmed = history.slice(-MAX_RECORDS);

    localStorage.setItem(storageKey(symbol), JSON.stringify(trimmed));
  } catch {
    // localStorage full or unavailable — silently fail
  }

  // Fire-and-forget: sync to server
  syncMetricToServer(symbol, record).catch(() => {});
}

export function clearMetricHistory(symbol: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(storageKey(symbol));
  } catch {
    // ignore
  }
}

// ─── Server sync ───────────────────────────────────────────

/** Push a single record to the server (merges with existing server data) */
async function syncMetricToServer(symbol: string, record: DailyMetricRecord): Promise<void> {
  await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'metrics',
      ticker: symbol.toUpperCase(),
      records: [record],
    }),
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Load history from server and merge with localStorage.
 * Returns the merged result (most complete dataset).
 * Call this once on app load for the active ticker.
 */
export async function loadMetricHistoryWithSync(symbol: string): Promise<DailyMetricRecord[]> {
  const local = loadMetricHistory(symbol);

  try {
    const res = await fetch(`/api/history?type=metrics&ticker=${symbol.toUpperCase()}&days=365`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return local;

    const { records: server } = await res.json() as { records: DailyMetricRecord[] };
    if (!server || server.length === 0) {
      // No server data — push localStorage to server if we have some
      if (local.length > 0) {
        fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'metrics',
            ticker: symbol.toUpperCase(),
            records: local,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
      return local;
    }

    // Merge: server + local, dedup by date (most recent timestamp wins)
    const byDate = new Map<string, DailyMetricRecord>();
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

    // Update localStorage with merged data
    try {
      localStorage.setItem(storageKey(symbol), JSON.stringify(trimmed));
    } catch { /* ignore */ }

    // If local had records server didn't, sync back
    if (local.length > server.length) {
      fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'metrics',
          ticker: symbol.toUpperCase(),
          records: trimmed,
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }

    return trimmed;
  } catch {
    return local;
  }
}

/** All metric keys the user can explore */
export const METRIC_DEFINITIONS: {
  key: keyof Omit<DailyMetricRecord, 'date' | 'timestamp'>;
  label: string;
  shortLabel: string;
  format: 'number' | 'ratio' | 'percent' | 'currency' | 'currency_nullable';
  color: string;
}[] = [
  { key: 'volumePCR', label: 'Volume Put/Call Ratio', shortLabel: 'Vol P/C', format: 'ratio', color: '#00d4ff' },
  { key: 'oiPCR', label: 'OI Put/Call Ratio', shortLabel: 'OI P/C', format: 'ratio', color: '#b388ff' },
  { key: 'totalCallVol', label: 'Total Call Volume', shortLabel: 'Call Vol', format: 'number', color: '#00e676' },
  { key: 'totalPutVol', label: 'Total Put Volume', shortLabel: 'Put Vol', format: 'number', color: '#ff3d57' },
  { key: 'totalGEX', label: 'Net Gamma Exposure', shortLabel: 'Net GEX', format: 'number', color: '#00e676' },
  { key: 'totalDEX', label: 'Net Delta Exposure', shortLabel: 'Net DEX', format: 'number', color: '#ffaa00' },
  { key: 'totalVanna', label: 'Net Vanna', shortLabel: 'Vanna', format: 'number', color: '#e040fb' },
  { key: 'totalCharm', label: 'Net Charm', shortLabel: 'Charm', format: 'number', color: '#ff6e40' },
  { key: 'ivRank', label: 'IV Rank', shortLabel: 'IV Rank', format: 'number', color: '#ffaa00' },
  { key: 'currentIV', label: 'Current IV', shortLabel: 'IV', format: 'percent', color: '#b388ff' },
  { key: 'hvCurrent', label: 'Historical Volatility (20d)', shortLabel: 'HV20', format: 'percent', color: '#00d4ff' },
  { key: 'gammaFlip', label: 'Gamma Flip Level', shortLabel: 'γ Flip', format: 'currency_nullable', color: '#ffaa00' },
  { key: 'callWall', label: 'Call Wall', shortLabel: 'Call Wall', format: 'currency_nullable', color: '#00e676' },
  { key: 'putWall', label: 'Put Wall', shortLabel: 'Put Wall', format: 'currency_nullable', color: '#ff3d57' },
  { key: 'maxPain', label: 'Max Pain', shortLabel: 'Max Pain', format: 'currency', color: '#00d4ff' },
];
