import type { Quote, OHLCV, Interval, OptionsChain, OptionContract, OptionExpiration } from '@/types/market';

const BASE_URL = 'https://api.tradier.com/v1';
const SANDBOX_URL = 'https://sandbox.tradier.com/v1';

function getHeaders(token: string) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  };
}

function getBaseUrl(): string {
  return process.env.TRADIER_SANDBOX === 'true' ? SANDBOX_URL : BASE_URL;
}

/** Hard timeout for every Tradier API call to prevent serverless function hangs */
const FETCH_TIMEOUT = 8000;

// ─── Quote ─────────────────────────────────────────────────────────

export async function getQuote(symbol: string): Promise<Quote> {
  const token = process.env.TRADIER_API_KEY!;
  const res = await fetch(
    `${getBaseUrl()}/markets/quotes?symbols=${encodeURIComponent(symbol)}&greeks=false`,
    { headers: getHeaders(token), next: { revalidate: 5 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tradier quote error: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  const q = data.quotes?.quote;
  if (!q) throw new Error(`No quote data for ${symbol}`);

  // Handle both single quote and array
  const quote = Array.isArray(q) ? q[0] : q;

  return {
    symbol: quote.symbol,
    last: quote.last ?? quote.close ?? 0,
    change: quote.change ?? 0,
    changePct: quote.change_percentage ?? 0,
    open: quote.open ?? 0,
    high: quote.high ?? 0,
    low: quote.low ?? 0,
    close: quote.close ?? 0,
    prevClose: quote.prevclose ?? 0,
    volume: quote.volume ?? 0,
    avgVolume: quote.average_volume ?? 0,
    bid: quote.bid ?? 0,
    ask: quote.ask ?? 0,
    bidSize: quote.bidsize ?? 0,
    askSize: quote.asksize ?? 0,
    timestamp: Date.now(),
  };
}

// ─── History ───────────────────────────────────────────────────────

const INTERVAL_MAP: Record<Interval, { interval: string; filter?: string }> = {
  '1min': { interval: '1min' },
  '5min': { interval: '5min' },
  '15min': { interval: '15min' },
  '1h': { interval: '15min' },  // Tradier max intraday is 15min; we'll aggregate
  '1D': { interval: 'daily' },
  '1W': { interval: 'weekly' },
  '1M': { interval: 'monthly' },
};

export async function getHistory(
  symbol: string,
  interval: Interval,
  start?: string,
  end?: string
): Promise<OHLCV[]> {
  const token = process.env.TRADIER_API_KEY!;
  const mapped = INTERVAL_MAP[interval];

  // Intraday vs daily endpoints
  const isIntraday = ['1min', '5min', '15min', '1h'].includes(interval);

  let url: string;
  if (isIntraday) {
    const startDate = start || new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = end || new Date().toISOString().split('T')[0];
    url = `${getBaseUrl()}/markets/timesales?symbol=${encodeURIComponent(symbol)}&interval=${mapped.interval}&start=${startDate}&end=${endDate}`;
  } else {
    const startDate = start || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = end || new Date().toISOString().split('T')[0];
    url = `${getBaseUrl()}/markets/history?symbol=${encodeURIComponent(symbol)}&interval=${mapped.interval}&start=${startDate}&end=${endDate}`;
  }

  const res = await fetch(url, { headers: getHeaders(token), next: { revalidate: 30 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tradier history error: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  if (isIntraday) {
    const series = data.series?.data;
    if (!series) return [];
    const bars = Array.isArray(series) ? series : [series];
    return bars.map((bar: { timestamp: number; time: string; open: number; high: number; low: number; close: number; volume: number }) => ({
      time: Math.floor(new Date(bar.time || bar.timestamp * 1000).getTime() / 1000),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  } else {
    const history = data.history?.day;
    if (!history) return [];
    const bars = Array.isArray(history) ? history : [history];
    return bars.map((bar: { date: string; open: number; high: number; low: number; close: number; volume: number }) => ({
      time: Math.floor(new Date(bar.date + 'T00:00:00').getTime() / 1000),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }
}

// ─── Options Expirations ───────────────────────────────────────────

export async function getExpirations(symbol: string): Promise<OptionExpiration[]> {
  const token = process.env.TRADIER_API_KEY!;
  const res = await fetch(
    `${getBaseUrl()}/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true&strikes=true`,
    { headers: getHeaders(token), next: { revalidate: 300 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tradier expirations error: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  const expirations = data.expirations?.expiration;
  if (!expirations) return [];
  const expList = Array.isArray(expirations) ? expirations : [expirations];

  const now = new Date();
  return expList.map((exp: { date: string; strikes?: { strike: number[] | number } }) => {
    const date = exp.date;
    const dte = Math.ceil((new Date(date + 'T16:00:00').getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const strikesRaw = exp.strikes?.strike;
    const strikes = strikesRaw
      ? (Array.isArray(strikesRaw) ? strikesRaw : [strikesRaw])
      : [];
    return { date, dte: Math.max(0, dte), strikes };
  });
}

// ─── Options Chain ─────────────────────────────────────────────────

export async function getOptionsChain(symbol: string, expiration: string): Promise<OptionsChain> {
  const token = process.env.TRADIER_API_KEY!;

  // Fetch chain with Greeks
  const res = await fetch(
    `${getBaseUrl()}/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expiration}&greeks=true`,
    { headers: getHeaders(token), next: { revalidate: 10 }, signal: AbortSignal.timeout(FETCH_TIMEOUT) }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tradier chain error: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  // Get underlying price
  let underlyingPrice = 0;
  try {
    const quote = await getQuote(symbol);
    underlyingPrice = quote.last;
  } catch {
    // fallback
  }

  const options = data.options?.option;
  if (!options) return { underlying: symbol, underlyingPrice, expiration, calls: [], puts: [], timestamp: Date.now() };

  const optionList = Array.isArray(options) ? options : [options];
  const now = new Date();
  const expDate = new Date(expiration + 'T16:00:00');
  const dte = Math.max(0, Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

  const calls: OptionContract[] = [];
  const puts: OptionContract[] = [];

  for (const opt of optionList) {
    const type = opt.option_type === 'call' ? 'call' : 'put';
    const greeks = opt.greeks || {};

    const contract: OptionContract = {
      symbol: opt.symbol,
      underlying: opt.underlying || symbol,
      strike: opt.strike,
      expiration: expiration,
      type,
      last: opt.last ?? 0,
      bid: opt.bid ?? 0,
      ask: opt.ask ?? 0,
      mid: ((opt.bid ?? 0) + (opt.ask ?? 0)) / 2,
      volume: opt.volume ?? 0,
      openInterest: opt.open_interest ?? 0,
      impliedVolatility: greeks.mid_iv ?? greeks.ask_iv ?? greeks.bid_iv ?? 0,
      delta: greeks.delta ?? 0,
      gamma: greeks.gamma ?? 0,
      theta: greeks.theta ?? 0,
      vega: greeks.vega ?? 0,
      rho: greeks.rho ?? 0,
      dte,
      inTheMoney: type === 'call' ? underlyingPrice > opt.strike : underlyingPrice < opt.strike,
      intrinsicValue: type === 'call'
        ? Math.max(0, underlyingPrice - opt.strike)
        : Math.max(0, opt.strike - underlyingPrice),
      extrinsicValue: Math.max(0, (opt.last ?? 0) - (type === 'call'
        ? Math.max(0, underlyingPrice - opt.strike)
        : Math.max(0, opt.strike - underlyingPrice))),
      bidAskSpread: (opt.ask ?? 0) - (opt.bid ?? 0),
      volumeOiRatio: (opt.open_interest ?? 0) > 0
        ? (opt.volume ?? 0) / (opt.open_interest ?? 1)
        : 0,
    };

    if (type === 'call') calls.push(contract);
    else puts.push(contract);
  }

  // Sort by strike
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);

  return {
    underlying: symbol,
    underlyingPrice,
    expiration,
    calls,
    puts,
    timestamp: Date.now(),
  };
}
