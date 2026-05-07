// Stub for the dashboard's in-memory error buffer. The worker has its own
// JSON logger (../log.ts) and doesn't expose a diagnostics endpoint, so we
// just route the calls into the structured logger.
//
// Signatures match the positional form used in the dashboard's providers:
//   logErr(source, message, context?, error?)
//   logWarn(source, message, context?)

import { log } from '../log.js';

function shape(context?: Record<string, unknown>, error?: unknown) {
  const err = error as Error | undefined;
  return {
    ...(context ?? {}),
    ...(err ? { error: err.message } : {}),
  };
}

export function logErr(
  source: string,
  message: string,
  context?: Record<string, unknown>,
  error?: unknown,
): void {
  log.error(`[${source}] ${message}`, shape(context, error));
}

export function logWarn(
  source: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  log.warn(`[${source}] ${message}`, shape(context));
}

export function logInfo(
  source: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  log.info(`[${source}] ${message}`, shape(context));
}
