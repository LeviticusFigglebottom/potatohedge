import { NextResponse } from 'next/server';

/**
 * Diagnostic health-check endpoint.
 * Tests that all provider modules can be loaded and returns environment info.
 * Hit /api/health to diagnose 500 errors on other routes.
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  // Test dtcc provider import
  try {
    const dtcc = await import('@/lib/providers/dtcc');
    checks.dtcc = { ok: typeof dtcc.fetchSwapData === 'function' };
  } catch (err) {
    checks.dtcc = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err) };
  }

  // Test finra provider import
  try {
    const finra = await import('@/lib/providers/finra');
    checks.finra = { ok: typeof finra.fetchRegSHOThreshold === 'function' };
  } catch (err) {
    checks.finra = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err) };
  }

  // Test tradier provider import
  try {
    const tradier = await import('@/lib/providers/tradier');
    checks.tradier = { ok: typeof tradier.getQuote === 'function' };
  } catch (err) {
    checks.tradier = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err) };
  }

  // Test equityBars provider import
  try {
    const bars = await import('@/lib/providers/equityBars');
    checks.equityBars = { ok: typeof bars.fetchEquityBars === 'function' };
  } catch (err) {
    checks.equityBars = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err) };
  }

  // Test math modules
  try {
    const bs = await import('@/lib/math/blackScholes');
    checks.blackScholes = { ok: typeof bs.computeDealerExposureFromChain === 'function' };
  } catch (err) {
    checks.blackScholes = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err) };
  }

  try {
    const analytics = await import('@/lib/math/analytics');
    checks.analytics = { ok: typeof analytics.computeHistoricalVolatility === 'function' };
  } catch (err) {
    checks.analytics = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err) };
  }

  try {
    const rec = await import('@/lib/math/recommendations');
    checks.recommendations = { ok: typeof rec.generateRecommendations === 'function' };
  } catch (err) {
    checks.recommendations = { ok: false, error: err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err) };
  }

  // Test zlib availability
  try {
    const zlib = await import('zlib');
    checks.zlib = { ok: typeof zlib.inflateRawSync === 'function' };
  } catch {
    checks.zlib = { ok: false, error: 'zlib not available (expected in edge runtime)' };
  }

  // Check DecompressionStream availability
  checks.decompressionStream = {
    ok: typeof DecompressionStream !== 'undefined',
    error: typeof DecompressionStream === 'undefined' ? 'DecompressionStream not available' : undefined,
  };

  const allOk = Object.values(checks).every(c => c.ok);

  return NextResponse.json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    runtime: typeof globalThis !== 'undefined' && 'EdgeRuntime' in globalThis ? 'edge' : 'nodejs',
    nodeVersion: typeof process !== 'undefined' ? process.version : 'N/A',
    checks,
  }, { status: allOk ? 200 : 503 });
}
