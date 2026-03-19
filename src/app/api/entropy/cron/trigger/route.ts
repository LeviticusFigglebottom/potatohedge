import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/entropy/cron/trigger — Dispatch the entropy-cron GitHub Actions workflow.
 *
 * Requires GITHUB_TOKEN env var with `actions:write` scope.
 * This triggers a real end-to-end cron run via GitHub Actions → /api/entropy/cron.
 */
export async function POST() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json({
      success: false,
      error: 'GITHUB_TOKEN not configured',
      help: 'Add a GitHub Personal Access Token with actions:write scope to your Vercel env vars.',
    }, { status: 400 });
  }

  // Detect repo from env or use default
  const repo = process.env.GITHUB_REPOSITORY || 'LeviticusFigglebottom/potatohedge';
  const workflowFile = 'entropy-cron.yml';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      },
    );

    if (res.status === 204) {
      // 204 = accepted, workflow dispatched
      return NextResponse.json({
        success: true,
        message: 'GitHub Actions workflow dispatched. It will call /api/entropy/cron in ~10-30 seconds.',
      });
    }

    // Error from GitHub
    const body = await res.text();
    return NextResponse.json({
      success: false,
      error: `GitHub API returned ${res.status}`,
      detail: body,
    }, { status: res.status });
  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : 'Network error',
    }, { status: 500 });
  }
}

/**
 * GET /api/entropy/cron/trigger — Check if GitHub Actions trigger is available.
 */
export async function GET() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY || 'LeviticusFigglebottom/potatohedge';

  return NextResponse.json({
    available: hasToken,
    repo,
    workflow: 'entropy-cron.yml',
    help: hasToken
      ? 'Ready to dispatch. POST to this endpoint to trigger.'
      : 'Set GITHUB_TOKEN env var with actions:write scope to enable.',
  });
}
