import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/entropy/cron/trigger — Dispatch the entropy-cron GitHub Actions workflow.
 *
 * Requires GITHUB_TOKEN env var with fine-grained permissions:
 *   - Actions: Read and write
 *   - Contents: Read (required to read workflow file for dispatch)
 *   - Metadata: Read (usually auto-granted)
 */
export async function POST() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json({
      success: false,
      error: 'GITHUB_TOKEN not configured',
      help: 'Add a GitHub Personal Access Token to your Vercel env vars. Fine-grained token needs: Actions (Read+Write), Contents (Read), Metadata (Read).',
    }, { status: 400 });
  }

  const repo = process.env.GITHUB_REPOSITORY || 'LeviticusFigglebottom/potatohedge';
  const workflowFile = 'entropy-cron.yml';
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'potatohedge-entropy-trigger',
  };

  try {
    // Step 1: Detect default branch from GitHub API
    let defaultBranch = 'main';
    try {
      const repoRes = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: ghHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (repoRes.ok) {
        const repoData = await repoRes.json();
        defaultBranch = repoData.default_branch || 'main';
      } else {
        const body = await repoRes.text();
        return NextResponse.json({
          success: false,
          error: `Cannot access repo (HTTP ${repoRes.status})`,
          detail: body,
          help: repoRes.status === 404
            ? 'Token likely missing permissions. Fine-grained tokens need: Actions (Read+Write), Contents (Read), Metadata (Read) on the repo.'
            : `GitHub returned ${repoRes.status}. Check token permissions.`,
        }, { status: repoRes.status });
      }
    } catch {
      // Fall through with default 'main'
    }

    // Step 2: Dispatch the workflow
    const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: ghHeaders,
      body: JSON.stringify({ ref: defaultBranch }),
    });

    if (res.status === 204) {
      return NextResponse.json({
        success: true,
        message: `Workflow dispatched on ${defaultBranch}. It will call /api/entropy/cron in ~10-30 seconds.`,
      });
    }

    // Error — include full detail for debugging
    const body = await res.text();
    let help = '';
    if (res.status === 404) {
      help = 'Either the workflow file doesn\'t exist on the default branch, or the token is missing Contents:Read permission. Fine-grained tokens need: Actions (Read+Write), Contents (Read), Metadata (Read).';
    } else if (res.status === 422) {
      help = `Workflow file "${workflowFile}" may not exist on branch "${defaultBranch}", or it lacks a workflow_dispatch trigger.`;
    }

    return NextResponse.json({
      success: false,
      error: `GitHub API returned ${res.status}`,
      detail: body,
      help,
      debug: { repo, workflowFile, ref: defaultBranch, url: dispatchUrl },
    }, { status: res.status >= 500 ? 502 : 400 });
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
      : 'Set GITHUB_TOKEN env var. Fine-grained token needs: Actions (Read+Write), Contents (Read), Metadata (Read) on the repo.',
  });
}
