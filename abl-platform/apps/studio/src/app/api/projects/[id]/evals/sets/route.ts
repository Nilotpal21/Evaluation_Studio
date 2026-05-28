/**
 * GET  /api/projects/:id/evals/sets - List eval sets for a project
 * POST /api/projects/:id/evals/sets - Create an eval set
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findEvalSetsPageByProject, createEvalSet } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { parseEvalListQuery } from '@/lib/eval-list-query';
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_DESCRIPTION_MAX_LENGTH,
  EVAL_VARIANTS_MIN,
  EVAL_VARIANTS_MAX,
  EVAL_DEFAULT_VARIANTS,
  EVAL_MAX_CONCURRENCY_MIN,
  EVAL_MAX_CONCURRENCY_MAX,
  EVAL_DEFAULT_MAX_CONCURRENCY,
} from '@agent-platform/database/constants/eval-limits';

const createSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  personaIds: z.array(z.string().min(1)).min(1, 'At least one persona is required'),
  scenarioIds: z.array(z.string().min(1)).min(1, 'At least one scenario is required'),
  evaluatorIds: z.array(z.string().min(1)).min(1, 'At least one evaluator is required'),
  variants: z
    .number()
    .int()
    .min(EVAL_VARIANTS_MIN)
    .max(EVAL_VARIANTS_MAX)
    .default(EVAL_DEFAULT_VARIANTS),
  maxConcurrency: z
    .number()
    .int()
    .min(EVAL_MAX_CONCURRENCY_MIN)
    .max(EVAL_MAX_CONCURRENCY_MAX)
    .default(EVAL_DEFAULT_MAX_CONCURRENCY),
  regressionThreshold: z.number().optional(),
  baselineRunId: z.string().optional(),
  ciEnabled: z.boolean().default(false),
  personaModel: z.string().optional(),
  personaModelConfig: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
    })
    .optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const query = parseEvalListQuery(new URL(request.url).searchParams);
    const result = await findEvalSetsPageByProject(projectId, user.tenantId, query);
    return NextResponse.json({
      success: true,
      sets: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    return handleApiError(error, 'EvalSets.list');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = createSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    const evalSet = await createEvalSet({
      ...result.data,
      tenantId: user.tenantId,
      projectId,
      createdBy: formatUserLabel(user),
    });
    return NextResponse.json({ success: true, evalSet }, { status: 201 });
  } catch (error) {
    return handleApiError(error, 'EvalSets.create');
  }
}
