'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Wallet, RefreshCw, TrendingUp, TrendingDown, X, Clock,
  CheckCircle2, AlertTriangle, DollarSign, Plus, Target, ShieldAlert,
  Activity, Trash2, ChevronDown, ChevronUp, Eraser,
} from 'lucide-react';

/** Safely extract an error message from a fetch Response that may not be JSON. */
async function safeErrorMsg(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || fallback;
  } catch {
    const text = await res.text().catch(() => '');
    return text.slice(0, 200) || `${fallback} (HTTP ${res.status})`;
  }
}

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
  currentPrice: number;
  currentValue: number;
  unrealizedPL: number;
  unrealizedPLPct: number;
  bid: number;
  ask: number;
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
  leg?: Order[];
}

// Trade rules stored in localStorage — supports grouped (spreads) and single positions
interface TradeRule {
  id: string;
  occSymbols: string[];
  underlying: string;
  strategy: string;
  thesis: string;
  profitTargetPct: number;
  stopLossPct: number;
  autoExit: boolean;
  createdAt: string;
  exitTriggered?: 'target' | 'stop' | null;
  exitOrderId?: number;
  // Legacy single-position fields
  occSymbol?: string;
  targetPrice?: number | null;
  stopPrice?: number | null;
  costBasis?: number;
}

function loadRules(): TradeRule[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem('optix-paper-rules') || '[]'); }
  catch { return []; }
}

function saveRules(rules: TradeRule[]) {
  localStorage.setItem('optix-paper-rules', JSON.stringify(rules));
}

function saveRule(rule: TradeRule) {
  const rules = loadRules().filter(r => r.id !== rule.id && r.occSymbol !== rule.occSymbol);
  rules.push(rule);
  saveRules(rules);
}

function getRuleForSymbol(symbol: string): TradeRule | undefined {
  return loadRules().find(r =>
    r.occSymbols?.includes(symbol) || r.occSymbol === symbol
  );
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function fmtOCC(parsed: ParsedOCC | null, fallback: string): string {
  if (!parsed) return fallback;
  return `${parsed.underlying} ${parsed.expDate} $${parsed.strike} ${parsed.type === 'C' ? 'Call' : 'Put'}`;
}

function PLBadge({ value, pct }: { value: number; pct: number }) {
  const color = value >= 0 ? 'text-green-400' : 'text-red-400';
  const bg = value >= 0 ? 'bg-green-500/10' : 'bg-red-500/10';
  return (
    <span className={`${color} ${bg} px-1.5 py-0.5 rounded text-xs font-mono`}>
      {value >= 0 ? '+' : ''}{fmtMoney(value)} ({pct >= 0 ? '+' : ''}{pct.toFixed(1)}%)
    </span>
  );
}

// Progress bar for target/stop — supports both absolute price and percentage rules
function ExitProgress({ rule, plPct }: { rule: TradeRule | undefined; plPct: number }) {
  if (!rule) return <span className="text-text-muted text-xs">No rules</span>;

  const hasGroupedTargets = rule.profitTargetPct > 0 || rule.stopLossPct > 0;
  const hasLegacyTargets = rule.targetPrice || rule.stopPrice;
  if (!hasGroupedTargets && !hasLegacyTargets) return <span className="text-text-muted text-xs">No rules</span>;

  if (hasGroupedTargets) {
    const tp = rule.profitTargetPct;
    const sl = rule.stopLossPct;
    const targetProgress = tp > 0 ? Math.min(100, Math.max(0, (plPct / tp) * 100)) : 0;
    const stopProgress = sl > 0 ? Math.min(100, Math.max(0, (-plPct / sl) * 100)) : 0;
    const hitTarget = tp > 0 && plPct >= tp;
    const hitStop = sl > 0 && plPct <= -sl;
    const nearTarget = tp > 0 && plPct >= tp * 0.75;
    const nearStop = sl > 0 && plPct <= -sl * 0.75;

    return (
      <div className="flex flex-col gap-1 min-w-[120px]">
        {tp > 0 && (
          <div className="flex items-center gap-1.5">
            <Target className={`w-3 h-3 ${hitTarget ? 'text-green-400' : nearTarget ? 'text-yellow-400' : 'text-text-muted'}`} />
            <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${hitTarget ? 'bg-green-400' : 'bg-accent-cyan/60'}`} style={{ width: `${targetProgress}%` }} />
            </div>
            <span className="text-[10px] font-mono text-text-muted">+{tp}%</span>
          </div>
        )}
        {sl > 0 && (
          <div className="flex items-center gap-1.5">
            <ShieldAlert className={`w-3 h-3 ${hitStop ? 'text-red-400' : nearStop ? 'text-yellow-400' : 'text-text-muted'}`} />
            <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${hitStop ? 'bg-red-400' : 'bg-red-400/40'}`} style={{ width: `${stopProgress}%` }} />
            </div>
            <span className="text-[10px] font-mono text-text-muted">-{sl}%</span>
          </div>
        )}
      </div>
    );
  }

  return <span className="text-text-muted text-xs font-mono">TP: {rule.targetPrice ? fmtMoney(rule.targetPrice) : '—'} / SL: {rule.stopPrice ? fmtMoney(rule.stopPrice) : '—'}</span>;
}

// ─── Edit Rule Modal ─────────────────────────────────────────

function EditRuleForm({ position, rule, onSave, onClose }: {
  position: Position;
  rule: TradeRule | undefined;
  onSave: (rule: TradeRule) => void;
  onClose: () => void;
}) {
  const [targetPct, setTargetPct] = useState(rule?.profitTargetPct?.toString() || '75');
  const [stopPct, setStopPct] = useState(rule?.stopLossPct?.toString() || '50');
  const [thesis, setThesis] = useState(rule?.thesis || '');
  const [autoExit, setAutoExit] = useState(rule?.autoExit ?? true);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      id: rule?.id || `manual-${position.symbol}-${Date.now()}`,
      occSymbols: rule?.occSymbols?.length ? rule.occSymbols : [position.symbol],
      underlying: position.parsed?.underlying || position.symbol.replace(/\d.*/, ''),
      strategy: rule?.strategy || 'Manual',
      thesis,
      profitTargetPct: targetPct ? parseFloat(targetPct) : 0,
      stopLossPct: stopPct ? parseFloat(stopPct) : 0,
      autoExit,
      createdAt: rule?.createdAt || new Date().toISOString(),
    });
    onClose();
  };

  const inputClass = 'bg-bg-tertiary border border-border/30 rounded px-2 py-1.5 text-sm font-mono text-text-primary focus:border-accent-cyan/50 focus:outline-none w-full';

  return (
    <form onSubmit={handleSubmit} className="p-3 bg-bg-tertiary/50 border border-border/20 rounded-lg space-y-2 mt-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-secondary">
          Exit Rules — {fmtOCC(position.parsed, position.symbol)}
        </span>
        <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="text-xs text-text-muted font-mono">
        Entry: {fmtMoney(position.costPerContract)} | Current: {fmtMoney(position.currentPrice)} | P&L: {position.unrealizedPLPct >= 0 ? '+' : ''}{position.unrealizedPLPct.toFixed(1)}%
      </div>
      {rule?.strategy && rule.strategy !== 'Manual' && (
        <div className="text-[10px] text-accent-cyan/70 font-mono">Strategy: {rule.strategy}</div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-text-muted font-mono mb-0.5 block">Take Profit (%)</label>
          <input className={inputClass} type="number" step="5" placeholder="e.g. 50" value={targetPct} onChange={e => setTargetPct(e.target.value)} />
          {targetPct && position.costPerContract > 0 && (
            <span className="text-[10px] text-green-400/60 font-mono">
              ={fmtMoney(position.costPerContract * (1 + parseFloat(targetPct) / 100))}/contract
            </span>
          )}
        </div>
        <div>
          <label className="text-[10px] text-text-muted font-mono mb-0.5 block">Stop Loss (%)</label>
          <input className={inputClass} type="number" step="5" placeholder="e.g. 50" value={stopPct} onChange={e => setStopPct(e.target.value)} />
          {stopPct && position.costPerContract > 0 && (
            <span className="text-[10px] text-red-400/60 font-mono">
              ={fmtMoney(position.costPerContract * (1 - parseFloat(stopPct) / 100))}/contract
            </span>
          )}
        </div>
      </div>
      <div>
        <label className="text-[10px] text-text-muted font-mono mb-0.5 block">Thesis / Notes</label>
        <input className={inputClass} placeholder="Why this trade?" value={thesis} onChange={e => setThesis(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="autoExit" checked={autoExit} onChange={e => setAutoExit(e.target.checked)} className="w-3.5 h-3.5 rounded border-border/30 accent-accent-cyan" />
        <label htmlFor="autoExit" className="text-xs text-text-muted font-mono">Auto-close when target/stop hit (monitored every 60s)</label>
      </div>
      <button type="submit" className="w-full py-1.5 rounded-md bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30 transition-all text-xs font-medium">
        Save Exit Rules
      </button>
    </form>
  );
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
      duration: 'gtc',
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
          <label className={labelClass}>Take Profit $</label>
          <input className={inputClass} type="number" step="0.01" placeholder="Option price target" value={form.targetPrice} onChange={e => setForm(f => ({ ...f, targetPrice: e.target.value }))} />
        </div>
        <div>
          <label className={labelClass}>Stop Loss $</label>
          <input className={inputClass} type="number" step="0.01" placeholder="Option price stop" value={form.stopPrice} onChange={e => setForm(f => ({ ...f, stopPrice: e.target.value }))} />
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

// ─── Spread Grouping Helper ─────────────────────────────────

interface SpreadGroup {
  id: string;
  strategy: string;
  thesis: string;
  underlying: string;
  legs: Position[];
  netCostBasis: number;
  netCurrentValue: number;
  netPL: number;
  netPLPct: number;
  rule: TradeRule | undefined;
  spreadLabel: string;
}

/** Group positions into spreads using trade rules. Ungrouped positions stay as single-leg groups. */
function groupPositionsIntoSpreads(positions: Position[]): SpreadGroup[] {
  const rules = loadRules();
  const assigned = new Set<number>(); // position IDs already assigned to a group
  const groups: SpreadGroup[] = [];

  // First pass: group by trade rules
  for (const rule of rules) {
    const ruleSymbols = new Set(rule.occSymbols || (rule.occSymbol ? [rule.occSymbol] : []));
    if (ruleSymbols.size === 0) continue;

    const matched = positions.filter(p => ruleSymbols.has(p.symbol) && !assigned.has(p.id));
    if (matched.length === 0) continue;

    for (const p of matched) assigned.add(p.id);

    const netCost = matched.reduce((s, p) => s + p.cost_basis, 0);
    const netCurrentValue = matched.reduce((s, p) => {
      const sign = p.quantity > 0 ? 1 : -1;
      return s + p.currentPrice * Math.abs(p.quantity) * 100 * sign;
    }, 0);
    const netPL = matched.reduce((s, p) => s + p.unrealizedPL, 0);
    const absNetCost = Math.abs(netCost);
    const netPLPct = absNetCost > 0 ? (netPL / absNetCost) * 100 : 0;

    // Build spread label like "AAPL Bull Call $260/$265 ×10"
    const underlying = rule.underlying || matched[0]?.parsed?.underlying || '';
    const strikes = matched
      .map(p => p.parsed?.strike)
      .filter((s): s is number => s !== undefined)
      .sort((a, b) => a - b);
    const qty = Math.max(...matched.map(p => Math.abs(p.quantity)));
    const strikesStr = strikes.map(s => `$${s}`).join('/');
    const strategyClean = rule.strategy.replace(/^\[AI\]\s*/, '');
    const spreadLabel = `${underlying} ${strategyClean} ${strikesStr} ×${qty}`;

    groups.push({
      id: rule.id,
      strategy: rule.strategy,
      thesis: rule.thesis,
      underlying,
      legs: matched,
      netCostBasis: netCost,
      netCurrentValue,
      netPL,
      netPLPct,
      rule,
      spreadLabel,
    });
  }

  // Second pass: ungrouped positions become single-leg groups
  for (const p of positions) {
    if (assigned.has(p.id)) continue;
    const rule = getRuleForSymbol(p.symbol);
    const underlying = p.parsed?.underlying || '';
    const strike = p.parsed?.strike || 0;
    const type = p.parsed?.type === 'C' ? 'Call' : 'Put';
    const side = p.quantity > 0 ? 'Long' : 'Short';
    const spreadLabel = `${underlying} ${side} $${strike} ${type} ×${Math.abs(p.quantity)}`;

    groups.push({
      id: `single-${p.id}`,
      strategy: rule?.strategy || 'Single',
      thesis: rule?.thesis || '',
      underlying,
      legs: [p],
      netCostBasis: p.cost_basis,
      netCurrentValue: p.currentValue * (p.quantity > 0 ? 1 : -1),
      netPL: p.unrealizedPL,
      netPLPct: p.unrealizedPLPct,
      rule,
      spreadLabel,
    });
  }

  return groups;
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
  const [editingRule, setEditingRule] = useState<string | null>(null); // OCC symbol being edited
  const [showHistory, setShowHistory] = useState(false);
  const [showFills, setShowFills] = useState(false);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [confirmPurgeRules, setConfirmPurgeRules] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
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

      if (!accRes.ok) throw new Error(await safeErrorMsg(accRes, 'Account fetch failed'));
      if (!ordRes.ok) throw new Error(await safeErrorMsg(ordRes, 'Orders fetch failed'));

      const accData = await accRes.json();
      setAccount(accData);
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

      let data;
      try { data = await res.json(); } catch { throw new Error(await safeErrorMsg(res, 'Trade failed')); }
      if (!res.ok) throw new Error(data.error || 'Trade failed');

      // Save exit rules if target/stop were specified
      if (data.occSymbol && (trade.targetPrice || trade.stopPrice)) {
        saveRule({
          id: `quick-${data.occSymbol}-${Date.now()}`,
          occSymbols: [data.occSymbol],
          underlying: (trade.symbol as string) || '',
          strategy: 'Manual',
          thesis: (trade.thesis as string) || '',
          profitTargetPct: (trade.targetPrice as number) || 75,
          stopLossPct: (trade.stopPrice as number) || 50,
          autoExit: true,
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
      if (!res.ok) throw new Error(await safeErrorMsg(res, 'Cancel failed'));
      setTimeout(refresh, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    }
  };

  const handleManualClose = async (position: Position) => {
    try {
      const res = await fetch('/api/paper/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: position.symbol, quantity: position.quantity }),
      });
      let data;
      try { data = await res.json(); } catch { throw new Error(await safeErrorMsg(res, 'Close failed')); }
      if (!res.ok) throw new Error(data.error || 'Close failed');
      setTradeStatus(`Closing order placed: #${data.orderId}`);
      setTimeout(refresh, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Close failed');
    }
  };

  const handleCancelAllOrders = async () => {
    setCancellingAll(true);
    try {
      for (const o of orders.filter(o => o.status === 'pending' || o.status === 'open' || o.status === 'partially_filled')) {
        try { await fetch(`/api/paper/orders?id=${o.id}`, { method: 'DELETE' }); } catch {}
      }
      setTimeout(refresh, 500);
    } finally {
      setCancellingAll(false);
    }
  };

  const handlePurgeRules = () => {
    localStorage.removeItem('optix-paper-rules');
    setConfirmPurgeRules(false);
    refresh();
  };

  const handleResetPaperTrading = async () => {
    setResetting(true);
    setConfirmReset(false);
    try {
      await fetch('/api/paper/reset', { method: 'POST', signal: AbortSignal.timeout(25000) });
      localStorage.removeItem('optix-paper-rules');
      setTimeout(refresh, 1000); // Wait for Tradier to process closes
    } catch { /* best effort */ }
    finally { setResetting(false); }
  };

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
  const rulesWithTargets = loadRules().filter(r => r.autoExit && !r.exitTriggered && (r.profitTargetPct || r.stopLossPct || r.targetPrice || r.stopPrice));

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
            {rulesWithTargets.length > 0 && (
              <span className="text-xs font-mono px-1.5 py-0.5 bg-accent-cyan/10 text-accent-cyan rounded flex items-center gap-1">
                <Activity className="w-3 h-3" />
                Monitoring {rulesWithTargets.length} position{rulesWithTargets.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Reset all paper trading: cancel orders + close positions + clear rules */}
            {confirmReset ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-red-400 font-mono">Close all positions & cancel orders?</span>
                <button onClick={handleResetPaperTrading} className="px-2 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors">Yes</button>
                <button onClick={() => setConfirmReset(false)} className="px-2 py-0.5 rounded text-[10px] font-mono text-text-muted hover:text-text-secondary transition-colors">No</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmReset(true)}
                disabled={resetting}
                className="px-2 py-1 rounded text-xs font-mono text-text-muted hover:text-red-400 transition-colors flex items-center gap-1 disabled:opacity-50"
                title="Cancel all orders, close all positions, and clear exit rules"
              >
                {resetting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Reset All
              </button>
            )}
            {/* Purge trade rules */}
            {confirmPurgeRules ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-amber-400 font-mono">Clear rules?</span>
                <button onClick={handlePurgeRules} className="px-2 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors">Yes</button>
                <button onClick={() => setConfirmPurgeRules(false)} className="px-2 py-0.5 rounded text-[10px] font-mono text-text-muted hover:text-text-secondary transition-colors">No</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmPurgeRules(true)}
                className="px-2 py-1 rounded text-xs font-mono text-text-muted hover:text-amber-400 transition-colors flex items-center gap-1"
                title="Purge all trade rules"
              >
                <Eraser className="w-3.5 h-3.5" />Rules
              </button>
            )}
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

      {/* Open Positions — grouped by spread */}
      {(() => {
        const spreadGroups = groupPositionsIntoSpreads(positions);
        return (
          <div className="panel">
            <div className="panel-header">
              <span className="panel-title flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-accent-cyan" />
                Open Positions ({spreadGroups.length} spread{spreadGroups.length !== 1 ? 's' : ''}, {positions.length} leg{positions.length !== 1 ? 's' : ''})
              </span>
            </div>
            {spreadGroups.length === 0 ? (
              <div className="px-4 pb-4 text-sm text-text-muted font-mono">No open positions</div>
            ) : (
              <div className="space-y-0">
                {spreadGroups.map(group => {
                  const isMultiLeg = group.legs.length > 1;
                  return (
                    <div key={group.id} className="border-b border-border/10 hover:bg-bg-hover/30 transition-colors">
                      {/* Spread summary row */}
                      <div className="px-4 py-3 flex items-center justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-text-primary font-semibold text-sm">
                            {group.spreadLabel}
                          </div>
                          {group.strategy && group.strategy !== 'Single' && group.strategy !== 'Manual' && (
                            <div className="text-[10px] text-accent-cyan/70 font-mono mt-0.5">{group.strategy}</div>
                          )}
                          {group.thesis && <div className="text-[10px] text-text-muted truncate max-w-[300px] mt-0.5">{group.thesis}</div>}
                        </div>

                        <div className="flex items-center gap-4 flex-shrink-0">
                          {/* Net cost basis */}
                          <div className="text-right">
                            <div className="text-[10px] text-text-muted font-mono">Net Cost</div>
                            <div className={`text-xs font-mono font-semibold ${group.netCostBasis >= 0 ? 'text-text-secondary' : 'text-green-400'}`}>
                              {group.netCostBasis >= 0 ? fmtMoney(group.netCostBasis) : `${fmtMoney(Math.abs(group.netCostBasis))} cr`}
                            </div>
                          </div>

                          {/* Net P/L */}
                          <div className="text-right min-w-[120px]">
                            <div className="text-[10px] text-text-muted font-mono">Net P&L</div>
                            <PLBadge value={group.netPL} pct={group.netPLPct} />
                          </div>

                          {/* Exit progress */}
                          <div className="min-w-[130px]">
                            <ExitProgress rule={group.rule} plPct={group.netPLPct} />
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1">
                            {group.legs.length > 0 && (
                              <>
                                <button
                                  onClick={() => setEditingRule(editingRule === group.id ? null : group.id)}
                                  className="text-xs font-mono text-accent-cyan hover:text-accent-cyan/80 px-1.5 py-0.5"
                                  title="Edit exit rules"
                                >
                                  <Target className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={async () => {
                                    for (const leg of group.legs) {
                                      await handleManualClose(leg);
                                    }
                                  }}
                                  className="text-xs text-red-400 hover:text-red-300 font-mono px-1.5 py-0.5"
                                  title="Close all legs"
                                >
                                  Close
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Individual leg details (shown for multi-leg spreads) */}
                      {isMultiLeg && (
                        <div className="px-4 pb-2">
                          <table className="w-full text-xs">
                            <tbody>
                              {group.legs.map(p => (
                                <tr key={p.id} className="text-text-muted">
                                  <td className="py-0.5 font-mono w-1/3">
                                    <span className={p.quantity > 0 ? 'text-green-400/70' : 'text-red-400/70'}>
                                      {p.quantity > 0 ? 'BUY' : 'SELL'}
                                    </span>
                                    {' '}{fmtOCC(p.parsed, p.symbol)}
                                  </td>
                                  <td className="py-0.5 font-mono text-center">
                                    <span className={p.quantity > 0 ? 'text-green-400/60' : 'text-red-400/60'}>
                                      {p.quantity > 0 ? '+' : ''}{p.quantity}
                                    </span>
                                  </td>
                                  <td className="py-0.5 font-mono text-right">
                                    Entry: {fmtMoney(p.costPerContract)}
                                  </td>
                                  <td className="py-0.5 font-mono text-right">
                                    Now: {p.currentPrice > 0 ? fmtMoney(p.currentPrice) : '—'}
                                    {p.bid > 0 && <span className="text-text-muted/50"> ({fmtMoney(p.bid)}/{fmtMoney(p.ask)})</span>}
                                  </td>
                                  <td className="py-0.5 font-mono text-right">
                                    {p.currentPrice > 0 ? (
                                      <span className={p.unrealizedPL >= 0 ? 'text-green-400/60' : 'text-red-400/60'}>
                                        {p.unrealizedPL >= 0 ? '+' : ''}{fmtMoney(p.unrealizedPL)}
                                      </span>
                                    ) : '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Inline edit rule form */}
                      {editingRule === group.id && group.legs.length > 0 && (
                        <div className="px-4 pb-3">
                          <EditRuleForm
                            position={group.legs[0]}
                            rule={group.rule}
                            onSave={saveRule}
                            onClose={() => setEditingRule(null)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Open Orders */}
      {openOrders.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title flex items-center gap-2">
              <Clock className="w-4 h-4 text-yellow-400" />
              Open Orders ({openOrders.length})
            </span>
            <button
              onClick={handleCancelAllOrders}
              disabled={cancellingAll}
              className="px-2 py-1 rounded text-xs font-mono text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              {cancellingAll ? 'Cancelling...' : 'Cancel All'}
            </button>
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
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Duration</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Status</th>
                  <th className="px-3 py-2 text-left text-xs font-mono text-text-muted"></th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map(o => {
                  // For multileg orders, show legs
                  const isMultileg = o.class === 'multileg' && o.leg && o.leg.length > 0;
                  return (
                    <tr key={o.id} className="border-b border-border/10 hover:bg-bg-hover/50">
                      <td className="px-3 py-2">
                        {isMultileg ? (
                          <div className="space-y-0.5">
                            <div className="font-mono text-text-primary text-xs font-semibold">{o.symbol} Spread</div>
                            {o.leg!.map((leg, i) => (
                              <div key={i} className="font-mono text-text-muted text-[10px]">
                                {leg.side?.replace(/_/g, ' ')} {fmtOCC(leg.parsed || null, leg.option_symbol || '')}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="font-mono text-text-primary">{fmtOCC(o.parsed || null, o.option_symbol || o.symbol)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-text-secondary text-xs">{isMultileg ? 'multileg' : o.side?.replace(/_/g, ' ')}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{o.quantity}</td>
                      <td className="px-3 py-2 font-mono text-text-muted text-xs">{o.type}</td>
                      <td className="px-3 py-2 font-mono text-text-muted">{o.price ? fmtMoney(o.price) : 'MKT'}</td>
                      <td className="px-3 py-2 font-mono text-text-muted text-xs">{o.duration || 'day'}</td>
                      <td className="px-3 py-2">
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400">{o.status}</span>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => handleCancel(o.id)} className="text-xs text-red-400 hover:text-red-300 font-mono">Cancel</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Fills (collapsible) */}
      {recentFills.length > 0 && (
        <div className="panel">
          <div className="panel-header cursor-pointer" onClick={() => setShowFills(!showFills)}>
            <span className="panel-title flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              Recent Fills ({recentFills.length})
            </span>
            {showFills ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
          </div>
          {showFills && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/30">
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Contract</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Side</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Qty</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Fill Price</th>
                    <th className="px-3 py-2 text-left text-xs font-mono text-text-muted">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recentFills.map(o => (
                    <tr key={o.id} className="border-b border-border/10 hover:bg-bg-hover/50">
                      <td className="px-3 py-2 font-mono text-text-primary">{fmtOCC(o.parsed || null, o.option_symbol || o.symbol)}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary text-xs">{o.side?.replace(/_/g, ' ')}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{o.exec_quantity || o.quantity}</td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{o.avg_fill_price ? fmtMoney(o.avg_fill_price) : '—'}</td>
                      <td className="px-3 py-2 font-mono text-text-muted text-xs">{o.create_date?.split('T')[0]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Trade History (Closed Positions - collapsible) */}
      {history.length > 0 && (
        <div className="panel">
          <div className="panel-header cursor-pointer" onClick={() => setShowHistory(!showHistory)}>
            <span className="panel-title flex items-center gap-2">
              {history.reduce((s, h) => s + h.gain_loss, 0) >= 0
                ? <TrendingUp className="w-4 h-4 text-green-400" />
                : <TrendingDown className="w-4 h-4 text-red-400" />
              }
              Closed Trades ({history.length})
              <span className={`text-sm font-mono font-semibold ${history.reduce((s, h) => s + h.gain_loss, 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {fmtMoney(history.reduce((s, h) => s + h.gain_loss, 0))}
              </span>
            </span>
            {showHistory ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
          </div>
          {showHistory && (
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
          )}
        </div>
      )}
    </div>
  );
}
