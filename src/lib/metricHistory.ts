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

/**
 * Check if a given date is a US market trading day (not weekend, not known holiday).
 * Uses Eastern Time for date determination.
 */
function isMarketDay(date: Date): boolean {
  // Convert to ET for accurate day-of-week
  const etStr = date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [y, m, d] = etStr.split('-').map(Number);
  const etDate = new Date(y, m - 1, d);
  const dow = etDate.getDay();
  // Weekend check
  if (dow === 0 || dow === 6) return false;
  // Major US market holidays (fixed dates + observed rules)
  const mmdd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const fixedHolidays = [
    '01-01', // New Year's Day
    '06-19', // Juneteenth
    '07-04', // Independence Day
    '11-11', // Veterans Day (markets closed on observed)
    '12-25', // Christmas
  ];
  if (fixedHolidays.includes(mmdd)) return false;
  // MLK Day: 3rd Monday of January
  if (m === 1 && dow === 1 && d >= 15 && d <= 21) return false;
  // Presidents' Day: 3rd Monday of February
  if (m === 2 && dow === 1 && d >= 15 && d <= 21) return false;
  // Good Friday: skip (varies, hard to compute without full Easter algo)
  // Memorial Day: last Monday of May
  if (m === 5 && dow === 1 && d >= 25) return false;
  // Labor Day: 1st Monday of September
  if (m === 9 && dow === 1 && d <= 7) return false;
  // Thanksgiving: 4th Thursday of November
  if (m === 11 && dow === 4 && d >= 22 && d <= 28) return false;
  return true;
}

/**
 * Check if a metric record has meaningful data (not all zeros from API failures).
 * Returns true if at least some core fields have non-zero values.
 */
function hasSignificantData(record: DailyMetricRecord): boolean {
  // spotPrice must be positive (a $0 stock isn't real data)
  if (!record.spotPrice || record.spotPrice <= 0) return false;
  // At least one of these core fields should be non-zero
  return (
    record.totalGEX !== 0 ||
    record.totalDEX !== 0 ||
    record.volumePCR !== 0 ||
    record.currentIV !== 0 ||
    record.ivRank !== 0
  );
}

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

  // Guard: Don't save weekend/holiday data — it's stale from last close
  if (!isMarketDay(new Date(record.timestamp))) return;

  // Guard: Don't save all-zero records from API failures — they skew analytics
  if (!hasSignificantData(record)) return;

  try {
    const history = loadMetricHistory(symbol);

    // Replace today's record if it exists, but only if new data is better
    const existingIdx = history.findIndex(r => r.date === record.date);
    if (existingIdx >= 0) {
      // Keep the record with more non-zero fields (more complete data)
      const existing = history[existingIdx];
      const countNonZero = (r: DailyMetricRecord) =>
        [r.totalGEX, r.totalDEX, r.volumePCR, r.currentIV, r.ivRank, r.totalVanna, r.totalCharm]
          .filter(v => v !== 0).length;
      if (countNonZero(record) < countNonZero(existing) && record.timestamp <= existing.timestamp) {
        return; // Existing record is better, don't overwrite
      }
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
