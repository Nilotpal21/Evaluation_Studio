/**
 * GET /api/projects/:id/evals/runs/:runId/status
 *
 * Lightweight status polling endpoint for eval runs. Returns only the
 * status, progress, and timing fields — no full summary or snapshot.
 * Designed for frequent polling from the UI during run execution.
 *
 * Stuck-run recovery: if a run has been in 'running' state longer than
 * STUCK_RUN_TIMEOUT_MS, it is automatically marked 'failed'. This handles
 * the case where the pipeline trigger failed silently or Restate crashed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('eval-runs-status');

/** Max time a run can stay in 'running' or 'pending' before being auto-failed (5 min) */
const STUCK_RUN_TIMEOUT_MS = 5 * 60 * 1000;

type RouteParams = { params: Promise<{ id: string; runId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    await ensureDb();
    const { EvalRun } = await import('@agent-platform/database/models');
    const run = await EvalRun.findOne(
      { _id: runId, tenantId: user.tenantId, projectId },
      'status startedAt completedAt createdAt',
    ).lean(); // Select startedAt (for running), createdAt (for pending), both for stuck detection

    if (!run) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    // Stuck-run recovery: auto-fail runs stuck in 'running' past the timeout
    let status = run.status;
    let completedAt = run.completedAt ?? null;

    // For running runs use startedAt; for pending runs (never started) use createdAt
    const referenceTime =
      status === 'running' && run.startedAt
        ? new Date(run.startedAt as Date).getTime()
        : run.createdAt
          ? new Date(run.createdAt as Date).getTime()
          : null;
    const isStuck =
      (status === 'running' || status === 'pending') &&
      referenceTime !== null &&
      Date.now() - referenceTime > STUCK_RUN_TIMEOUT_MS;

    if (isStuck) {
      log.warn('Auto-failing stuck eval run', {
        runId,
        status,
        referenceTime: new Date(referenceTime!).toISOString(),
        elapsedMs: Date.now() - referenceTime!,
      });
      const now = new Date();
      await EvalRun.findOneAndUpdate(
        { _id: runId, tenantId: user.tenantId, projectId, status: { $in: ['running', 'pending'] } },
        { $set: { status: 'failed', completedAt: now } },
      );
      status = 'failed';
      completedAt = now;
    }

    return NextResponse.json({
      success: true,
      status,
      startedAt: run.startedAt ?? null,
      completedAt,
    });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.status');
  }
}
