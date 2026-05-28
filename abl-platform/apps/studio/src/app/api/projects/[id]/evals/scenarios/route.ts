/**
 * GET  /api/projects/:id/evals/scenarios - List scenarios for a project
 * POST /api/projects/:id/evals/scenarios - Create a scenario
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findScenariosPageByProject, createScenario } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { parseEvalListQuery } from '@/lib/eval-list-query';
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_DESCRIPTION_MAX_LENGTH,
  EVAL_CATEGORY_MAX_LENGTH,
  EVAL_AGENT_NAME_MAX_LENGTH,
  EVAL_LONG_TEXT_MAX_LENGTH,
  EVAL_MAX_TURNS_MIN,
  EVAL_MAX_TURNS_MAX,
  EVAL_DEFAULT_MAX_TURNS,
  EVAL_TAG_MAX_LENGTH,
  EVAL_MILESTONE_MAX_LENGTH,
} from '@agent-platform/database/constants/eval-limits';

const createSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  category: z.string().max(EVAL_CATEGORY_MAX_LENGTH).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  entryAgent: z.string().max(EVAL_AGENT_NAME_MAX_LENGTH).optional(),
  initialMessage: z.string().max(EVAL_LONG_TEXT_MAX_LENGTH).optional(),
  expectedOutcome: z.string().max(EVAL_LONG_TEXT_MAX_LENGTH).optional(),
  maxTurns: z
    .number()
    .int()
    .min(EVAL_MAX_TURNS_MIN)
    .max(EVAL_MAX_TURNS_MAX)
    .default(EVAL_DEFAULT_MAX_TURNS),
  tags: z.array(z.string().max(EVAL_TAG_MAX_LENGTH)).default([]),
  agentPath: z.array(z.string().max(EVAL_AGENT_NAME_MAX_LENGTH)).default([]),
  expectedMilestones: z.array(z.string().max(EVAL_MILESTONE_MAX_LENGTH)).default([]),
  maxToolCalls: z.number().int().min(1).optional(),
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
    const result = await findScenariosPageByProject(projectId, user.tenantId, query);
    return NextResponse.json({
      success: true,
      scenarios: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    return handleApiError(error, 'EvalScenarios.list');
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
    const scenario = await createScenario({
      ...result.data,
      tenantId: user.tenantId,
      projectId,
      createdBy: formatUserLabel(user),
    });
    return NextResponse.json({ success: true, scenario }, { status: 201 });
  } catch (error) {
    return handleApiError(error, 'EvalScenarios.create');
  }
}
