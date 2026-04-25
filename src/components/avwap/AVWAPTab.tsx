'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import AVWAPChart from './AVWAPChart';
import AnchorSelector from './AnchorSelector';
import RegimeDashboard from './RegimeDashboard';
import MADPanel from './MADPanel';
import RVOLPanel from './RVOLPanel';
import ADXPanel from './ADXPanel';
import CVDChart from './CVDChart';
import SignalSummary from './SignalSummary';
import {
  computeAVWAP,
  computeAVWAPBands,
  computeMAD,
  classifyMADState,
  computeRVOL,
  computeADX,
  computeCVD,
  computeAVWAPSlopeAcceleration,
  classifyCVDTrend,
  findAnchorIndex,
  anchorDateToTimestamp,
  getLastValidADX,
  getLastValidRVOL,
  type Bar,
  type ADXResult,
} from '@/lib/avwap';

const TIMESPAN_OPTIONS = [
  { label: '5m', multiplier: 5, timespan: 'minute', daysBack: 5 },
  { label: '15m', multiplier: 15, timespan: 'minute', daysBack: 10 },
  { label: '1H', multiplier: 1, timespan: 'hour', daysBack: 60 },
  { label: '4H', multiplier: 4, timespan: 'hour', daysBack: 120 },
  { label: '1D', multiplier: 1, timespan: 'day', daysBack: 365 },
] as const;

type TimespanOption = (typeof TIMESPAN_OPTIONS)[number];

export interface AnchorDef {
  date: string;
  label: string;
  type: string;
  color: string;
}

export interface AVWAPSeriesData {
  anchor: AnchorDef;
  anchorIndex: number;
  /** True when the anchor date falls outside the loaded bar range. */
  outOfRange: boolean;
  avwap: (number | null)[];
  bands1: { upper: (number | null)[]; lower: (number | null)[] };
  bands2: { upper: (number | null)[]; lower: (number | null)[] };
  mad: (number | null)[];
  madState: { state: 'compressing' | 'neutral' | 'expanding'; roc: number };
  slopeAccel: (number | null)[];
}

export interface ComputedAVWAPData {
  avwapSeries: AVWAPSeriesData[];
  rvol: (number | null)[];
  adx: ADXResult[];
  cvd: number[];
  currentPrice: number;
  currentRVOL: number | null;
  currentADX: ADXResult | null;
  currentCVD: number | undefined;
  cvdTrend: { direction: 'buying' | 'selling' | 'neutral'; slope: number };
  signals: { label: string; direction: 'bullish' | 'bearish' | 'neutral'; value: number | null }[];
}

export default function AVWAPTab() {
  const [ticker, setTicker] = useState('SPY');
  const [tickerInput, setTickerInput] = useState('SPY');
  const [selectedTimespan, setSelectedTimespan] = useState<TimespanOption>(TIMESPAN_OPTIONS[2]);
  const [bars, setBars] = useState<Bar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<AnchorDef[]>([]);
  const [availableAnchors, setAvailableAnchors] = useState<{ date: string; label: string; type: string }[]>([]);
  const [retryCount, setRetryCount] = useState(0);

  // Fetch bars when ticker, timespan, or retry trigger changes
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    const fetchBars = async () => {
      setLoading(true);
      setError(null);
      try {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - selectedTimespan.daysBack * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

        const res = await fetch(
          `/api/avwap-data?ticker=${ticker}&from=${from}&to=${to}&timespan=${selectedTimespan.timespan}&multiplier=${selectedTimespan.multiplier}`
        );
        const data = await res.json();
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setBars(data.bars || []);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchBars();
    return () => { cancelled = true; };
  }, [ticker, selectedTimespan, retryCount]);

  // Fetch available anchor dates (earnings, 52w, YTD)
  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    fetch(`/api/earnings-dates?ticker=${ticker}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setAvailableAnchors(data.anchors || []);
        // Auto-add YTD anchor if no anchors set.
        // Use functional setState to avoid stale closure over anchors.
        if (data.anchors?.length > 0) {
          const ytd = data.anchors.find((a: { type: string }) => a.type === 'ytd');
          if (ytd) {
            setAnchors(prev => {
              if (prev.length > 0) return prev; // Don't overwrite user selections
              return [{ ...ytd, color: '#2196F3' }];
            });
          }
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ticker]);

  // Compute all derived series
  const computedData = useMemo((): ComputedAVWAPData | null => {
    if (bars.length === 0 || anchors.length === 0) return null;

    const avwapSeries: AVWAPSeriesData[] = anchors.map(anchor => {
      // Parse anchor date as 9:30 AM ET (market open) to snap to correct session
      const anchorTs = anchorDateToTimestamp(anchor.date);
      const anchorIndex = findAnchorIndex(bars, anchorTs);
      const outOfRange = anchorIndex < 0;
      const avwap = computeAVWAP(bars, anchorIndex);
      const bands1 = computeAVWAPBands(bars, anchorIndex, avwap, 1);
      const bands2 = computeAVWAPBands(bars, anchorIndex, avwap, 2);
      const mad = computeMAD(bars, avwap);
      const madState = classifyMADState(mad);
      const slopeAccel = computeAVWAPSlopeAcceleration(avwap);

      return { anchor, anchorIndex, outOfRange, avwap, bands1, bands2, mad, madState, slopeAccel };
    });

    const rvol = computeRVOL(bars);
    const adx = computeADX(bars);
    const cvd = computeCVD(bars);

    const lastIdx = bars.length - 1;
    const currentPrice = bars[lastIdx]?.c ?? 0;
    // Use last valid values — ADX Wilder smoothing leaves the last ~period bars null,
    // and RVOL has no data for the first session in the lookback window
    const currentRVOL = getLastValidRVOL(rvol);
    const currentADX = getLastValidADX(adx);
    const currentCVD = cvd[lastIdx];
    const cvdTrend = classifyCVDTrend(cvd);

    const signals = avwapSeries.map(s => {
      const lastAVWAP = s.avwap[lastIdx];
      const direction: 'bullish' | 'bearish' | 'neutral' =
        lastAVWAP !== null ? (currentPrice > lastAVWAP ? 'bullish' : 'bearish') : 'neutral';
      return { label: s.anchor.label, direction, value: lastAVWAP };
    });

    return { avwapSeries, rvol, adx, cvd, currentPrice, currentRVOL, currentADX, currentCVD, cvdTrend, signals };
  }, [bars, anchors]);

  const handleTickerSearch = useCallback(() => {
    const cleaned = tickerInput.trim().toUpperCase();
    if (cleaned) {
      setTicker(cleaned);
      setAnchors([]);
    }
  }, [tickerInput]);

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      {/* Header Row: Ticker Search + Timespan */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={tickerInput}
            onChange={e => setTickerInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleTickerSearch()}
            placeholder="Ticker..."
            className="bg-surface border border-border rounded-lg px-3 py-2 w-28 text-text-primary font-mono uppercase focus:border-accent-cyan focus:outline-none text-sm"
          />
          <button
            onClick={handleTickerSearch}
            className="bg-accent-cyan/20 hover:bg-accent-cyan/30 text-accent-cyan px-4 py-2 rounded-lg font-semibold text-sm transition-colors border border-accent-cyan/30"
          >
            Analyze
          </button>
        </div>

        <div className="flex items-center gap-1">
          {TIMESPAN_OPTIONS.map(ts => (
            <button
              key={ts.label}
              onClick={() => setSelectedTimespan(ts)}
              className={`px-3 py-1.5 rounded-lg text-sm font-mono transition-colors ${
                selectedTimespan.label === ts.label
                  ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                  : 'bg-surface text-text-muted hover:text-text-secondary border border-transparent'
              }`}
            >
              {ts.label}
            </button>
          ))}
        </div>

        {loading && <span className="text-text-muted text-sm animate-pulse">Loading bars...</span>}
        {error && (
          <div className="flex items-center gap-2">
            <span className="text-red-400 text-sm">{error}</span>
            <button
              onClick={() => setRetryCount(c => c + 1)}
              className="text-xs text-accent-cyan hover:text-accent-cyan/80 underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Signal Summary Banner */}
      {computedData && (
        <SignalSummary
          signals={computedData.signals}
          currentRVOL={computedData.currentRVOL}
          currentADX={computedData.currentADX}
          ticker={ticker}
        />
      )}

      {/* Out-of-range anchor warning */}
      {computedData && computedData.avwapSeries.some(s => s.outOfRange) && (
        <div className="bg-amber-900/20 border border-amber-700/40 rounded-lg px-3 py-2 text-xs text-amber-200">
          <span className="font-semibold">Anchor outside available bars:</span>{' '}
          {computedData.avwapSeries
            .filter(s => s.outOfRange)
            .map(s => s.anchor.label)
            .join(', ')}
          {' — '}
          <span className="text-amber-300/80">
            switch to a longer timespan (the {selectedTimespan.label} preset only loads
            {' '}{selectedTimespan.daysBack} days of history).
          </span>
        </div>
      )}

      {/* Empty state when no data */}
      {!loading && !error && bars.length === 0 && ticker && (
        <div className="bg-surface rounded-xl border border-border p-8 text-center">
          <div className="text-text-muted text-sm mb-1">No bar data available for {ticker}</div>
          <div className="text-text-muted text-xs opacity-70">
            Market may be closed, or this ticker may not have data for the selected timeframe.
            Try a different timespan or check the ticker symbol.
          </div>
        </div>
      )}

      {/* Main Layout: Chart + Sidebar */}
      <div className="flex gap-4 flex-col lg:flex-row">
        {/* Left: Charts */}
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          <AnchorSelector
            availableAnchors={availableAnchors}
            anchors={anchors}
            onAnchorsChange={setAnchors}
          />

          <AVWAPChart bars={bars} computedData={computedData} ticker={ticker} />

          {computedData && <CVDChart bars={bars} cvd={computedData.cvd} />}
        </div>

        {/* Right Sidebar: Panels */}
        <div className="w-full lg:w-72 flex flex-col gap-3 shrink-0">
          {computedData && (
            <>
              <RegimeDashboard
                computedData={computedData}
                ticker={ticker}
                currentPrice={computedData.currentPrice}
              />
              <MADPanel avwapSeries={computedData.avwapSeries} />
              <RVOLPanel rvol={computedData.rvol} />
              <ADXPanel adx={computedData.adx} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
