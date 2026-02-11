'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  HeartPulse, AlertTriangle, CheckCircle2, XCircle, Wifi, WifiOff,
  Clock, RefreshCw, Trash2, ChevronDown, ChevronUp, Activity,
  Server, Database, Zap, Bug, Shield, TrendingUp,
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
  realizedPL: number | null;
  realizedPLPct: number | null;
  trackedAt: string;
  expirationDate: string;
}

// ─── Helpers ────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
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

// ─── API Status Card ────────────────────────────────────────

function ApiCard({ name, result, icon: Icon }: { name: string; result: ApiResult | undefined; icon: React.ElementType }) {
  if (!result) return null;
  return (
    <div className={`panel px-4 py-3 border ${result.available ? 'border-green-500/20' : 'border-red-500/20'}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Icon className={`w-3.5 h-3.5 ${result.available ? 'text-accent-green' : 'text-accent-red'}`} />
          <span className="text-xs font-mono font-semibold text-text-primary">{name}</span>
        </div>
        {result.available ? (
          <Wifi className="w-3.5 h-3.5 text-accent-green" />
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-accent-red" />
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-mono ${result.available ? 'text-accent-green' : 'text-accent-red'}`}>
          {result.available ? 'Connected' : result.error || 'Unavailable'}
        </span>
        {result.latencyMs !== undefined && (
          <span className={`text-[10px] font-mono ${result.latencyMs < 500 ? 'text-accent-green' : result.latencyMs < 2000 ? 'text-accent-amber' : 'text-accent-red'}`}>
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
    await fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear-errors' }),
    }).catch(() => {});
    setErrors([]);
  };

  const handleClearExpired = async () => {
    await fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear-expired' }),
    }).catch(() => {});
    fetchAll();
  };

  const filteredErrors = errorFilter === 'all'
    ? errors
    : errors.filter(e => e.severity === errorFilter);

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
            {health.trades.expiredNotClosed > 0 && (
              <button
                onClick={handleClearExpired}
                className="mt-2 px-3 py-1 rounded text-[10px] font-mono bg-accent-amber/15 text-accent-amber hover:bg-accent-amber/25 transition-colors"
              >
                Close {health.trades.expiredNotClosed} expired trades
              </button>
            )}
          </div>
        </div>
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
            <ApiCard name="Persistence" result={apis?.persistence} icon={Database} />
          </div>
          {apis && (
            <div className="px-3 pb-2 grid grid-cols-2 gap-2">
              {apis.redis && <ApiCard name="Redis" result={apis.redis} icon={Server} />}
              {apis.blob && <ApiCard name="Blob Store" result={apis.blob} icon={Database} />}
            </div>
          )}
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

      {/* Recent Trades Activity */}
      {trades.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-accent-cyan" />
              <span className="panel-title text-xs">Recent Trade Activity</span>
            </div>
          </div>
          <div className="divide-y divide-border/10 max-h-64 overflow-y-auto">
            {trades.slice(0, 20).map(t => (
              <div key={t.id} className="px-3 py-2 flex items-center gap-3 text-xs font-mono">
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  t.status === 'entered' ? 'bg-accent-cyan' : t.status === 'pending' ? 'bg-blue-400' :
                  t.outcome === 'win' ? 'bg-accent-green' : t.outcome === 'loss' ? 'bg-accent-red' : 'bg-text-muted'
                }`} />
                <span className="font-semibold text-text-primary w-12">{t.symbol}</span>
                <span className="text-text-muted truncate flex-1">{t.strategy}</span>
                <span className={`shrink-0 ${
                  t.status === 'entered' ? 'text-accent-cyan' : t.status === 'pending' ? 'text-blue-400' :
                  'text-text-muted'
                }`}>{t.status}</span>
                {t.realizedPL !== null && (
                  <span className={`shrink-0 ${t.realizedPL >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {t.realizedPL >= 0 ? '+' : ''}${t.realizedPL.toFixed(0)}
                  </span>
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
