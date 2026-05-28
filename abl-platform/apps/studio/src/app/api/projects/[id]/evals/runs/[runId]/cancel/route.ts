/**
 * POST /api/projects/:id/evals/runs/:runId/cancel
 *
 * Cancel a running eval run. Only runs with status 'pending' or 'running'
 * can be cancelled. Uses atomic findOneAndUpdate with status precondition
 * to avoid TOCTOU race and bypass stripProtected (which drops status).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { ensureDb } from '@/lib/ensure-db';
import { handleApiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string; runId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    await ensureDb();
    const { EvalRun } = await import('@agent-platform/database/models');

    // Atomic cancel: precondition on cancellable status avoids TOCTOU race
    const doc = await EvalRun.findOneAndUpdate(
      {
        _id: runId,
        tenantId: user.tenantId,
        projectId,
        status: { $in: ['pending', 'running'] },
      },
      { $set: { status: 'cancelled', completedAt: new Date() }, $inc: { _v: 1 } },
      { new: true },
    ).lean();

    if (!doc) {
      // Distinguish "not found" from "not cancellable"
      const existing = await EvalRun.findOne({ _id: runId, tenantId: user.tenantId, projectId })
        .select('status')
        .lean();

      if (!existing) {
        return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
      }

      return NextResponse.json(
        {
          success: false,
          error: `Cannot cancel run with status '${existing.status}'. Only pending or running runs can be cancelled.`,
        },
        { status: 409 },
      );
    }

    const { _id, ...rest } = doc as Record<string, unknown>;
    return NextResponse.json({ success: true, run: { ...rest, id: _id } });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.cancel');
  }
}
