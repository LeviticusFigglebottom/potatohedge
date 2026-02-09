/**
 * Bare-minimum diagnostic route — zero lib imports.
 * If this returns 500 HTML, the problem is Vercel/Next.js config, not our code.
 * If this returns JSON, basic routing works and the issue is in specific modules.
 */
export async function GET() {
  return Response.json({
    ok: true,
    timestamp: new Date().toISOString(),
    nodeVersion: typeof process !== 'undefined' ? process.version : 'unknown',
    env: {
      TRADIER_API_KEY: process.env.TRADIER_API_KEY ? 'set' : 'MISSING',
      TRADIER_SANDBOX: process.env.TRADIER_SANDBOX || 'not set',
      POLYGON_API_KEY: process.env.POLYGON_API_KEY ? 'set' : 'MISSING',
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING',
    },
    runtime: typeof globalThis !== 'undefined' && 'EdgeRuntime' in globalThis ? 'edge' : 'nodejs',
    decompressionStream: typeof DecompressionStream !== 'undefined',
    abortSignalTimeout: typeof AbortSignal.timeout === 'function',
  });
}
