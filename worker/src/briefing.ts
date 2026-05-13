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
            // Accept any string starting with YYYY-MM-DD and trim the rest
            // (Claude sometimes adds " (7 DTE)" or trailing whitespace).
            expiration: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}/, 'must start with YYYY-MM-DD')
              .transform((s) => s.slice(0, 10)),
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
          required: [
            'underlying',
            'direction',
            'strategy_label',
            'legs',
            'estimated_debit_per_spread',
            'exit_target_pct',
            'exit_stop_pct',
          ],
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
                    description:
                      'EXACT format: YYYY-MM-DD as a literal date string. NO trailing text, NO parenthetical (NOT "2026-05-15 (7 DTE)"), NO field names (NOT "monthlyExp"). The VALUE you copy must be the actual date string from the idea\'s nearestExp, weeklyExp, or monthlyExp field — pick whichever matches the strategy: monthlyExp for 30-45 DTE setups, weeklyExp for 5-10 DTE, nearestExp for 0-2 DTE. Example output: "2026-05-15".',
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
              description:
                'REQUIRED. Profit target as a positive decimal fraction. For debit spreads = fraction of debit gained (e.g. 0.5 = "close at 50% gain"). For credit spreads = fraction of credit captured (e.g. 0.5 = "close after capturing 50% of the credit"). Default to 0.5 if the idea doesn\'t specify.',
            },
            exit_stop_pct: {
              type: 'number',
              description:
                'REQUIRED. Stop loss as a positive decimal fraction. For debit spreads = fraction of debit lost (e.g. 0.5 = "close at 50% loss"). For credit spreads = ratio of cost-to-close to credit (e.g. 1.0 = "close when paying back the full credit"). Default to 0.5 for debit spreads and 1.0 for credit spreads if the idea doesn\'t specify. The system will additionally cap this to the structural max-loss ratio so unreachable stops cannot be set.',
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

Each idea ALSO carries three pre-computed valid expirations for that ticker:
- nearestExp  (typically 0-3 DTE, the next available expiration)
- weeklyExp   (typically 5-10 DTE)
- monthlyExp  (typically 25-50 DTE — the standard monthly)

CRITICAL EXPIRATION RULE: the "expiration" field on every leg you emit MUST
be exactly one of those three values from the same idea. Do not invent a
date. Do not pick a date because it sounds right. If the idea says "30-45
DTE", use monthlyExp verbatim. If "weekly" or "7 DTE", use weeklyExp. If
"0DTE" or "today", use nearestExp. If none of the three fields is suitable
for the strategy, skip the idea entirely.

Convert every idea into one entry in the trades array. Rules:
- Resolve every expiration to one of nearestExp/weeklyExp/monthlyExp (above).
- Expand multi-leg structures (spreads, condors, straddles, strangles) into
  separate legs with side=long|short.
- direction: classify the structure as bullish, bearish, or neutral.
- estimated_debit_per_spread: dollars per share per spread. POSITIVE = debit
  (you pay to open), NEGATIVE = credit (you collect). Use the briefing's
  entry/credit numbers; if absent, estimate.
- exit_target_pct / exit_stop_pct: REQUIRED — extract from the target/
  stopMaxLoss fields as decimal fractions. If "50% of max credit" → 0.5.
  If "200% of credit" or "2× credit" → 2.0. If the idea doesn't specify a
  stop, infer a sensible one from the strategy: 0.5 for debit spreads
  (50% loss), 1.0 for credit spreads (lose 1× credit collected). If the
  idea doesn't specify a target, use 0.5 for debits (50% gain) and 0.5
  for credits (50% of credit captured). Never omit either field — the
  automation will refuse to open a trade without both.
- Skip any idea where strikes or expiration cannot be resolved from the
  three valid expirations above.

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

    const candidate: NormalizedTrade = {
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
    };

    // Refuse trades without both exit pcts. The whole automation depends on
    // them — a trade without target and stop becomes an un-managed orphan
    // (see META, IWM, TSLA 5/15 from May 7 batch). Better to skip the
    // opportunity than create another orphan.
    if (
      candidate.exitTargetPct === undefined ||
      candidate.exitStopPct === undefined
    ) {
      log.warn('rejecting trade — missing exit pcts', {
        trade: candidate.key,
        target_pct: candidate.exitTargetPct,
        stop_pct: candidate.exitStopPct,
      });
      continue;
    }

    // Cap stop_pct to the spread's structural max-loss-to-basis ratio.
    // Otherwise Claude can produce e.g. stop_pct=2.33 on a credit spread
    // whose actual max loss is only 1.04× credit — making the stop
    // literally unreachable. Same disease as the QQQ position currently
    // riding without a usable stop.
    const cappedStop = capStopPctToStructure(candidate);
    if (cappedStop !== null && cappedStop < candidate.exitStopPct) {
      log.warn('capping stop_pct to structural max-loss ratio', {
        trade: candidate.key,
        original: candidate.exitStopPct,
        capped: cappedStop,
      });
      candidate.exitStopPct = cappedStop;
    }

    // Structural -EV reject: for debit trades, the total debit paid must
    // not exceed the maximum profit achievable on any single component
    // spread. Otherwise the trade is guaranteed to lose money even in the
    // best-case price outcome at expiration (the TSLA double-debit-spread
    // bug). This is the basic sanity check the system should always pass.
    const maxProfit = computeMaxProfitPerShare(candidate);
    if (
      maxProfit !== null &&
      candidate.estimatedDebitPerSpread > 0 &&
      candidate.estimatedDebitPerSpread > maxProfit
    ) {
      log.warn('rejecting trade — structurally -EV (debit exceeds max payoff)', {
        trade: candidate.key,
        debit: candidate.estimatedDebitPerSpread,
        max_profit_per_share: maxProfit,
      });
      continue;
    }

    out.push(candidate);
  }
  log.info('normalized trades', { count: out.length });
  return out;
}

// Compute the maximum stop_pct that is structurally reachable for this trade.
// Returns null for shapes we can't reason about cleanly (calendars, naked
// shorts, weird custom structures) — caller leaves the value unchanged.
//
// For debit spreads (initialBasis = debit paid):
//   max loss = debit, so max stop_pct = 1.0
// For credit spreads (initialBasis = credit received):
//   max loss = spread_width - credit
//   max stop_pct = (spread_width - credit) / credit
// Maximum profit per share at expiration, conservatively computed across
// every vertical sub-spread in the trade. For composite "best of either
// direction" trades (long call spread + long put spread = inverted iron
// butterfly), the result is the WIDEST single vertical's payoff — because
// at expiration only one side can be ITM. If the trade's debit exceeds
// this, no terminal SPY price produces a profit.
function computeMaxProfitPerShare(trade: NormalizedTrade): number | null {
  // Calendars and unusual structures are excluded; we don't reason about
  // them safely.
  const expirations = new Set(trade.legs.map((l) => l.expiration));
  if (expirations.size > 1) return null;

  const calls = trade.legs.filter((l) => l.right === 'call');
  const puts = trade.legs.filter((l) => l.right === 'put');

  let maxComponentWidth = 0;
  if (calls.length === 2) {
    maxComponentWidth = Math.max(maxComponentWidth, Math.abs(calls[0]!.strike - calls[1]!.strike));
  }
  if (puts.length === 2) {
    maxComponentWidth = Math.max(maxComponentWidth, Math.abs(puts[0]!.strike - puts[1]!.strike));
  }
  if (maxComponentWidth === 0) return null;

  // For a single-direction debit spread: max profit = width - debit.
  // For a composite (call vert + put vert): only one side can reach max
  // at expiration; the other contributes its full debit as a loss. So
  // best-case profit = max_component_width - total_debit. We return
  // max_component_width and let the caller compare against total debit.
  return maxComponentWidth;
}

function capStopPctToStructure(trade: NormalizedTrade): number | null {
  const debit = trade.estimatedDebitPerSpread;
  if (!Number.isFinite(debit) || debit === 0) return null;

  // All legs must share an expiration (no calendars).
  const expirations = new Set(trade.legs.map((l) => l.expiration));
  if (expirations.size > 1) return null;

  if (debit > 0) {
    // Debit. You can't lose more than 100% of what you paid.
    return 1.0;
  }

  // Credit. Find the widest vertical width (calls or puts).
  const credit = -debit;
  const calls = trade.legs.filter((l) => l.right === 'call');
  const puts = trade.legs.filter((l) => l.right === 'put');
  let maxWidth = 0;
  if (calls.length === 2) {
    maxWidth = Math.max(maxWidth, Math.abs(calls[0]!.strike - calls[1]!.strike));
  }
  if (puts.length === 2) {
    maxWidth = Math.max(maxWidth, Math.abs(puts[0]!.strike - puts[1]!.strike));
  }
  if (maxWidth === 0) return null; // not a recognizable defined-risk credit
  const maxLoss = maxWidth - credit;
  if (maxLoss <= 0) return null; // free money or weird (shouldn't happen)
  return maxLoss / credit;
}
