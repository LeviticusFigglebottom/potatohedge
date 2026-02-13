// ─── Signal Tracker: Track stock-level directional signals and measure accuracy ───

const STORAGE_KEY = 'optix-signal-tracker';

export interface TrackedSignal {
  id: string;
  symbol: string;
  trackedAt: number;         // timestamp when tracked
  entryPrice: number;        // spot price at time of tracking
  currentPrice: number;      // most recent price
  changePct: number;         // % change from entry
  // Signal snapshot at time of tracking
  bias: 'bullish' | 'bearish' | 'neutral';
  biasScore: number;         // -100 to +100
  gammaRegime: string;
  volRegime: string;
  ivRank: number;
  topSignal: string;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  // Performance
  directionCorrect: boolean | null;  // null if neutral bias
  peakChangePct: number;     // max favorable move since entry
  troughChangePct: number;   // max adverse move since entry
  lastUpdated: number;       // timestamp of last price update
  source: 'screener' | 'briefing' | 'manual';
  notes?: string;
  // Optional: close/archive
  closed: boolean;
  closedAt?: number;
  closePrice?: number;
  closePct?: number;
}

export function loadSignals(): TrackedSignal[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSignals(signals: TrackedSignal[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(signals));
}

export function addSignal(params: {
  symbol: string;
  entryPrice: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  biasScore: number;
  gammaRegime: string;
  volRegime: string;
  ivRank: number;
  topSignal: string;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  source: 'screener' | 'briefing' | 'manual';
  notes?: string;
}): TrackedSignal {
  const signal: TrackedSignal = {
    id: `sig-${params.symbol}-${Date.now()}`,
    symbol: params.symbol,
    trackedAt: Date.now(),
    entryPrice: params.entryPrice,
    currentPrice: params.entryPrice,
    changePct: 0,
    bias: params.bias,
    biasScore: params.biasScore,
    gammaRegime: params.gammaRegime,
    volRegime: params.volRegime,
    ivRank: params.ivRank,
    topSignal: params.topSignal,
    gammaFlip: params.gammaFlip,
    callWall: params.callWall,
    putWall: params.putWall,
    directionCorrect: null,
    peakChangePct: 0,
    troughChangePct: 0,
    lastUpdated: Date.now(),
    source: params.source,
    notes: params.notes,
    closed: false,
  };

  const signals = loadSignals();
  signals.unshift(signal);
  saveSignals(signals);
  return signal;
}

export function updateSignalPrices(updates: Record<string, number>): TrackedSignal[] {
  const signals = loadSignals();
  let changed = false;

  for (const sig of signals) {
    // Update ALL signals — never skip based on closed status.
    // Signals keep updating until physically removed.
    const price = updates[sig.symbol];
    if (price == null || price <= 0) continue;

    sig.currentPrice = price;
    sig.changePct = ((price - sig.entryPrice) / sig.entryPrice) * 100;
    sig.lastUpdated = Date.now();

    // Track peak/trough
    if (sig.bias === 'bullish') {
      sig.peakChangePct = Math.max(sig.peakChangePct, sig.changePct);
      sig.troughChangePct = Math.min(sig.troughChangePct, sig.changePct);
      sig.directionCorrect = sig.changePct > 0;
    } else if (sig.bias === 'bearish') {
      // For bearish, a negative changePct is "correct"
      sig.peakChangePct = Math.min(sig.peakChangePct, sig.changePct); // most negative = best for bearish
      sig.troughChangePct = Math.max(sig.troughChangePct, sig.changePct);
      sig.directionCorrect = sig.changePct < 0;
    } else {
      sig.directionCorrect = null;
    }

    changed = true;
  }

  if (changed) saveSignals(signals);
  return signals;
}

export function closeSignal(id: string): TrackedSignal[] {
  const signals = loadSignals();
  const sig = signals.find(s => s.id === id);
  if (sig && !sig.closed) {
    sig.closed = true;
    sig.closedAt = Date.now();
    sig.closePrice = sig.currentPrice;
    sig.closePct = sig.changePct;
  }
  saveSignals(signals);
  return signals;
}

export function removeSignal(id: string): TrackedSignal[] {
  const signals = loadSignals().filter(s => s.id !== id);
  saveSignals(signals);
  return signals;
}

export function getSignalStats(signals: TrackedSignal[]): {
  total: number;
  open: number;
  closed: number;
  bullishCorrect: number;
  bullishTotal: number;
  bearishCorrect: number;
  bearishTotal: number;
  avgGain: number;
  avgLoss: number;
  winRate: number;
} {
  const closed = signals.filter(s => s.closed);
  const open = signals.filter(s => !s.closed);
  const all = signals.filter(s => s.bias !== 'neutral');

  const bullish = all.filter(s => s.bias === 'bullish');
  const bearish = all.filter(s => s.bias === 'bearish');
  const bullishCorrect = bullish.filter(s => s.directionCorrect === true);
  const bearishCorrect = bearish.filter(s => s.directionCorrect === true);

  const gains = all.filter(s => s.directionCorrect === true);
  const losses = all.filter(s => s.directionCorrect === false);

  const avgGain = gains.length > 0
    ? gains.reduce((sum, s) => sum + Math.abs(s.changePct), 0) / gains.length
    : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((sum, s) => sum + Math.abs(s.changePct), 0) / losses.length
    : 0;

  const directional = all.filter(s => s.directionCorrect !== null);
  const correct = directional.filter(s => s.directionCorrect === true);
  const winRate = directional.length > 0 ? (correct.length / directional.length) * 100 : 0;

  return {
    total: signals.length,
    open: open.length,
    closed: closed.length,
    bullishCorrect: bullishCorrect.length,
    bullishTotal: bullish.length,
    bearishCorrect: bearishCorrect.length,
    bearishTotal: bearish.length,
    avgGain,
    avgLoss,
    winRate,
  };
}
