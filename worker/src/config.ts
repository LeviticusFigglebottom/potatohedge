import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  ALPACA_KEY_ID: z.string().min(1),
  ALPACA_SECRET_KEY: z.string().min(1),
  ALPACA_TRADING_BASE: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_BASE: z.string().url().default('https://data.alpaca.markets'),

  // Briefing data providers (now run inside this worker, not via Vercel).
  TRADIER_API_KEY: z.string().min(1),
  TRADIER_SANDBOX: z.string().optional(),
  POLYGON_API_KEY: z.string().min(1),

  // Optional: HTTP fallback. If set, the worker falls back to fetching the
  // dashboard's /api/ai/briefing instead of computing locally. Useful for
  // dev/debug only — production should leave this unset.
  BRIEFING_URL: z.string().url().optional(),

  TARGET_ALLOC_PCT: z.coerce.number().positive().max(1).default(0.10),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().default(10),
  MAX_PER_DIRECTION: z.coerce.number().int().positive().default(5),
  ASSIGNMENT_CLOSE_DTE: z.coerce.number().int().nonnegative().default(2),
  // Refuse to OPEN any trade where any leg's DTE is below this value.
  // Catches long-only straddles/strangles too short to amortize theta —
  // those slip past ASSIGNMENT_CLOSE_DTE which only checks short legs.
  MIN_OPEN_DTE: z.coerce.number().int().nonnegative().default(5),

  DRY_RUN: z
    .union([z.string(), z.boolean()])
    .default('true')
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() !== 'false')),
  TICK_CRON: z.string().default('0 14-20 * * 1-5'),
  ALERT_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  MARKET_TZ: z.string().default('America/New_York'),
  PORT: z.coerce.number().int().default(8080),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;
export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
