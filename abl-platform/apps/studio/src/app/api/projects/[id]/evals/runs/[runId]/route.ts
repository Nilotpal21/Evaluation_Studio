/**
 * GET   /api/projects/:id/evals/runs/:runId - Get an eval run
 * PATCH /api/projects/:id/evals/runs/:runId - Update an eval run (status and notes only)
 *
 * Runs are immutable records — DELETE is intentionally not supported.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findRunById, updateRun } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { EVAL_NOTES_MAX_LENGTH } from '@agent-platform/database/constants/eval-limits';

const updateSchema = z.object({
  notes: z.string().max(EVAL_NOTES_MAX_LENGTH).optional(),
});

type RouteParams = { params: Promise<{ id: string; runId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const run = await findRunById(runId, user.tenantId, projectId);
    if (!run) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, run });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.get');
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = updateSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    const run = await updateRun(runId, user.tenantId, projectId, result.data);
    if (!run) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, run });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.update');
  }
}
