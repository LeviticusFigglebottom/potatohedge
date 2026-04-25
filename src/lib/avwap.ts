/**
 * AVWAP (Anchored Volume-Weighted Average Price) calculation library.
 *
 * Pure functions operating on bar arrays — no side effects, no API calls.
 * All bar arrays must be sorted ascending by timestamp.
 */

export interface Bar {
  t: number;   // timestamp in milliseconds
  o: number;   // open
  h: number;   // high
  l: number;   // low
  c: number;   // close
  v: number;   // volume
  vw?: number; // volume-weighted average price for the bar
}

/**
 * Compute AVWAP from a specific anchor index forward.
 * Uses vw (volume-weighted price) as the price input when available,
 * falls back to typical price (H+L+C)/3.
 *
 * If anchorIndex is -1 (out-of-range, see findAnchorIndex) or refers to
 * the last bar, returns an all-null array. A single-point AVWAP is not
 * meaningful and the chart layer would otherwise render it as a flat
 * horizontal price line.
 */
export function computeAVWAP(bars: Bar[], anchorIndex: number): (number | null)[] {
  const result: (number | null)[] = new Array(bars.length).fill(null);
  if (anchorIndex < 0 || anchorIndex >= bars.length - 1) return result;

  let cumulativePV = 0;
  let cumulativeV = 0;

  for (let i = anchorIndex; i < bars.length; i++) {
    const bar = bars[i];
    const price = bar.vw ?? (bar.h + bar.l + bar.c) / 3;
    cumulativePV += price * bar.v;
    cumulativeV += bar.v;
    result[i] = cumulativeV > 0 ? cumulativePV / cumulativeV : null;
  }

  return result;
}

/**
 * Compute standard deviation bands around an AVWAP series.
 * Variance = E[X^2] - E[X]^2 where X is volume-weighted price.
 */
export function computeAVWAPBands(
  bars: Bar[],
  anchorIndex: number,
  avwapSeries: (number | null)[],
  sigma: number = 1
): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(bars.length).fill(null);
  const lower: (number | null)[] = new Array(bars.length).fill(null);
  if (anchorIndex < 0 || anchorIndex >= bars.length - 1) return { upper, lower };

  let cumulativePV2 = 0;
  let cumulativeV = 0;

  for (let i = anchorIndex; i < bars.length; i++) {
    const bar = bars[i];
    const price = bar.vw ?? (bar.h + bar.l + bar.c) / 3;
    cumulativePV2 += price * price * bar.v;
    cumulativeV += bar.v;

    const avwap = avwapSeries[i];
    if (avwap !== null && cumulativeV > 0) {
      const variance = cumulativePV2 / cumulativeV - avwap * avwap;
      const stdDev = variance > 0 ? Math.sqrt(variance) : 0;
      upper[i] = avwap + sigma * stdDev;
      lower[i] = avwap - sigma * stdDev;
    }
  }

  return { upper, lower };
}

/**
 * Compute Mean Absolute Deviation from AVWAP per bar.
 * MAD[i] = |price[i] - avwap[i]|
 */
export function computeMAD(bars: Bar[], avwapSeries: (number | null)[]): (number | null)[] {
  return bars.map((bar, i) => {
    const avwap = avwapSeries[i];
    if (avwap === null) return null;
    const price = bar.vw ?? (bar.h + bar.l + bar.c) / 3;
    return Math.abs(price - avwap);
  });
}

/**
 * Determine MAD state: compressing, neutral, or expanding.
 * Uses linear regression slope on the last N bars to assess the trend.
 */
export function classifyMADState(
  madSeries: (number | null)[],
  lookback: number = 10
): { state: 'compressing' | 'neutral' | 'expanding'; roc: number } {
  const recent = madSeries.filter((v): v is number => v !== null).slice(-lookback);
  if (recent.length < 4) return { state: 'neutral', roc: 0 };

  const n = recent.length;
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (recent[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const rocNormalized = slope / (yMean || 1);

  if (rocNormalized < -0.02) return { state: 'compressing', roc: rocNormalized };
  if (rocNormalized > 0.02) return { state: 'expanding', roc: rocNormalized };
  return { state: 'neutral', roc: rocNormalized };
}

/**
 * Compute time-of-day bucketed Relative Volume.
 * Buckets bars into 30-minute windows by Eastern Time.
 * Compares current bar's volume to the average for its time bucket over prior sessions.
 */
export function computeRVOL(bars: Bar[], lookbackSessions: number = 20): (number | null)[] {
  // Group bars by Eastern Time date (trading session boundary)
  const byDate: Record<string, Bar[]> = {};
  for (const bar of bars) {
    const date = toEasternDate(bar.t);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(bar);
  }

  const dates = Object.keys(byDate).sort();
  const result: (number | null)[] = new Array(bars.length).fill(null);

  // Map bar timestamp to index
  const barIndexMap = new Map<number, number>();
  bars.forEach((bar, i) => barIndexMap.set(bar.t, i));

  for (let d = 0; d < dates.length; d++) {
    const sessionDates = dates.slice(Math.max(0, d - lookbackSessions), d);
    if (sessionDates.length === 0) continue;

    const bucketSums: Record<string, number> = {};
    const bucketCounts: Record<string, number> = {};

    for (const prevDate of sessionDates) {
      for (const bar of byDate[prevDate]) {
        const bucket = get30MinBucketET(bar.t);
        if (!bucketSums[bucket]) {
          bucketSums[bucket] = 0;
          bucketCounts[bucket] = 0;
        }
        bucketSums[bucket] += bar.v;
        bucketCounts[bucket]++;
      }
    }

    for (const bar of byDate[dates[d]]) {
      const bucket = get30MinBucketET(bar.t);
      const idx = barIndexMap.get(bar.t);
      if (idx === undefined) continue;
      const avgVol = bucketCounts[bucket] > 0 ? bucketSums[bucket] / bucketCounts[bucket] : null;
      result[idx] = avgVol && bar.v > 0 ? bar.v / avgVol : null;
    }
  }

  return result;
}

/**
 * Convert a timestamp to YYYY-MM-DD in US Eastern Time.
 * Handles EST/EDT transitions correctly via Intl.DateTimeFormat.
 */
function toEasternDate(timestampMs: number): string {
  return new Date(timestampMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Get 30-minute time-of-day bucket in Eastern Time.
 * Uses Intl formatting to handle DST correctly — a 9:30 AM ET bar
 * always buckets the same regardless of EST vs EDT.
 */
function get30MinBucketET(timestampMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date(timestampMs));
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return `${hour}:${Math.floor(minute / 30)}`;
}

export interface ADXResult {
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
}

/**
 * Compute ADX and Directional Movement Index (+DI, -DI).
 * Standard 14-period Wilder smoothing implementation.
 */
export function computeADX(bars: Bar[], period: number = 14): ADXResult[] {
  const result: ADXResult[] = bars.map(() => ({ adx: null, plusDI: null, minusDI: null }));
  if (bars.length < period + 1) return result;

  const trArr: number[] = [];
  const plusDMArr: number[] = [];
  const minusDMArr: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i];
    const prev = bars[i - 1];
    const highDiff = curr.h - prev.h;
    const lowDiff = prev.l - curr.l;
    trArr.push(Math.max(curr.h - curr.l, Math.abs(curr.h - prev.c), Math.abs(curr.l - prev.c)));
    plusDMArr.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDMArr.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
  }

  const smooth = (arr: number[], p: number): number[] => {
    const out: number[] = [];
    let val = arr.slice(0, p).reduce((a, b) => a + b, 0);
    out.push(val);
    for (let i = p; i < arr.length; i++) {
      val = val - val / p + arr[i];
      out.push(val);
    }
    return out;
  };

  const atr = smooth(trArr, period);
  const plusDM = smooth(plusDMArr, period);
  const minusDM = smooth(minusDMArr, period);

  const diPlus = plusDM.map((v, i) => (atr[i] > 0 ? (v / atr[i]) * 100 : 0));
  const diMinus = minusDM.map((v, i) => (atr[i] > 0 ? (v / atr[i]) * 100 : 0));
  const dx = diPlus.map((v, i) => {
    const sum = v + diMinus[i];
    return sum > 0 ? (Math.abs(v - diMinus[i]) / sum) * 100 : 0;
  });

  const adxArr = smooth(dx, period);

  for (let i = 0; i < adxArr.length; i++) {
    const barIdx = i + period;
    if (barIdx < bars.length) {
      result[barIdx] = {
        adx: adxArr[i],
        plusDI: diPlus[i],
        minusDI: diMinus[i],
      };
    }
  }

  return result;
}

/**
 * Compute bar-level CVD approximation.
 * Uses candle body direction as a proxy for buyer/seller initiative.
 * This is an approximation — real CVD requires tick data.
 */
export function computeCVD(bars: Bar[]): number[] {
  const result: number[] = [];
  let cumDelta = 0;
  for (const bar of bars) {
    const range = bar.h - bar.l || 0.0001;
    const bodyFraction = Math.abs(bar.c - bar.o) / range;
    const direction = bar.c >= bar.o ? 1 : -1;
    const delta = direction * bar.v * bodyFraction;
    cumDelta += delta;
    result.push(cumDelta);
  }
  return result;
}

/**
 * Compute AVWAP slope acceleration (second derivative).
 * Positive = slope is steepening upward (accumulation accelerating).
 * Negative = slope is flattening or reversing.
 */
export function computeAVWAPSlopeAcceleration(
  avwapSeries: (number | null)[],
  interval: number = 5
): (number | null)[] {
  const result: (number | null)[] = new Array(avwapSeries.length).fill(null);
  for (let i = interval * 2; i < avwapSeries.length; i++) {
    const v0 = avwapSeries[i - interval * 2];
    const v1 = avwapSeries[i - interval];
    const v2 = avwapSeries[i];
    if (v0 === null || v1 === null || v2 === null) continue;
    const slope1 = v1 - v0;
    const slope2 = v2 - v1;
    result[i] = slope2 - slope1;
  }
  return result;
}

/**
 * Find the bar index closest to a given timestamp, with bounds rejection.
 *
 * Returns the closest matching index when the target falls inside the
 * bar range. Returns -1 when the target is OUTSIDE the available range —
 * i.e. before the earliest bar's timestamp or after the latest bar's
 * timestamp.
 *
 * Why strict bounds matter: the AVWAP UI lets the user pick anchors like
 * "52w High" which can resolve to dates months before the loaded bars
 * (intraday timespans only carry ~5 trading days of history). Without
 * bounds rejection, every too-old anchor clamps to bar 0, producing
 * indistinguishable AVWAP lines that all start at the earliest bar
 * (the user perceives this as "the new anchor replaced the old one,
 * only the color changed"). Likewise, anchors that resolve past the
 * latest bar (timezone edge cases, "today" anchors against yesterday's
 * EOD bar) clamp to the last bar and produce a single-point AVWAP that
 * renders as a horizontal price line at the most recent close.
 *
 * Callers should treat -1 as "anchor cannot be represented at this
 * timespan" and surface that to the user (e.g. "switch to a longer
 * timespan").
 */
export function findAnchorIndex(bars: Bar[], targetTimestampMs: number): number {
  if (bars.length === 0) return -1;
  if (targetTimestampMs < bars[0].t) return -1;
  if (targetTimestampMs > bars[bars.length - 1].t) return -1;

  let closest = 0;
  let minDiff = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const diff = Math.abs(bars[i].t - targetTimestampMs);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

/**
 * Convert a YYYY-MM-DD date string to a timestamp at 9:30 AM Eastern Time.
 * This ensures anchor dates snap to market open, not UTC midnight.
 */
export function anchorDateToTimestamp(dateStr: string): number {
  // Parse as noon ET first to avoid DST ambiguity, then adjust to 9:30
  const noon = new Date(`${dateStr}T12:00:00`);
  // Use Intl to determine the correct UTC offset for this date in ET
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = etFormatter.formatToParts(noon);
  // We just need a timestamp that's at 9:30 AM ET on this date.
  // Determine if this date is in EST (-5) or EDT (-4) by checking the offset.
  const utcNoon = Date.UTC(
    parseInt(parts.find(p => p.type === 'year')?.value ?? '2025'),
    parseInt(parts.find(p => p.type === 'month')?.value ?? '1') - 1,
    parseInt(parts.find(p => p.type === 'day')?.value ?? '1'),
    12, 0, 0
  );
  const offsetMs = utcNoon - noon.getTime();
  // offsetMs tells us the difference between UTC and local parse.
  // Instead, just use a well-known approach: build the target time in ET.
  // EST = UTC-5, EDT = UTC-4. Use the Intl trick:
  const isDST = new Date(`${dateStr}T12:00:00-04:00`).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }) === '12';
  const offset = isDST ? '-04:00' : '-05:00';
  return new Date(`${dateStr}T09:30:00${offset}`).getTime();
}

/**
 * Classify CVD trend direction over the last N bars.
 * Uses simple slope of recent CVD values.
 */
export function classifyCVDTrend(
  cvd: number[],
  lookback: number = 20
): { direction: 'buying' | 'selling' | 'neutral'; slope: number } {
  const recent = cvd.slice(-lookback);
  if (recent.length < 4) return { direction: 'neutral', slope: 0 };

  // Linear regression slope
  const n = recent.length;
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (recent[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;

  // Normalize slope relative to average volume magnitude to make threshold meaningful
  const avgAbsCVDChange = recent.length > 1
    ? recent.reduce((sum, v, i) => i > 0 ? sum + Math.abs(v - recent[i - 1]) : sum, 0) / (recent.length - 1)
    : 1;
  const normalizedSlope = avgAbsCVDChange > 0 ? slope / avgAbsCVDChange : 0;

  if (normalizedSlope > 0.3) return { direction: 'buying', slope: normalizedSlope };
  if (normalizedSlope < -0.3) return { direction: 'selling', slope: normalizedSlope };
  return { direction: 'neutral', slope: normalizedSlope };
}

/**
 * Find the last non-null value in an ADX result array.
 * ADX Wilder smoothing requires 2×period bars, so the last ~period bars
 * will have null values. Use this to get the most recent valid reading.
 */
export function getLastValidADX(adx: ADXResult[]): ADXResult | null {
  for (let i = adx.length - 1; i >= 0; i--) {
    if (adx[i].adx !== null) return adx[i];
  }
  return null;
}

/**
 * Find the last non-null RVOL value.
 * First-session bars have no prior data to compare against.
 */
export function getLastValidRVOL(rvol: (number | null)[]): number | null {
  for (let i = rvol.length - 1; i >= 0; i--) {
    if (rvol[i] !== null) return rvol[i];
  }
  return null;
}
