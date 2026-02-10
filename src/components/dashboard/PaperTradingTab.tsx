'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Wallet, RefreshCw, TrendingUp, TrendingDown, X, Clock,
  CheckCircle2, XCircle, AlertTriangle, DollarSign, Plus,
} from 'lucide-react';

interface ParsedOCC {
  underlying: string;
  expDate: string;
  type: 'C' | 'P';
  strike: number;
}

interface Position {
  id: number;
  symbol: string;
  quantity: number;
  cost_basis: number;
  date_acquired: string;
  parsed: ParsedOCC | null;
  costPerContract: number;
}

interface HistoryEntry {
  symbol: string;
  quantity: number;
  cost: number;
  gain_loss: number;
  gain_loss_percent: number;
  open_date: string;
  close_date: string;
  proceeds: number;
  parsed: ParsedOCC | null;
}

interface AccountData {
  balances: {
    total_equity: number;
    total_cash: number;
    market_value: number;
    open_pl: number;
    close_pl: number;
    option_long_value: number;
    option_short_value: number;
    pending_orders_count: number;
  };
  positions: Position[];
  history: HistoryEntry[];
}

interface Order {
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
  create_date: string;
  class: string;
  parsed?: ParsedOCC | null;
}

// Trade metadata stored in localStorage
interface TradeNote {
  orderId: number;
  thesis: string;
  targetPrice: number | null;
  stopPrice: number | null;
  createdAt: string;
}

function loadNotes(): TradeNote[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem('optix-paper-notes') || '[]');
  } catch { return []; }
}

function saveNote(note: TradeNote) {
  const notes = loadNotes().filter(n => n.orderId !== note.orderId);
  notes.push(note);
  localStorage.setItem('optix-paper-notes', JSON.stringify(notes));
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function fmtOCC(parsed: ParsedOCC | null, fallback: string): string {
  if (!parsed) return fallback;
  return `${parsed.underlying} ${parsed.expDate} $${parsed.strike} ${parsed.type === 'C' ? 'Call' : 'Put'}`;
}

// ─── Quick Trade Form ───────────────────────────────────────

function QuickTradeForm({ onSubmit, onClose }: {
  onSubmit: (trade: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    symbol: 'SPY',
    expiration: '',
    optionType: 'C' as 'C' | 'P',
    strike: '',
    side: 'buy_to_open',
    quantity: '1',
    orderType: 'market',
    limitPrice: '',
    thesis: '',
    targetPrice: '',
    stopPrice: '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      type: 'single',
      symbol: form.symbol.toUpperCase(),
      expiration: form.expiration,
      optionType: form.optionType,
      strike: parseFloat(form.strike),
      side: form.side,
      quantity: parseInt(form.quantity) || 1,
      orderType: form.orderType,
      limitPrice: form.limitPrice ? parseFloat(form.limitPrice) : undefined,
      thesis: form.thesis || undefined,
      targetPrice: form.targetPrice ? parseFloat(form.targetPrice) : undefined,
      stopPrice: form.stopPrice ? parseFloat(form.stopPrice) : undefined,
    });
  };

  const inputClass = 'bg-bg-tertiary border border-border/30 rounded px-2 py-1.5 text-sm font-mono text-text-primary focus:border-accent-cyan/50 focus:outline-none w-full';
  const labelClass = 'text-xs text-text-muted font-mono mb-1 block';

  return (
    <form onSubmit={handleSubmit} className="panel p-4 space-y-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Plus className="w-4 h-4 text-accent-cyan" />
          Quick Paper Trade
        </span>
        <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className={labelClass}>Symbol</label>
          <input className={inputClass} value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))} required />
        </div>
        <div>
          <label className={labelClass}>Expiration</label>
          <input className={inputClass} type="date" value={form.expiration} onChange={e => setForm(f => ({ ...f, expiration: e.target.value }))} required />
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select className={inputClass} value={form.optionType} onChange={e => setForm(f => ({ ...f, optionType: e.target.value as 'C' | 'P' }))}>
            <option value="C">Call</option>
            <option value="P">Put</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Strike</label>
          <input className={inputClass} type="number" step="0.5" value={form.strike} onChange={e => setForm(f => ({ ...f, strike: e.target.value }))} required />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className={labelClass}>Side</label>
          <select className={inputClass} value={form.side} onChange={e => setForm(f => ({ ...f, side: e.target.value }))}>
            <option value="buy_to_open">Buy to Open</option>
            <option value="sell_to_open">Sell to Open</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Qty</label>
          <input className={inputClass} type="number" min="1" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Order Type</label>
          <select className={inputClass} value={form.orderType} onChange={e => setForm(f => ({ ...f, orderType: e.target.value }))}>
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </div>
        {form.orderType === 'limit' && (
          <div>
            <label className={labelClass}>Limit $</label>
            <input className={inputClass} type="number" step="0.01" value={form.limitPrice} onChange={e => setForm(f => ({ ...f, limitPrice: e.target.value }))} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>Target Price</label>
          <input className={inputClass} type="number" step="0.01" placeholder="Optional" value={form.targetPrice} onChange={e => setForm(f => ({ ...f, targetPrice: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Stop Price</label>
          <input className={inputClass} type="number" step="0.01" placeholder="Optional" value={form.stopPrice} onChange={e => setForm(f => ({ ...f, stopPrice: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Thesis</label>
          <input className={inputClass} placeholder="Why this trade?" value={form.thesis} onChange={e => setForm(f => ({ ...f, thesis: e.target.value }))} />
        </div>
      </div>

      <button type="submit" className="w-full py-2 rounded-md bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all text-sm font-medium">
        Place Paper Trade
      </button>
    </form>
  );
}

// ─── Main Component ─────────────────────────────────────────

export default function PaperTradingTab() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [tradeStatus, setTradeStatus] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accRes, ordRes] = await Promise.all([
        fetch('/api/paper/account'),
        fetch('/api/paper/orders'),
      ]);

      if (accRes.status === 501) {
        setNotConfigured(true);
        return;
      }

      if (!accRes.ok) throw new Error((await accRes.json()).error || 'Account fetch failed');
      if (!ordRes.ok) throw new Error((await ordRes.json()).error || 'Orders fetch failed');

      setAccount(await accRes.json());
      const ordData = await ordRes.json();
      setOrders(ordData.orders || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-refresh every 30s
  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, 30000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refresh]);

  const handleTrade = async (trade: Record<string, unknown>) => {
    setTradeStatus(null);
    try {
      const res = await fetch('/api/paper/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trade),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Trade failed');

      // Save metadata
      if (data.orderId) {
        saveNote({
          orderId: data.orderId,
          thesis: (trade.thesis as string) || '',
          targetPrice: (trade.targetPrice as number) || null,
          stopPrice: (trade.stopPrice as number) || null,
          createdAt: new Date().toISOString(),
        });
      }

      setTradeStatus(`Order placed: #${data.orderId} (${data.status})`);
      setShowForm(false);
      setTimeout(refresh, 1000);
    } catch (err) {
      setTradeStatus(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  };

  const handleCancel = async (orderId: number) => {
    try {
      const res = await fetch(`/api/paper/orders?id=${orderId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Cancel failed');
      setTimeout(refresh, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    }
  };

  const notes = loadNotes();
  const getNoteForOrder = (orderId: number) => notes.find(n => n.orderId === orderId);

  if (notConfigured) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="panel">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Wallet className="w-12 h-12 text-text-muted/30 mb-4" />
            <h3 className="text-lg font-semibold text-text-secondary mb-2">Paper Trading</h3>
            <p className="text-sm text-text-muted max-w-md mb-4">
              Paper trading requires a Tradier sandbox API key. Get one free at{' '}
              <span className="text-accent-cyan">developer.tradier.com</span>
            </p>
            <div className="bg-bg-tertiary rounded-lg p-4 text-left text-xs font-mono text-text-muted max-w-md">
              <p className="mb-2 text-text-secondary">Add to your Vercel environment:</p>
              <code className="text-accent-cyan">TRADIER_SANDBOX_KEY=your_sandbox_token</code>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const bal = account?.balances;
  const positions = account?.positions || [];
  const history = account?.history || [];
  const openOrders = orders.filter(o => o.status === 'pending' || o.status === 'open' || o.status === 'partially_filled');
  const recentFills = orders.filter(o => o.status === 'filled').slice(0, 10);

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header + Balance */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-accent-cyan" />
            <span className="panel-title">Paper Trading</span>
            <span className="text-xs text-text-muted font-mono px-1.5 py-0.5 bg-yellow-500/10 text-yellow-400 rounded">
              SANDBOX
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              New Trade
            </button>
            <button onClick={refresh} disabled={loading} className="p-1.5 rounded text-text-muted hover:text-accent-cyan transition-colors">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {bal && (
          <div className="px-4 pb-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <div className="text-xs text-text-muted font-mono">Equity</div>
              <div className="text-lg font-bold text-text-primary">{fmtMoney(bal.total_equity)}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted font-mono">Cash</div>
              <div className="text-base font-semibold text-text-secondary">{fmtMoney(bal.total_cash)}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted font-mono">Positions</div>
              <div className="text-base font-semibold text-text-secondary">{fmtMoney(bal.market_value)}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted font-mono">Open P&L</div>
              <div className={`text-base font-semibold ${bal.open_pl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {bal.open_pl >= 0 ? '+' : ''}{fmtMoney(bal.open_pl)}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted font-mono">Realized</div>
              <div className={`text-base font-semibold ${bal.close_pl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {bal.close_pl >= 0 ? '+' : ''}{fmtMoney(bal.close_pl)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Trade Status */}
      {tradeStatus && (
        <div className={`panel p-3 text-sm font-mono ${tradeStatus.startsWith('Error') ? 'text-red-400 bg-red-500/5 border-red-500/20' : 'text-green-400 bg-green-500/5 border-green-500/20'}`}>
          {tradeStatus}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="panel p-3 text-sm font-mono text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Quick Trade Form */}
      {showForm && <QuickTradeForm onSubmit={handleTrade} onClose={() => setShowForm(false)} />}

      {/* Open Positions */}
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-accent-cyan" />
            Open Positions ({positions.length})
          </span>
        </div>
        {positions.length === 0 ? (
          <div className="px-4 pb-4 text-sm text-text-muted font-mono">No open positions</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Contract</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Qty</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Cost Basis</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Per Contract</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Opened</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Notes</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(p => {
                  const note = notes.find(n => {
                    // Match note to position via order history
                    return false; // Will be enhanced when we add order ID tracking
                  });
                  return (
                    <tr key={p.id} className="border-b border-border/10 hover:bg-bg-hover/50">
                      <td className="px-3 py-2">
                        <div className="font-mono text-text-primary font-semibold">{fmtOCC(p.parsed, p.symbol)}</div>
                      </td>
                      <td className={`px-3 py-2 font-mono ${p.quantity > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {p.quantity > 0 ? '+' : ''}{p.quantity}
                      </td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{fmtMoney(p.cost_basis)}</td>
                      <td className="px-3 py-2 font-mono text-text-muted">{fmtMoney(p.costPerContract)}</td>
                      <td className="px-3 py-2 font-mono text-text-muted text-xs">{p.date_acquired?.split('T')[0]}</td>
                      <td className="px-3 py-2 text-xs text-text-muted max-w-[200px] truncate">
                        {note?.thesis || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Open Orders */}
      {openOrders.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title flex items-center gap-2">
              <Clock className="w-4 h-4 text-yellow-400" />
              Open Orders ({openOrders.length})
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Order</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Side</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Qty</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Type</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Price</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted"></th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map(o => (
                  <tr key={o.id} className="border-b border-border/10 hover:bg-bg-hover/50">
                    <td className="px-3 py-2 font-mono text-text-primary">{fmtOCC(o.parsed || null, o.option_symbol || o.symbol)}</td>
                    <td className="px-3 py-2 font-mono text-text-secondary text-xs">{o.side?.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 font-mono text-text-secondary">{o.quantity}</td>
                    <td className="px-3 py-2 font-mono text-text-muted text-xs">{o.type}</td>
                    <td className="px-3 py-2 font-mono text-text-muted">{o.price ? fmtMoney(o.price) : 'MKT'}</td>
                    <td className="px-3 py-2">
                      <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400">{o.status}</span>
                    </td>
                    <td className="px-3 py-2">
                      <button onClick={() => handleCancel(o.id)} className="text-xs text-red-400 hover:text-red-300 font-mono">Cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Fills */}
      {recentFills.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              Recent Fills
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Contract</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Side</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Qty</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Fill Price</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Date</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Thesis</th>
                </tr>
              </thead>
              <tbody>
                {recentFills.map(o => {
                  const note = getNoteForOrder(o.id);
                  return (
                    <tr key={o.id} className="border-b border-border/10 hover:bg-bg-hover/50">
                      <td className="px-3 py-2 font-mono text-text-primary">{fmtOCC(o.parsed || null, o.option_symbol || o.symbol)}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary text-xs">{o.side?.replace(/_/g, ' ')}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{o.exec_quantity || o.quantity}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{o.avg_fill_price ? fmtMoney(o.avg_fill_price) : '—'}</td>
                      <td className="px-3 py-2 font-mono text-text-muted text-xs">{o.create_date?.split('T')[0]}</td>
                      <td className="px-3 py-2 text-xs text-text-muted max-w-[200px] truncate">{note?.thesis || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Trade History (Closed Positions) */}
      {history.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title flex items-center gap-2">
              {history.reduce((s, h) => s + h.gain_loss, 0) >= 0
                ? <TrendingUp className="w-4 h-4 text-green-400" />
                : <TrendingDown className="w-4 h-4 text-red-400" />
              }
              Closed Trades ({history.length})
            </span>
            <span className={`text-sm font-mono font-semibold ${history.reduce((s, h) => s + h.gain_loss, 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              Total: {fmtMoney(history.reduce((s, h) => s + h.gain_loss, 0))}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Contract</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Qty</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Cost</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Proceeds</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">P&L</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">%</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Closed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i} className="border-b border-border/10 hover:bg-bg-hover/50">
                    <td className="px-3 py-2 font-mono text-text-primary">{fmtOCC(h.parsed, h.symbol)}</td>
                    <td className="px-3 py-2 font-mono text-text-secondary">{h.quantity}</td>
                    <td className="px-3 py-2 font-mono text-text-muted">{fmtMoney(h.cost)}</td>
                    <td className="px-3 py-2 font-mono text-text-secondary">{fmtMoney(h.proceeds)}</td>
                    <td className={`px-3 py-2 font-mono font-semibold ${h.gain_loss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {h.gain_loss >= 0 ? '+' : ''}{fmtMoney(h.gain_loss)}
                    </td>
                    <td className={`px-3 py-2 font-mono text-xs ${h.gain_loss_percent >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {h.gain_loss_percent >= 0 ? '+' : ''}{h.gain_loss_percent?.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2 font-mono text-text-muted text-xs">{h.close_date?.split('T')[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
