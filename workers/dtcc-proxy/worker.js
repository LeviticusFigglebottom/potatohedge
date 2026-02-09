/**
 * Cloudflare Worker — DTCC S3 Proxy
 *
 * Proxies requests to the DTCC S3 bucket which blocks cloud/serverless IPs.
 * Cloudflare Workers run on edge IPs that are not in the blocked ranges.
 *
 * Deploy: npx wrangler deploy (from this directory)
 * Set DTCC_PROXY_URL env var in Vercel to the deployed worker URL.
 *
 * Usage: GET /?date=2026-02-07
 *   Returns the DTCC cumulative equity swap ZIP file for the given date.
 *   If no date param, uses today's date.
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const s3Date = date.replace(/-/g, '_');

    const urls = [
      `https://kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_EQUITY_${s3Date}.zip`,
      `https://kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_EQUITIES_${s3Date}.zip`,
    ];

    for (const s3Url of urls) {
      try {
        const res = await fetch(s3Url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
          },
        });

        if (!res.ok) continue;

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('html') || contentType.includes('text/plain')) {
          const text = await res.text();
          if (text.includes('host_not_allowed') || text.includes('<html')) continue;
        }

        // Stream the ZIP response back with CORS headers
        return new Response(res.body, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
            'X-DTCC-Date': date,
            'X-DTCC-Source': s3Url.split('/').pop(),
          },
        });
      } catch {
        continue;
      }
    }

    return new Response(JSON.stringify({ error: 'No DTCC data found', date }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};
