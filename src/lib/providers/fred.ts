/**
 * FRED (Federal Reserve Economic Data) Provider
 *
 * Free API for CBOE market sentiment indicators:
 * - VIX (VIXCLS) — market fear gauge
 * - SKEW (SKEWCLS) — tail risk indicator
 *
 * Register for a free API key at: https://fred.stlouisfed.org/docs/api/api_key.html
 * Set FRED_API_KEY env var.
 */

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const FETCH_TIMEOUT = 8000;

function apiKey(): string {
  return process.env.FRED_API_KEY || '';
}

export function isFREDAvailable(): boolean {
  return !!apiKey();
}

interface FREDObservation {
  date: string;
  value: string;
}

export interface MarketIndicator {
  current: number;
  previous: number;
  change: number;
  changePercent: number;
  date: string;
}

// ─── Cache ──────────────────────────────────────────────────
let indicatorCache: { data: { vix: MarketIndicator | null; skew: MarketIndicator | null }; timestamp: number } | null = null;
const CACHE_TTL = 3600_000; // 1 hour (FRED updates daily)

async function fetchSeries(seriesId: string): Promise<FREDObservation[]> {
  const key = apiKey();
  if (!key) return [];

  const url = new URL(FRED_BASE);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '10');

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`FRED ${seriesId}: ${res.status}`);
  const data = await res.json();
  // FRED uses "." for missing values
  return (data.observations || []).filter((o: FREDObservation) => o.value !== '.');
}

function toIndicator(obs: FREDObservation[]): MarketIndicator | null {
  if (obs.length < 1) return null;
  const current = parseFloat(obs[0].value);
  const previous = obs.length > 1 ? parseFloat(obs[1].value) : current;
  const change = current - previous;
  const changePercent = previous !== 0 ? (change / previous) * 100 : 0;
  return {
    current,
    previous,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePercent * 100) / 100,
    date: obs[0].date,
  };
}

/**
 * Fetch VIX historical time series. Cached for 1 hour.
 * Returns daily VIX close values for up to `count` recent observations.
 */
let vixHistoryCache: { data: { date: string; value: number }[]; timestamp: number } | null = null;

export async function getVIXHistory(count: number = 252): Promise<{ date: string; value: number }[]> {
  if (vixHistoryCache && Date.now() - vixHistoryCache.timestamp < CACHE_TTL) {
    return vixHistoryCache.data.slice(0, count);
  }

  if (!apiKey()) return [];

  const url = new URL(FRED_BASE);
  url.searchParams.set('series_id', 'VIXCLS');
  url.searchParams.set('api_key', apiKey());
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', String(Math.min(count, 500)));

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const observations: FREDObservation[] = (data.observations || []).filter(
      (o: FREDObservation) => o.value !== '.'
    );
    const result = observations.map(o => ({ date: o.date, value: parseFloat(o.value) }));
    vixHistoryCache = { data: result, timestamp: Date.now() };
    return result.slice(0, count);
  } catch {
    return [];
  }
}

/**
 * Fetch VIX and SKEW indicators. Cached for 1 hour.
 */
export async function getMarketIndicators(): Promise<{
  vix: MarketIndicator | null;
  skew: MarketIndicator | null;
}> {
  if (indicatorCache && Date.now() - indicatorCache.timestamp < CACHE_TTL) {
    return indicatorCache.data;
  }

  if (!apiKey()) {
    return { vix: null, skew: null };
  }

  const [vixObs, skewObs] = await Promise.allSettled([
    fetchSeries('VIXCLS'),
    fetchSeries('SKEWCLS'),
  ]);

  const data = {
    vix: vixObs.status === 'fulfilled' ? toIndicator(vixObs.value) : null,
    skew: skewObs.status === 'fulfilled' ? toIndicator(skewObs.value) : null,
  };

  indicatorCache = { data, timestamp: Date.now() };

  if (data.vix) console.log(`[FRED] VIX: ${data.vix.current} (${data.vix.date})`);
  if (data.skew) console.log(`[FRED] SKEW: ${data.skew.current} (${data.skew.date})`);

  return data;
}
