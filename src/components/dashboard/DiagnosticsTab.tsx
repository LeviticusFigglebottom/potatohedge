'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  HeartPulse, AlertTriangle, CheckCircle2, Wifi, WifiOff,
  Clock, RefreshCw, Trash2, ChevronDown, ChevronUp, Activity,
  Server, Database, Zap, Bug, Shield, TrendingUp, Play,
  XCircle, Sun, Moon, Square,
} from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────

interface HealthData {
  status: 'healthy' | 'degraded' | 'critical';
  timestamp: number;
  persistence: { redis: boolean; blob: boolean; connected: boolean };
  trades: {
    total: number; open: number; pending: number; entered: number;
    exited: number; expired: number; unpriced: number; expiredNotClosed: number;
  };
  errors: {
    total: number;
    bySeverity: Record<string, number>;
    bySource: Record<string, number>;
    recentCritical: ErrorEntry[];
    lastError: ErrorEntry | null;
  };
  issues: string[];
  apis: { tradier: boolean; polygon: boolean; claude: boolean };
}

interface ErrorEntry {
  id: string;
  timestamp: number;
  severity: 'info' | 'warn' | 'error' | 'critical';
  source: string;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
}

interface ApiResult {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

interface TradeQuality {
  tradeId: string;
  symbol: string;
  strategy: string;
  issues: string[];
}

interface TradeSummary {
  id: string;
  symbol: string;
  strategy: string;
  direction: string;
  source: string;
  status: string;
  outcome: string | null;
  legs: number;
  entryDebit: number | null;
  maxRisk: number | null;
  realizedPL: number | null;
  realizedPLPct: number | null;
  trackedAt: string;
  expirationDate: string;
}

interface EvalResult {
  tradeId: string;
  symbol: string;
  action: string;
  detail: string;
}

// ─── Helpers ────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function daysUntil(dateStr: string): number {
  const exp = new Date(dateStr + 'T16:00:00-05:00').getTime();
  return Math.ceil((exp - Date.now()) / 86400000);
}

const severityColor: Record<string, string> = {
  info: 'text-blue-400 bg-blue-400/10',
  warn: 'text-amber-400 bg-amber-400/10',
  error: 'text-red-400 bg-red-400/10',
  critical: 'text-red-500 bg-red-500/15 font-semibold',
};

const statusColor: Record<string, string> = {
  healthy: 'text-accent-green',
  degraded: 'text-accent-amber',
  critical: 'text-accent-red',
};

async function diagPost(action: string, body: Record<string, unknown> = {}) {
  const res = await fetch('/api/diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

// ─── Health Status Indicator ────────────────────────────────

function HealthIndicator({ status }: { status: string }) {
  const color = status === 'healthy' ? 'bg-accent-green' : status === 'degraded' ? 'bg-accent-amber' : 'bg-accent-red';
  return (
    <div className="flex items-center gap-2">
      <div className={`w-2.5 h-2.5 rounded-full ${color} animate-pulse`} />
      <span className={`text-sm font-mono font-semibold capitalize ${statusColor[status] || 'text-text-muted'}`}>{status}</span>
    </div>
  );
}

// ─── Market Hours Badge ─────────────────────────────────────

function MarketHoursBadge({ marketInfo }: { marketInfo: ApiResult | undefined }) {
  if (!marketInfo) return null;
  const open = marketInfo.available;
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono ${
      open ? 'bg-accent-green/10 text-accent-green border border-accent-green/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
    }`}>
      {open ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
      <span>{open ? 'Market Open' : 'Market Closed'}</span>
    </div>
  );
}

// ─── API Status Card ────────────────────────────────────────

function ApiCard({ name, result, icon: Icon, optional }: {
  name: string;
  result: ApiResult | undefined;
  icon: React.ElementType;
  optional?: boolean;
}) {
  if (!result) return null;
  const unavailableButOptional = !result.available && optional;
  return (
    <div className={`panel px-4 py-3 border ${
      result.available ? 'border-green-500/20' :
      unavailableButOptional ? 'border-border/30' : 'border-red-500/20'
    }`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Icon className={`w-3.5 h-3.5 ${
            result.available ? 'text-accent-green' :
            unavailableButOptional ? 'text-text-muted' : 'text-accent-red'
          }`} />
          <span className="text-xs font-mono font-semibold text-text-primary">{name}</span>
          {optional && !result.available && (
            <span className="text-[8px] font-mono text-text-muted/50 uppercase">optional</span>
          )}
        </div>
        {result.available ? (
          <Wifi className="w-3.5 h-3.5 text-accent-green" />
        ) : unavailableButOptional ? (
          <span className="text-[10px] text-text-muted">—</span>
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-accent-red" />
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-mono break-all ${
          result.available ? 'text-accent-green' :
          unavailableButOptional ? 'text-text-muted/60' : 'text-accent-red'
        }`}>
          {result.available ? 'Connected' : result.error || 'Unavailable'}
        </span>
        {result.latencyMs !== undefined && (
          <span className={`text-[10px] font-mono shrink-0 ml-2 ${result.latencyMs < 500 ? 'text-accent-green' : result.latencyMs < 2000 ? 'text-accent-amber' : 'text-accent-red'}`}>
            {result.latencyMs}ms
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Error Row ──────────────────────────────────────────────

function ErrorRow({ entry }: { entry: ErrorEntry }) {
  const [expanded, setExpanded] = useState(false);
  const colorClass = severityColor[entry.severity] || 'text-text-muted bg-bg-tertiary';

  return (
    <div className="border-b border-border/10 last:border-0">
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-bg-tertiary/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded uppercase ${colorClass}`}>
          {entry.severity}
        </span>
        <span className="text-[10px] font-mono text-accent-cyan shrink-0">{entry.source}</span>
        <span className="text-xs font-mono text-text-secondary truncate flex-1">{entry.message}</span>
        <span className="text-[10px] font-mono text-text-muted shrink-0">{timeAgo(entry.timestamp)}</span>
        {(entry.context || entry.stack) && (
          expanded ? <ChevronUp className="w-3 h-3 text-text-muted" /> : <ChevronDown className="w-3 h-3 text-text-muted" />
        )}
      </div>
      {expanded && (entry.context || entry.stack) && (
        <div className="px-3 pb-2">
          {entry.context && (
            <pre className="text-[10px] font-mono text-text-muted bg-bg-tertiary/50 rounded p-2 overflow-x-auto max-h-32">
              {JSON.stringify(entry.context, null, 2)}
            </pre>
          )}
          {entry.stack && (
            <pre className="text-[10px] font-mono text-red-400/60 mt-1 overflow-x-auto max-h-24">{entry.stack}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Quality Issue Row ──────────────────────────────────────

function QualityIssueRow({ issue }: { issue: TradeQuality }) {
  return (
    <div className="px-3 py-2 border-b border-border/10 last:border-0">
      <div className="flex items-center gap-2 mb-1">
        <Bug className="w-3 h-3 text-accent-amber" />
        <span className="text-xs font-mono font-semibold text-text-primary">{issue.symbol}</span>
        <span className="text-[10px] font-mono text-text-muted">{issue.strategy}</span>
      </div>
      <div className="space-y-0.5 ml-5">
        {issue.issues.map((msg, i) => (
          <div key={i} className="text-[10px] font-mono text-accent-amber/80 flex items-start gap-1">
            <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
            <span>{msg}</span>
          </div>
        ))}
      </div>
      <div className="text-[9px] font-mono text-text-muted/50 ml-5 mt-1">{issue.tradeId}</div>
    </div>
  );
}

// ─── Trade Row with Actions ─────────────────────────────────

function TradeRow({ trade, onForceClose, closingId }: {
  trade: TradeSummary;
  onForceClose: (id: string, reason: string) => void;
  closingId: string | null;
}) {
  const isOpen = trade.status === 'pending' || trade.status === 'entered';
  const dte = daysUntil(trade.expirationDate);
  const isExpired = dte < 0;
  const closing = closingId === trade.id;

  return (
    <div className="px-3 py-2 flex items-center gap-3 text-xs font-mono group hover:bg-bg-tertiary/20 transition-colors">
      <span className={`w-2 h-2 rounded-full shrink-0 ${
        trade.status === 'entered' ? 'bg-accent-cyan' : trade.status === 'pending' ? 'bg-blue-400' :
        trade.outcome === 'win' ? 'bg-accent-green' : trade.outcome === 'loss' ? 'bg-accent-red' : 'bg-text-muted'
      }`} />
      <span className="font-semibold text-text-primary w-12">{trade.symbol}</span>
      <span className="text-text-muted truncate flex-1">{trade.strategy}</span>
      <span className={`shrink-0 ${
        trade.status === 'entered' ? 'text-accent-cyan' : trade.status === 'pending' ? 'text-blue-400' :
        'text-text-muted'
      }`}>{trade.status}</span>
      {trade.realizedPL !== null ? (
        <span className={`shrink-0 w-16 text-right ${trade.realizedPL >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
          {trade.realizedPL >= 0 ? '+' : ''}${trade.realizedPL.toFixed(0)}
        </span>
      ) : (
        <span className="shrink-0 w-16 text-right text-text-muted/30">—</span>
      )}
      <span className={`shrink-0 w-16 text-right ${isExpired ? 'text-accent-red' : dte <= 1 ? 'text-accent-amber' : 'text-text-muted/50'}`}>
        {isExpired ? `${Math.abs(dte)}d ago` : `${dte}d`}
      </span>
      {/* Actions for open trades */}
      {isOpen && (
        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isExpired && (
            <button
              onClick={() => onForceClose(trade.id, 'expiration')}
              disabled={closing}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 transition-colors disabled:opacity-50"
              title="Close as expired with live pricing"
            >
              {closing ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Clock className="w-2.5 h-2.5" />}
              Expire
            </button>
          )}
          <button
            onClick={() => onForceClose(trade.id, 'manual-close')}
            disabled={closing}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
            title="Force close with current market prices"
          >
            {closing ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Square className="w-2.5 h-2.5" />}
            Close
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Eval Results Display ───────────────────────────────────

function EvalResults({ results, errors }: {
  results: EvalResult[];
  errors?: { tradeId: string; error: string }[];
}) {
  return (
    <div className="panel border border-accent-cyan/20 bg-accent-cyan/5">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Play className="w-3.5 h-3.5 text-accent-cyan" />
          <span className="panel-title text-xs">Evaluation Results</span>
          <span className="text-[10px] font-mono text-text-muted">{results.length} trades processed</span>
        </div>
      </div>
      <div className="max-h-48 overflow-y-auto divide-y divide-border/10">
        {results.map((r, i) => (
          <div key={i} className="px-3 py-2 flex items-center gap-2 text-xs font-mono">
            <span className={`w-2 h-2 rounded-full shrink-0 ${
              r.action === 'profit-target' ? 'bg-accent-green' :
              r.action === 'stop-loss' || r.action === 'expired' ? 'bg-accent-red' :
              r.action === 'entered' ? 'bg-accent-cyan' : 'bg-blue-400'
            }`} />
            <span className="font-semibold text-text-primary w-10">{r.symbol}</span>
            <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${
              r.action === 'profit-target' ? 'bg-accent-green/15 text-accent-green' :
              r.action === 'stop-loss' ? 'bg-red-500/15 text-red-400' :
              r.action === 'expired' ? 'bg-amber-500/15 text-amber-400' :
              r.action === 'entered' ? 'bg-accent-cyan/15 text-accent-cyan' :
              'bg-blue-400/15 text-blue-400'
            }`}>{r.action}</span>
            <span className="text-text-secondary truncate flex-1">{r.detail}</span>
          </div>
        ))}
        {errors && errors.map((e, i) => (
          <div key={`err-${i}`} className="px-3 py-2 flex items-center gap-2 text-xs font-mono">
            <XCircle className="w-3 h-3 text-red-400 shrink-0" />
            <span className="text-red-400 truncate">{e.tradeId}: {e.error}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

export default function DiagnosticsTab() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [apis, setApis] = useState<Record<string, ApiResult> | null>(null);
  const [trades, setTrades] = useState<TradeSummary[]>([]);
  const [qualityIssues, setQualityIssues] = useState<TradeQuality[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorFilter, setErrorFilter] = useState<string>('all');
  const [lastRefresh, setLastRefresh] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [evaluating, setEvaluating] = useState(false);
  const [evalResults, setEvalResults] = useState<{ results: EvalResult[]; errors?: { tradeId: string; error: string }[] } | null>(null);
  const [closingTradeId, setClosingTradeId] = useState<string | null>(null);
  const [confirmNuclear, setConfirmNuclear] = useState(false);
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;

  const fetchAll = useCallback(async (showRefreshing = true) => {
    if (showRefreshing) setRefreshing(true);
    try {
      const [healthRes, errorsRes, apisRes, tradesRes] = await Promise.allSettled([
        fetch('/api/diagnostics?check=health', { signal: AbortSignal.timeout(10000) }),
        fetch('/api/diagnostics?check=errors&limit=100', { signal: AbortSignal.timeout(10000) }),
        fetch('/api/diagnostics?check=apis', { signal: AbortSignal.timeout(15000) }),
        fetch('/api/diagnostics?check=trades', { signal: AbortSignal.timeout(10000) }),
      ]);

      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        setHealth(await healthRes.value.json());
      }
      if (errorsRes.status === 'fulfilled' && errorsRes.value.ok) {
        const data = await errorsRes.value.json();
        setErrors(data.entries || []);
      }
      if (apisRes.status === 'fulfilled' && apisRes.value.ok) {
        setApis(await apisRes.value.json());
      }
      if (tradesRes.status === 'fulfilled' && tradesRes.value.ok) {
        const data = await tradesRes.value.json();
        setTrades(data.trades || []);
        setQualityIssues(data.qualityIssues || []);
      }

      setLastRefresh(Date.now());
    } catch {
      // Silently fail — diagnostics shouldn't crash the app
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAll(false);
    const interval = setInterval(() => {
      if (autoRefreshRef.current) fetchAll(false);
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const handleClearErrors = async () => {
    await diagPost('clear-errors').catch(() => {});
    setErrors([]);
  };

  const handleClearExpired = async () => {
    await diagPost('clear-expired').catch(() => {});
    fetchAll();
  };

  const handlePurgeClosed = async () => {
    await diagPost('purge-closed').catch(() => {});
    fetchAll();
  };

  const handlePurgeAll = async () => {
    await diagPost('purge-all').catch(() => {});
    // Also clear localStorage to prevent stale data from re-syncing
    if (typeof window !== 'undefined') {
      localStorage.removeItem('optix_tracked_trades');
      localStorage.removeItem('optix_tracked_trades:lastSave');
      localStorage.removeItem('optix_tracked_trades:deletedIds');
    }
    fetchAll();
  };

  const handleForceEvaluate = async () => {
    setEvaluating(true);
    setEvalResults(null);
    try {
      const result = await diagPost('force-evaluate');
      if (result.ok) {
        setEvalResults({ results: result.results || [], errors: result.errors });
      }
      await fetchAll(false);
    } catch {
      // handled by error log
    } finally {
      setEvaluating(false);
    }
  };

  const handleForceClose = async (tradeId: string, reason: string) => {
    setClosingTradeId(tradeId);
    try {
      await diagPost('force-close', { id: tradeId, reason });
      await fetchAll(false);
    } catch {
      // handled by error log
    } finally {
      setClosingTradeId(null);
    }
  };

  const filteredErrors = errorFilter === 'all'
    ? errors
    : errors.filter(e => e.severity === errorFilter);

  const openTrades = trades.filter(t => t.status === 'pending' || t.status === 'entered');
  const closedTrades = trades.filter(t => t.status === 'exited' || t.status === 'expired');
  const isMarketOpen = apis?._marketHours?.available ?? false;

  if (loading) {
    return (
      <div className="panel p-6 flex items-center justify-center">
        <div className="flex items-center gap-3 text-text-muted font-mono text-sm">
          <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
          Loading diagnostics...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-3">
            <HeartPulse className="w-4 h-4 text-accent-cyan" />
            <span className="panel-title">System Diagnostics</span>
            {health && <HealthIndicator status={health.status} />}
            <MarketHoursBadge marketInfo={apis?._marketHours} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`px-2 py-1 rounded text-[10px] font-mono transition-colors ${autoRefresh ? 'bg-accent-green/15 text-accent-green' : 'text-text-muted hover:text-text-secondary'}`}
            >
              Auto-refresh {autoRefresh ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() => fetchAll()}
              disabled={refreshing}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono text-text-muted hover:text-accent-cyan transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {lastRefresh > 0 && (
              <span className="text-[9px] font-mono text-text-muted/50">{timeAgo(lastRefresh)}</span>
            )}
          </div>
        </div>
        {/* Market hours explanation when closed */}
        {!isMarketOpen && apis?._marketHours?.error && (
          <div className="px-4 pb-3 -mt-1">
            <div className="flex items-start gap-2 text-[10px] font-mono text-amber-400/70 bg-amber-500/5 rounded px-3 py-2 border border-amber-500/10">
              <Moon className="w-3 h-3 mt-0.5 shrink-0" />
              <div>
                <span>{apis._marketHours.error}</span>
                <span className="text-text-muted/50 ml-1">
                  Use Force Evaluate below to run server-side evaluation and close trades outside market hours.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Issues Banner */}
      {health && health.issues.length > 0 && (
        <div className={`panel border ${health.status === 'critical' ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className={`w-4 h-4 ${health.status === 'critical' ? 'text-red-400' : 'text-amber-400'}`} />
              <span className={`text-sm font-mono font-semibold ${health.status === 'critical' ? 'text-red-400' : 'text-amber-400'}`}>
                {health.issues.length} Issue{health.issues.length !== 1 ? 's' : ''} Detected
              </span>
            </div>
            <div className="space-y-1">
              {health.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-xs font-mono text-text-secondary">
                  <span className="text-accent-amber shrink-0">{'>'}</span>
                  <span>{issue}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-3">
              {health.trades.expiredNotClosed > 0 && (
                <button
                  onClick={handleClearExpired}
                  className="px-3 py-1 rounded text-[10px] font-mono bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 transition-colors"
                >
                  Close {health.trades.expiredNotClosed} expired (no pricing)
                </button>
              )}
              {(health.trades.exited > 0 || health.trades.expired > 0) && (
                <button
                  onClick={handlePurgeClosed}
                  className="px-3 py-1 rounded text-[10px] font-mono bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                >
                  Purge {health.trades.exited + health.trades.expired} closed/expired from server
                </button>
              )}
              {openTrades.length > 0 && (
                <button
                  onClick={handleForceEvaluate}
                  disabled={evaluating}
                  className="flex items-center gap-1 px-3 py-1 rounded text-[10px] font-mono bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 transition-colors disabled:opacity-50"
                >
                  {evaluating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  Force Evaluate All ({openTrades.length} open)
                </button>
              )}
              {health.trades.total > 0 && (
                confirmNuclear ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-red-400 font-mono">Purge ALL {health.trades.total} trades?</span>
                    <button onClick={() => { handlePurgeAll(); setConfirmNuclear(false); }} className="px-2 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors">Yes, nuke it</button>
                    <button onClick={() => setConfirmNuclear(false)} className="px-2 py-0.5 rounded text-[10px] font-mono text-text-muted hover:text-text-secondary transition-colors">No</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmNuclear(true)}
                    className="px-3 py-1 rounded text-[10px] font-mono text-red-500/60 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                  >
                    Nuclear: Purge ALL
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      )}

      {/* Force Evaluate bar — always visible when there are open trades */}
      {openTrades.length > 0 && (!health || health.issues.length === 0) && (
        <div className="panel border border-accent-cyan/20">
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-mono text-text-secondary">
              <Activity className="w-3.5 h-3.5 text-accent-cyan" />
              <span>{openTrades.length} open trade{openTrades.length !== 1 ? 's' : ''}</span>
              {!isMarketOpen && <span className="text-amber-400/70">— TrackerMonitor dormant</span>}
            </div>
            <button
              onClick={handleForceEvaluate}
              disabled={evaluating}
              className="flex items-center gap-1 px-3 py-1 rounded text-[10px] font-mono bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25 transition-colors disabled:opacity-50"
            >
              {evaluating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Force Evaluate
            </button>
          </div>
        </div>
      )}

      {/* Eval Results */}
      {evalResults && evalResults.results.length > 0 && (
        <EvalResults results={evalResults.results} errors={evalResults.errors} />
      )}

      {/* Top Row: API Status + Trade Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* API Connectivity */}
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Wifi className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title text-xs">API Connectivity</span>
            </div>
          </div>
          <div className="p-3 grid grid-cols-2 gap-2">
            <ApiCard name="Tradier" result={apis?.tradier} icon={Activity} />
            <ApiCard name="Polygon.io" result={apis?.polygon} icon={TrendingUp} />
            <ApiCard name="Claude AI" result={apis?.anthropic} icon={Zap} />
            <ApiCard name="Overall Storage" result={apis?.persistence} icon={Database} />
          </div>
          <div className="px-3 pb-3">
            <div className="text-[9px] font-mono text-text-muted/50 mb-2 uppercase tracking-wider">Storage Backends</div>
            <div className="grid grid-cols-2 gap-2">
              <ApiCard name="Redis (primary)" result={apis?.redis} icon={Server} />
              <ApiCard name="Blob (fallback)" result={apis?.blob} icon={Database} optional={apis?.redis?.available} />
            </div>
            {apis?.redis?.available && !apis?.blob?.available && (
              <div className="mt-2 text-[10px] font-mono text-text-muted/50 flex items-start gap-1.5">
                <CheckCircle2 className="w-3 h-3 text-accent-green/50 mt-0.5 shrink-0" />
                <span>Redis is active — Blob Store is optional and not needed. Data persists via Redis.</span>
              </div>
            )}
            {!apis?.redis?.available && !apis?.blob?.available && (
              <div className="mt-2 text-[10px] font-mono text-accent-red/80 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>No storage backend connected. Trade data is only in localStorage and will not survive browser clears.</span>
              </div>
            )}
          </div>
        </div>

        {/* Trade Stats */}
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title text-xs">Tracked Trades</span>
            </div>
            <span className="text-[10px] font-mono text-text-muted">{health?.trades.total ?? 0} total</span>
          </div>
          {health && (
            <div className="p-3">
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="text-center">
                  <div className="text-lg font-mono font-bold text-accent-cyan">{health.trades.open}</div>
                  <div className="text-[10px] font-mono text-text-muted">Open</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-mono font-bold text-accent-green">{health.trades.exited}</div>
                  <div className="text-[10px] font-mono text-text-muted">Exited</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-mono font-bold text-text-muted">{health.trades.expired}</div>
                  <div className="text-[10px] font-mono text-text-muted">Expired</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="flex justify-between px-2 py-1 bg-bg-tertiary/30 rounded">
                  <span className="text-text-muted">Pending</span>
                  <span className={`${health.trades.pending > 0 ? 'text-blue-400' : 'text-text-muted'}`}>{health.trades.pending}</span>
                </div>
                <div className="flex justify-between px-2 py-1 bg-bg-tertiary/30 rounded">
                  <span className="text-text-muted">Entered</span>
                  <span className={`${health.trades.entered > 0 ? 'text-accent-cyan' : 'text-text-muted'}`}>{health.trades.entered}</span>
                </div>
                <div className="flex justify-between px-2 py-1 bg-bg-tertiary/30 rounded">
                  <span className="text-text-muted">Unpriced</span>
                  <span className={`${health.trades.unpriced > 0 ? 'text-accent-amber' : 'text-accent-green'}`}>{health.trades.unpriced}</span>
                </div>
                <div className="flex justify-between px-2 py-1 bg-bg-tertiary/30 rounded">
                  <span className="text-text-muted">Expired (open)</span>
                  <span className={`${health.trades.expiredNotClosed > 0 ? 'text-accent-red' : 'text-accent-green'}`}>{health.trades.expiredNotClosed}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Data Quality Issues */}
      {qualityIssues.length > 0 && (
        <div className="panel border border-amber-500/20">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Bug className="w-3.5 h-3.5 text-accent-amber" />
              <span className="panel-title text-xs">Trade Data Quality Issues</span>
              <span className="text-[10px] font-mono text-accent-amber">{qualityIssues.length} trades affected</span>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {qualityIssues.map(issue => (
              <QualityIssueRow key={issue.tradeId} issue={issue} />
            ))}
          </div>
        </div>
      )}

      {/* Open Trades with Actions */}
      {openTrades.length > 0 && (
        <div className="panel border border-accent-cyan/20">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title text-xs">Open Trades</span>
              <span className="text-[10px] font-mono text-accent-cyan">{openTrades.length} active</span>
            </div>
            <div className="text-[9px] font-mono text-text-muted/50">hover to close</div>
          </div>
          <div className="divide-y divide-border/10 max-h-64 overflow-y-auto">
            {/* Header */}
            <div className="px-3 py-1.5 flex items-center gap-3 text-[9px] font-mono text-text-muted/50 uppercase tracking-wider">
              <span className="w-2 shrink-0" />
              <span className="w-12">Sym</span>
              <span className="flex-1">Strategy</span>
              <span className="shrink-0">Status</span>
              <span className="shrink-0 w-16 text-right">P/L</span>
              <span className="shrink-0 w-16 text-right">DTE</span>
              <span className="shrink-0 w-24" />
            </div>
            {openTrades.map(t => (
              <TradeRow key={t.id} trade={t} onForceClose={handleForceClose} closingId={closingTradeId} />
            ))}
          </div>
        </div>
      )}

      {/* Error Log */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-accent-cyan" />
            <span className="panel-title text-xs">Error Log</span>
            <span className="text-[10px] font-mono text-text-muted">{errors.length} entries</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-bg-secondary rounded p-0.5 border border-border/30">
              {['all', 'info', 'warn', 'error', 'critical'].map(sev => (
                <button
                  key={sev}
                  onClick={() => setErrorFilter(sev)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${
                    errorFilter === sev
                      ? sev === 'all' ? 'bg-accent-cyan/15 text-accent-cyan' : severityColor[sev] || 'text-text-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {sev === 'all' ? 'All' : sev.charAt(0).toUpperCase() + sev.slice(1)}
                  {sev !== 'all' && health?.errors.bySeverity[sev] ? ` (${health.errors.bySeverity[sev]})` : ''}
                </button>
              ))}
            </div>
            {errors.length > 0 && (
              <button
                onClick={handleClearErrors}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-mono text-text-muted/60 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-2.5 h-2.5" /> Clear
              </button>
            )}
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {filteredErrors.length > 0 ? (
            filteredErrors.map(entry => <ErrorRow key={entry.id} entry={entry} />)
          ) : (
            <div className="px-4 py-8 text-center">
              <CheckCircle2 className="w-8 h-8 text-accent-green/30 mx-auto mb-2" />
              <div className="text-sm font-mono text-text-muted">No errors logged</div>
              <div className="text-[10px] font-mono text-text-muted/50 mt-1">
                Errors from TrackerMonitor, API routes, and providers will appear here
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Error Sources Breakdown */}
      {health && Object.keys(health.errors.bySource).length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Server className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title text-xs">Errors by Source</span>
            </div>
          </div>
          <div className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {Object.entries(health.errors.bySource).sort((a, b) => b[1] - a[1]).map(([source, count]) => (
              <div key={source} className="flex items-center justify-between px-3 py-2 bg-bg-tertiary/30 rounded">
                <span className="text-xs font-mono text-text-secondary">{source}</span>
                <span className={`text-xs font-mono font-semibold ${count > 10 ? 'text-accent-red' : count > 3 ? 'text-accent-amber' : 'text-text-muted'}`}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recently Closed Trades */}
      {closedTrades.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title text-xs">Closed Trades</span>
              <span className="text-[10px] font-mono text-text-muted">{closedTrades.length} trades</span>
            </div>
          </div>
          <div className="divide-y divide-border/10 max-h-48 overflow-y-auto">
            {closedTrades.slice(0, 20).map(t => (
              <div key={t.id} className="px-3 py-2 flex items-center gap-3 text-xs font-mono">
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  t.outcome === 'win' ? 'bg-accent-green' : t.outcome === 'loss' ? 'bg-accent-red' : 'bg-text-muted'
                }`} />
                <span className="font-semibold text-text-primary w-12">{t.symbol}</span>
                <span className="text-text-muted truncate flex-1">{t.strategy}</span>
                <span className={`shrink-0 text-[10px] ${t.status === 'expired' ? 'text-amber-400' : 'text-text-muted'}`}>{t.status}</span>
                {t.realizedPL !== null ? (
                  <span className={`shrink-0 ${t.realizedPL >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {t.realizedPL >= 0 ? '+' : ''}${t.realizedPL.toFixed(0)}
                    {t.realizedPLPct !== null && <span className="text-text-muted/50 ml-1">({t.realizedPLPct.toFixed(0)}%)</span>}
                  </span>
                ) : (
                  <span className="shrink-0 text-text-muted/30">—</span>
                )}
                <span className="text-text-muted/50 shrink-0">{t.expirationDate}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-center text-[10px] font-mono text-text-muted/40 py-2">
        MCP server connected via .mcp.json — Claude Code has full diagnostic access during sessions
      </div>
    </div>
  );
}
