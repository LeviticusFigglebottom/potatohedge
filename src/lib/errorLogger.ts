/**
 * Structured Error Logger for Optix Dashboard
 *
 * Server-side in-memory circular buffer of recent errors/events.
 * Exposed via /api/diagnostics for MCP server consumption.
 *
 * Sources: tracker-monitor, api-route, price-fetch, trade-parse, persistence, client
 */

export type ErrorSeverity = 'info' | 'warn' | 'error' | 'critical';
export type ErrorSource =
  | 'tracker-monitor'
  | 'paper-monitor'
  | 'api-route'
  | 'price-fetch'
  | 'trade-parse'
  | 'persistence'
  | 'polygon'
  | 'tradier'
  | 'claude-ai'
  | 'client'
  | 'unknown';

export interface LogEntry {
  id: string;
  timestamp: number;
  severity: ErrorSeverity;
  source: ErrorSource;
  message: string;
  context?: Record<string, unknown>;
  stack?: string;
}

// ─── In-Memory Circular Buffer ────────────────────────────

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
let idCounter = 0;

export function logError(
  severity: ErrorSeverity,
  source: ErrorSource,
  message: string,
  context?: Record<string, unknown>,
  error?: unknown
): LogEntry {
  const entry: LogEntry = {
    id: `log-${Date.now()}-${++idCounter}`,
    timestamp: Date.now(),
    severity,
    source,
    message,
    context,
    stack: error instanceof Error ? error.stack : undefined,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  return entry;
}

// Convenience wrappers
export const logInfo = (source: ErrorSource, message: string, context?: Record<string, unknown>) =>
  logError('info', source, message, context);

export const logWarn = (source: ErrorSource, message: string, context?: Record<string, unknown>) =>
  logError('warn', source, message, context);

export const logErr = (source: ErrorSource, message: string, context?: Record<string, unknown>, error?: unknown) =>
  logError('error', source, message, context, error);

export const logCritical = (source: ErrorSource, message: string, context?: Record<string, unknown>, error?: unknown) =>
  logError('critical', source, message, context, error);

// ─── Query Functions ──────────────────────────────────────

export function getRecentErrors(opts?: {
  limit?: number;
  severity?: ErrorSeverity;
  source?: ErrorSource;
  since?: number;
}): LogEntry[] {
  let filtered = entries;

  if (opts?.severity) {
    const levels: ErrorSeverity[] = ['info', 'warn', 'error', 'critical'];
    const minLevel = levels.indexOf(opts.severity);
    filtered = filtered.filter(e => levels.indexOf(e.severity) >= minLevel);
  }

  if (opts?.source) {
    filtered = filtered.filter(e => e.source === opts.source);
  }

  if (opts?.since) {
    const sinceTs = opts.since;
    filtered = filtered.filter(e => e.timestamp >= sinceTs);
  }

  const limit = opts?.limit ?? 50;
  return filtered.slice(-limit).reverse(); // newest first
}

export function getErrorSummary(): {
  total: number;
  bySeverity: Record<ErrorSeverity, number>;
  bySource: Record<string, number>;
  recentCritical: LogEntry[];
  lastError: LogEntry | null;
} {
  const bySeverity: Record<ErrorSeverity, number> = { info: 0, warn: 0, error: 0, critical: 0 };
  const bySource: Record<string, number> = {};

  for (const e of entries) {
    bySeverity[e.severity]++;
    bySource[e.source] = (bySource[e.source] || 0) + 1;
  }

  const recentCritical = entries
    .filter(e => e.severity === 'critical' && e.timestamp > Date.now() - 3600000) // last hour
    .slice(-10)
    .reverse();

  return {
    total: entries.length,
    bySeverity,
    bySource,
    recentCritical,
    lastError: entries.length > 0 ? entries[entries.length - 1] : null,
  };
}

export function clearErrors(): void {
  entries.length = 0;
}
