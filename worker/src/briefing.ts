import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { log } from './log.js';
import type { NormalizedTrade, NormalizedLeg, Direction, OptionRight, OptionSide } from './types.js';

// ─── Briefing fetcher ──────────────────────────────────────────────────────

// Minimal shape we rely on from /api/ai/briefing. Anything else we just pass
// through. Numeric fields are accepted as either numbers or strings.
const BriefingResponse = z.object({
  analysis: z.string(),
  // Optional — only the local runner returns this. HTTP fallback omits it.
  prompt: z.string().optional(),
  aiTradeIdeas: z
    .array(
      z.object({
        title: z.string().optional(),
        ticker: z.string(),
        direction: z.string().optional(),
        strategy: z.string().optional(),
        strikes: z.string().optional(),
        expiration: z.string().optional(),
        entry: z.string().optional(),
        target: z.string().optional(),
        stopMaxLoss: z.string().optional(),
        thesis: z.string().optional(),
        invalidation: z.string().optional(),
        spot: z.coerce.number().optional(),
      }),
    )
    .default([]),
});

export type BriefingPayload = z.infer<typeof BriefingResponse>;

export async function fetchBriefing(): Promise<BriefingPayload> {
  const cfg = loadConfig();
  const t0 = Date.now();

  // Default path: compute the briefing locally inside the worker. No Vercel
  // ceiling, no 504s. Only fall back to HTTP if BRIEFING_URL is explicitly
  // set (dev/debug).
  if (!cfg.BRIEFING_URL) {
    const { runBriefing } = await import('./lib/briefing-runner.js');
    const result = await runBriefing();
    const parsed = BriefingResponse.parse(result);
    log.info('briefing computed locally', {
      ms: Date.now() - t0,
      ideaCount: parsed.aiTradeIdeas.length,
      analysisChars: parsed.analysis.length,
    });
    return parsed;
  }

  const res = await fetch(cfg.BRIEFING_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`briefing fetch ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const parsed = BriefingResponse.parse(json);
  log.info('briefing fetched via HTTP', {
    ms: Date.now() - t0,
    ideaCount: parsed.aiTradeIdeas.length,
    analysisChars: parsed.analysis.length,
  });
  return parsed;
}

// ─── Normalizer ────────────────────────────────────────────────────────────

// We use Claude with a strict tool schema to convert the briefing's
// human-readable trade ideas (strikes like "Sell $595P / Buy $590P",
// expiration like "2025-02-21 (7 DTE)") into structured legs we can route.
// Anthropic structured tool-use is far more reliable than regex on prose.

const TradeNormalization = z.object({
  trades: z.array(
    z.object({
      underlying: z.string().regex(/^[A-Z]{1,5}$/),
      direction: z.enum(['bullish', 'bearish', 'neutral']),
      strategy_label: z.string(),
      legs: z
        .array(
          z.object({
            right: z.enum(['call', 'put']),
            strike: z.number().positive(),
            expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            side: z.enum(['long', 'short']),
            ratio: z.number().int().positive().default(1),
          }),
        )
        .min(1)
        .max(4),
      estimated_debit_per_spread: z.number(),
      exit_target_pct: z.number().min(0).max(5).optional(),
      exit_stop_pct: z.number().min(0).max(10).optional(),
      invalidation: z.string().optional(),
      thesis: z.string().optional(),
    }),
  ),
});

const NORMALIZER_TOOL = {
  name: 'submit_normalized_trades',
  description:
    'Convert human-readable options trade ideas into a strict, machine-routable schema.',
  input_schema: {
    type: 'object',
    properties: {
      trades: {
        type: 'array',
        items: {
          type: 'object',
          required: ['underlying', 'direction', 'strategy_label', 'legs', 'estimated_debit_per_spread'],
          properties: {
            underlying: { type: 'string', description: 'Stock ticker, uppercase.' },
            direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
            strategy_label: { type: 'string' },
            legs: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              items: {
                type: 'object',
                required: ['right', 'strike', 'expiration', 'side'],
                properties: {
                  right: { type: 'string', enum: ['call', 'put'] },
                  strike: { type: 'number' },
                  expiration: {
                    type: 'string',
                    description: 'YYYY-MM-DD. Resolve relative phrases like "weekly" or "30 DTE" into a concrete date.',
                  },
                  side: { type: 'string', enum: ['long', 'short'] },
                  ratio: { type: 'integer', minimum: 1, default: 1 },
                },
              },
            },
            estimated_debit_per_spread: {
              type: 'number',
              description:
                'Net cost per 1-spread unit, in dollars per share (× 100 = dollars per contract). Negative for net credit. If unknown, estimate from typical spread economics.',
            },
            exit_target_pct: {
              type: 'number',
              description: 'Profit target as a fraction of max profit, e.g. 0.5 for "50% of max credit".',
            },
            exit_stop_pct: {
              type: 'number',
              description:
                'Stop loss as a fraction of premium paid (debit) or premium collected (credit). e.g. 2.0 means cut at 2× credit collected.',
            },
            invalidation: { type: 'string' },
            thesis: { type: 'string' },
          },
        },
      },
    },
    required: ['trades'],
  },
} as const;

function tradeKey(underlying: string, legs: NormalizedLeg[]): string {
  const sig = legs
    .map((l) => `${l.side[0]}${l.right[0]}${l.strike}@${l.expiration}x${l.ratio}`)
    .sort()
    .join('|');
  return `${underlying}:${sig}`;
}

export async function normalizeTradeIdeas(
  briefing: BriefingPayload,
  todayIso: string,
): Promise<NormalizedTrade[]> {
  if (briefing.aiTradeIdeas.length === 0) return [];
  const cfg = loadConfig();
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });

  const ideasJson = JSON.stringify(briefing.aiTradeIdeas, null, 2);
  const prompt = `You are normalizing options trade ideas for an automated execution system.

Today's date is ${todayIso}.

Input is a JSON array of trade ideas extracted from a market briefing. Each
idea has free-text fields like strikes ("Sell $595P / Buy $590P"), expiration
("2025-02-21 (7 DTE)" or "weekly" or "monthly"), entry, target, etc.

Convert every idea into one entry in the trades array. Rules:
- Resolve every expiration to YYYY-MM-DD using today's date as the anchor.
- Expand multi-leg structures (spreads, condors, straddles, strangles) into
  separate legs with side=long|short.
- direction: classify the structure as bullish, bearish, or neutral.
- estimated_debit_per_spread: dollars per share per spread. POSITIVE = debit
  (you pay to open), NEGATIVE = credit (you collect). Use the briefing's
  entry/credit numbers; if absent, estimate.
- exit_target_pct / exit_stop_pct: extract from the target/stopMaxLoss fields
  as decimal fractions. If "50% of max credit" → 0.5. If absent, omit.
- Skip any idea where strikes or expiration cannot be resolved.

Trade ideas:
\`\`\`json
${ideasJson}
\`\`\`

Call submit_normalized_trades with the converted trades.`;

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    tools: [NORMALIZER_TOOL],
    tool_choice: { type: 'tool', name: 'submit_normalized_trades' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) {
    log.warn('normalizer returned no tool_use block');
    return [];
  }

  const parsed = TradeNormalization.safeParse(toolUse.input);
  if (!parsed.success) {
    log.warn('normalizer output failed validation', { issues: parsed.error.issues });
    return [];
  }

  const out: NormalizedTrade[] = [];
  for (const t of parsed.data.trades) {
    const legs: NormalizedLeg[] = t.legs.map((l) => ({
      underlying: t.underlying,
      right: l.right as OptionRight,
      strike: l.strike,
      expiration: l.expiration,
      side: l.side as OptionSide,
      ratio: l.ratio ?? 1,
    }));
    out.push({
      key: tradeKey(t.underlying, legs),
      underlying: t.underlying,
      direction: t.direction as Direction,
      strategyLabel: t.strategy_label,
      legs,
      estimatedDebitPerSpread: t.estimated_debit_per_spread,
      exitTargetPct: t.exit_target_pct,
      exitStopPct: t.exit_stop_pct,
      invalidation: t.invalidation,
      thesis: t.thesis,
      rawIdea: t,
    });
  }
  log.info('normalized trades', { count: out.length });
  return out;
}
