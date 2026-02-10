/**
 * Tradier Sandbox Paper Trading Provider
 *
 * Uses the Tradier sandbox API for paper trading options.
 * Requires TRADIER_SANDBOX_KEY env var (separate from production API key).
 * Account ID is auto-discovered from the user profile on first call.
 */

const SANDBOX_URL = 'https://sandbox.tradier.com/v1';
const FETCH_TIMEOUT = 8000;

function getToken(): string {
  const key = process.env.TRADIER_SANDBOX_KEY;
  if (!key) throw new Error('TRADIER_SANDBOX_KEY not configured');
  return key;
}

function getHeaders() {
  return {
    'Authorization': `Bearer ${getToken()}`,
    'Accept': 'application/json',
  };
}

// ─── Account ID Discovery ─────────────────────────────────

let cachedAccountId: string | null = null;

export async function getAccountId(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;

  const res = await fetch(`${SANDBOX_URL}/user/profile`, {
    headers: getHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tradier profile error: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const accounts = data.profile?.account;
  const account = Array.isArray(accounts) ? accounts[0] : accounts;
  if (!account?.account_number) throw new Error('No sandbox account found');

  cachedAccountId = String(account.account_number);
  return cachedAccountId;
}

// ─── OCC Option Symbol Builder ─────────────────────────────

/**
 * Build an OCC option symbol from components.
 * @param underlying - Stock symbol (e.g., 'SPY')
 * @param expDate - Expiration date 'YYYY-MM-DD'
 * @param type - 'C' for call, 'P' for put
 * @param strike - Strike price (e.g., 605)
 */
export function buildOCCSymbol(
  underlying: string,
  expDate: string,
  type: 'C' | 'P',
  strike: number
): string {
  const [y, m, d] = expDate.split('-');
  const yy = y.slice(2);
  const strikePadded = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying}${yy}${m}${d}${type}${strikePadded}`;
}

/**
 * Parse an OCC symbol back to components.
 */
export function parseOCCSymbol(occ: string): {
  underlying: string;
  expDate: string;
  type: 'C' | 'P';
  strike: number;
} | null {
  // OCC format: UNDERLYING + YYMMDD + C/P + 8-digit strike
  const match = occ.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, underlying, dateStr, type, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  return {
    underlying,
    expDate: `20${yy}-${mm}-${dd}`,
    type: type as 'C' | 'P',
    strike: parseInt(strikeStr, 10) / 1000,
  };
}

// ─── Order Placement ───────────────────────────────────────

export interface SingleLegOrder {
  symbol: string;         // underlying
  optionSymbol: string;   // OCC symbol
  side: 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';
  quantity: number;
  type: 'market' | 'limit';
  price?: number;         // required for limit orders
  duration?: 'day' | 'gtc';
}

export interface MultiLegOrder {
  symbol: string;         // underlying
  type: 'market' | 'debit' | 'credit' | 'even';
  price?: number;         // net debit/credit
  duration?: 'day' | 'gtc';
  legs: {
    optionSymbol: string;
    side: 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';
    quantity: number;
  }[];
}

export interface OrderResult {
  id: number;
  status: string;
  partner_id?: string;
}

/**
 * Place a single-leg options order on the sandbox.
 */
export async function placeSingleOrder(order: SingleLegOrder): Promise<OrderResult> {
  const accountId = await getAccountId();

  const params = new URLSearchParams({
    class: 'option',
    symbol: order.symbol,
    option_symbol: order.optionSymbol,
    side: order.side,
    quantity: String(order.quantity),
    type: order.type,
    duration: order.duration || 'day',
  });
  if (order.type === 'limit' && order.price != null) {
    params.set('price', String(order.price));
  }

  const res = await fetch(`${SANDBOX_URL}/accounts/${accountId}/orders`, {
    method: 'POST',
    headers: {
      ...getHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Order failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.order || data;
}

/**
 * Place a multileg options order (spreads, iron condors) on the sandbox.
 */
export async function placeMultiLegOrder(order: MultiLegOrder): Promise<OrderResult> {
  const accountId = await getAccountId();

  const params = new URLSearchParams({
    class: 'multileg',
    symbol: order.symbol,
    type: order.type,
    duration: order.duration || 'day',
  });
  if (order.price != null) {
    params.set('price', String(order.price));
  }
  for (let i = 0; i < order.legs.length; i++) {
    params.set(`option_symbol[${i}]`, order.legs[i].optionSymbol);
    params.set(`side[${i}]`, order.legs[i].side);
    params.set(`quantity[${i}]`, String(order.legs[i].quantity));
  }

  const res = await fetch(`${SANDBOX_URL}/accounts/${accountId}/orders`, {
    method: 'POST',
    headers: {
      ...getHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Multileg order failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.order || data;
}

// ─── Positions ─────────────────────────────────────────────

export interface Position {
  id: number;
  symbol: string;           // OCC symbol for options, ticker for equity
  quantity: number;
  cost_basis: number;
  date_acquired: string;
}

export async function getPositions(): Promise<Position[]> {
  const accountId = await getAccountId();

  const res = await fetch(`${SANDBOX_URL}/accounts/${accountId}/positions`, {
    headers: getHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Positions error: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const positions = data.positions?.position;
  if (!positions) return [];
  return Array.isArray(positions) ? positions : [positions];
}

// ─── Orders ────────────────────────────────────────────────

export interface TradierOrder {
  id: number;
  type: string;
  symbol: string;
  option_symbol?: string;
  side: string;
  quantity: number;
  status: string;
  duration: string;
  price?: number;
  avg_fill_price?: number;
  exec_quantity?: number;
  remaining_quantity?: number;
  create_date: string;
  transaction_date?: string;
  class: string;
  // Multileg legs
  leg?: TradierOrder[];
}

export async function getOrders(): Promise<TradierOrder[]> {
  const accountId = await getAccountId();

  const res = await fetch(`${SANDBOX_URL}/accounts/${accountId}/orders`, {
    headers: getHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Orders error: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const orders = data.orders?.order;
  if (!orders) return [];
  return Array.isArray(orders) ? orders : [orders];
}

export async function cancelOrder(orderId: number): Promise<void> {
  const accountId = await getAccountId();

  const res = await fetch(`${SANDBOX_URL}/accounts/${accountId}/orders/${orderId}`, {
    method: 'DELETE',
    headers: getHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cancel failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

// ─── Balances ──────────────────────────────────────────────

export interface AccountBalance {
  total_equity: number;
  total_cash: number;
  market_value: number;
  open_pl: number;
  close_pl: number;
  option_long_value: number;
  option_short_value: number;
  pending_orders_count: number;
}

export async function getBalances(): Promise<AccountBalance> {
  const accountId = await getAccountId();

  const res = await fetch(`${SANDBOX_URL}/accounts/${accountId}/balances`, {
    headers: getHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Balances error: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const b = data.balances || {};
  return {
    total_equity: b.total_equity ?? 0,
    total_cash: b.total_cash ?? 0,
    market_value: b.market_value ?? 0,
    open_pl: b.open_pl ?? 0,
    close_pl: b.close_pl ?? 0,
    option_long_value: b.option_long_value ?? 0,
    option_short_value: b.option_short_value ?? 0,
    pending_orders_count: b.pending_orders_count ?? 0,
  };
}

// ─── Gain/Loss History ─────────────────────────────────────

export interface GainLossEntry {
  symbol: string;
  quantity: number;
  cost: number;
  gain_loss: number;
  gain_loss_percent: number;
  open_date: string;
  close_date: string;
  term: number; // days held
  proceeds: number;
}

export async function getGainLoss(limit: number = 50): Promise<GainLossEntry[]> {
  const accountId = await getAccountId();

  const res = await fetch(
    `${SANDBOX_URL}/accounts/${accountId}/gainloss?limit=${limit}&sortBy=closeDate&sort=desc`,
    {
      headers: getHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gain/loss error: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const entries = data.gainloss?.closed_position;
  if (!entries) return [];
  return Array.isArray(entries) ? entries : [entries];
}

// ─── Option Quote (for current pricing) ────────────────────

export async function getOptionQuote(occSymbol: string): Promise<{
  last: number;
  bid: number;
  ask: number;
  volume: number;
  open_interest: number;
} | null> {
  const res = await fetch(
    `${SANDBOX_URL}/markets/quotes?symbols=${encodeURIComponent(occSymbol)}&greeks=false`,
    {
      headers: getHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    }
  );

  if (!res.ok) return null;
  const data = await res.json();
  const q = data.quotes?.quote;
  if (!q) return null;
  const quote = Array.isArray(q) ? q[0] : q;
  return {
    last: quote.last ?? 0,
    bid: quote.bid ?? 0,
    ask: quote.ask ?? 0,
    volume: quote.volume ?? 0,
    open_interest: quote.open_interest ?? 0,
  };
}
