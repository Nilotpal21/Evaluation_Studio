/**
 * GET    /api/projects/:id/evals/sets/:setId - Get an eval set
 * PATCH  /api/projects/:id/evals/sets/:setId - Update an eval set
 * DELETE /api/projects/:id/evals/sets/:setId - Delete an eval set
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findEvalSetById, updateEvalSet, deleteEvalSet } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_DESCRIPTION_MAX_LENGTH,
  EVAL_VARIANTS_MIN,
  EVAL_VARIANTS_MAX,
  EVAL_MAX_CONCURRENCY_MIN,
  EVAL_MAX_CONCURRENCY_MAX,
} from '@agent-platform/database/constants/eval-limits';

const updateSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH).optional(),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  personaIds: z.array(z.string()).optional(),
  scenarioIds: z.array(z.string()).optional(),
  evaluatorIds: z.array(z.string()).optional(),
  variants: z.number().int().min(EVAL_VARIANTS_MIN).max(EVAL_VARIANTS_MAX).optional(),
  maxConcurrency: z
    .number()
    .int()
    .min(EVAL_MAX_CONCURRENCY_MIN)
    .max(EVAL_MAX_CONCURRENCY_MAX)
    .optional(),
  regressionThreshold: z.number().nullable().optional(),
  baselineRunId: z.string().nullable().optional(),
  ciEnabled: z.boolean().optional(),
  personaModel: z.string().nullable().optional(),
  personaModelConfig: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
    })
    .nullable()
    .optional(),
});

type RouteParams = { params: Promise<{ id: string; setId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, setId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const evalSet = await findEvalSetById(setId, user.tenantId, projectId);
    if (!evalSet) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, evalSet });
  } catch (error) {
    return handleApiError(error, 'EvalSets.get');
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, setId } = await params;
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
    const evalSet = await updateEvalSet(setId, user.tenantId, projectId, result.data);
    if (!evalSet) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, evalSet });
  } catch (error) {
    return handleApiError(error, 'EvalSets.update');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, setId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const deleted = await deleteEvalSet(setId, user.tenantId, projectId);
    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, deleted: setId });
  } catch (error) {
    return handleApiError(error, 'EvalSets.delete');
  }
}
