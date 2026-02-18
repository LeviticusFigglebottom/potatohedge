#!/usr/bin/env npx tsx
/**
 * Optix Dashboard MCP Server
 *
 * Provides Claude Code with tools to monitor, debug, and act on the
 * running Optix options analytics dashboard.
 *
 * Tools:
 *   dashboard_health     — Overall system health + data quality issues
 *   list_tracked_trades  — Query tracked trades with filters
 *   inspect_trade        — Deep inspection of a specific trade
 *   trade_analytics      — Strategy/source/direction performance breakdowns
 *   recent_errors        — View structured error log
 *   api_status           — Test external API connectivity (Tradier, Polygon, Claude, persistence)
 *   fix_trade            — Fix a specific trade's data (status, pricing, outcome)
 *   clear_expired        — Close all trades past their expiration date
 *   clear_errors         — Clear the error log
 *   log_client_error     — Log a client-side error for tracking
 *
 * Usage:
 *   npx tsx mcp-server.ts                          # defaults to http://localhost:3000
 *   DASHBOARD_URL=https://my-app.vercel.app npx tsx mcp-server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Note: zod v4 basic schemas (z.string, z.enum, z.record, etc.) are runtime-compatible
// with MCP SDK's schema validation. If type errors occur, use `import { z } from 'zod/v3'`.
import { z } from 'zod';

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const DIAGNOSTICS_SECRET = process.env.DIAGNOSTICS_SECRET || '';
const FETCH_TIMEOUT = 15000;

// ─── Helper: call diagnostics API ──────────────────────────

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (DIAGNOSTICS_SECRET) h['Authorization'] = `Bearer ${DIAGNOSTICS_SECRET}`;
  return h;
}

async function diagGet(check: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${DASHBOARD_URL}/api/diagnostics`);
  url.searchParams.set('check', check);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Diagnostics API error (${check}): ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function diagPost(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${DASHBOARD_URL}/api/diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Diagnostics POST error: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

function formatResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ─── MCP Server Setup ─────────────────────────────────────

const server = new McpServer({
  name: 'optix-dashboard',
  version: '1.0.0',
});

// ── Tool: Dashboard Health ─────────────────────────────────

server.tool(
  'dashboard_health',
  'Get overall dashboard health status including data quality issues, persistence status, trade counts, and recent critical errors',
  {},
  async () => {
    try {
      const data = await diagGet('health');
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: List Tracked Trades ──────────────────────────────

server.tool(
  'list_tracked_trades',
  'List all tracked trades with data quality analysis. Returns trade summaries, statuses, P/L, and any data quality issues detected.',
  {},
  async () => {
    try {
      const data = await diagGet('trades');
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Inspect Trade ────────────────────────────────────

server.tool(
  'inspect_trade',
  'Deep inspection of a specific tracked trade — shows all fields, leg details, pricing consistency checks, and detected issues',
  { trade_id: z.string().describe('The trade ID to inspect (e.g., "track-algorithm-SPY-1707936000000-abc12")') },
  async ({ trade_id }) => {
    try {
      const data = await diagGet('trade', { id: trade_id });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Trade Analytics ──────────────────────────────────

server.tool(
  'trade_analytics',
  'Get detailed strategy performance analytics — win rates, P/L breakdowns by strategy, source (algo/AI), and direction (bullish/bearish/neutral). Includes recommendations for what works best.',
  {},
  async () => {
    try {
      const data = await diagGet('analytics');
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Recent Errors ────────────────────────────────────

server.tool(
  'recent_errors',
  'View recent errors from the dashboard error log. Filter by severity (info/warn/error/critical) and source (tracker-monitor, polygon, tradier, etc.)',
  {
    severity: z.enum(['info', 'warn', 'error', 'critical']).optional().describe('Minimum severity level to show'),
    source: z.string().optional().describe('Filter by error source (e.g., "polygon", "tradier", "tracker-monitor")'),
    limit: z.number().optional().describe('Max number of entries to return (default 50)'),
  },
  async ({ severity, source, limit }) => {
    try {
      const params: Record<string, string> = {};
      if (severity) params.severity = severity;
      if (source) params.source = source;
      if (limit) params.limit = String(limit);
      const data = await diagGet('errors', params);
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: API Status ───────────────────────────────────────

server.tool(
  'api_status',
  'Test connectivity and latency to all external APIs (Tradier, Polygon.io, Anthropic Claude, Redis/Blob persistence)',
  {},
  async () => {
    try {
      const data = await diagGet('apis');
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Fix Trade ────────────────────────────────────────

server.tool(
  'fix_trade',
  'Fix a specific tracked trade by updating its fields. Allowed fields: status, entryDebit, exitValue, maxRisk, outcome, realizedPL, realizedPLPct, exitReason, notes',
  {
    trade_id: z.string().describe('The trade ID to fix'),
    fixes: z.record(z.string(), z.unknown()).describe('Object of field:value pairs to update (e.g., {"status": "expired", "outcome": "loss"})'),
  },
  async ({ trade_id, fixes }) => {
    try {
      const data = await diagPost({ action: 'fix-trade', id: trade_id, fixes });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Clear Expired Trades ─────────────────────────────

server.tool(
  'clear_expired',
  'Close all tracked trades that are past their expiration date but still showing as open/entered',
  {},
  async () => {
    try {
      const data = await diagPost({ action: 'clear-expired' });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Clear Error Log ──────────────────────────────────

server.tool(
  'clear_errors',
  'Clear the in-memory error log',
  {},
  async () => {
    try {
      const data = await diagPost({ action: 'clear-errors' });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Log Client Error ─────────────────────────────────

server.tool(
  'log_client_error',
  'Log an error to the dashboard error tracking system',
  {
    severity: z.enum(['info', 'warn', 'error', 'critical']).describe('Error severity'),
    source: z.string().describe('Error source identifier'),
    message: z.string().describe('Error message'),
    context: z.record(z.string(), z.unknown()).optional().describe('Additional context data'),
  },
  async ({ severity, source, message, context }) => {
    try {
      const data = await diagPost({ action: 'log-error', severity, source, message, context });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Clean Trade Data ────────────────────────────────

server.tool(
  'clean_trades',
  'Run data integrity cleanup on tracked trades — removes invalid entries, fixes zero-price legs, deduplicates, and auto-expires stale trades',
  {},
  async () => {
    try {
      const data = await diagPost({ action: 'clean-trades' });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Force Evaluate All Trades ──────────────────────

server.tool(
  'force_evaluate',
  'Force-evaluate all open trades with live pricing — works outside market hours. Enters pending trades, checks profit targets and stop losses, expires stale trades.',
  {},
  async () => {
    try {
      const data = await diagPost({ action: 'force-evaluate' });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Force Close a Trade ────────────────────────────

server.tool(
  'force_close',
  'Force-close a specific open trade with live pricing. Also closes any associated Tradier paper positions.',
  {
    trade_id: z.string().describe('The trade ID to force-close'),
    reason: z.enum(['manual-close', 'expiration']).optional().describe('Close reason (default: manual-close)'),
  },
  async ({ trade_id, reason }) => {
    try {
      const data = await diagPost({ action: 'force-close', id: trade_id, reason: reason || 'manual-close' });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Purge Closed Trades ────────────────────────────

server.tool(
  'purge_closed',
  'Remove all closed/expired trades from the server, keeping only open (pending/entered) trades',
  {},
  async () => {
    try {
      const data = await diagPost({ action: 'purge-closed' });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ── Tool: Nuclear Reset ──────────────────────────────────

server.tool(
  'nuke_everything',
  'DESTRUCTIVE: Purge ALL tracked trades, clear error log, cancel paper orders, and close paper positions. Use with extreme caution.',
  {},
  async () => {
    try {
      const data = await diagPost({ action: 'nuke-everything' });
      return { content: [{ type: 'text', text: formatResult(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : 'Unknown'}` }], isError: true };
    }
  }
);

// ─── Start Server ──────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server fatal error:', err);
  process.exit(1);
});
