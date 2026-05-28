/**
 * GET    /api/projects/:id/evals/scenarios/:scenarioId - Get a scenario
 * PATCH  /api/projects/:id/evals/scenarios/:scenarioId - Update a scenario
 * DELETE /api/projects/:id/evals/scenarios/:scenarioId - Delete a scenario
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findScenarioById, updateScenario, deleteScenario } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_DESCRIPTION_MAX_LENGTH,
  EVAL_CATEGORY_MAX_LENGTH,
  EVAL_AGENT_NAME_MAX_LENGTH,
  EVAL_LONG_TEXT_MAX_LENGTH,
  EVAL_MAX_TURNS_MIN,
  EVAL_MAX_TURNS_MAX,
  EVAL_TAG_MAX_LENGTH,
  EVAL_MILESTONE_MAX_LENGTH,
} from '@agent-platform/database/constants/eval-limits';

const updateSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH).optional(),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  category: z.string().max(EVAL_CATEGORY_MAX_LENGTH).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  entryAgent: z.string().max(EVAL_AGENT_NAME_MAX_LENGTH).nullable().optional(),
  initialMessage: z.string().max(EVAL_LONG_TEXT_MAX_LENGTH).nullable().optional(),
  expectedOutcome: z.string().max(EVAL_LONG_TEXT_MAX_LENGTH).nullable().optional(),
  maxTurns: z.number().int().min(EVAL_MAX_TURNS_MIN).max(EVAL_MAX_TURNS_MAX).optional(),
  tags: z.array(z.string().max(EVAL_TAG_MAX_LENGTH)).optional(),
  agentPath: z.array(z.string().max(EVAL_AGENT_NAME_MAX_LENGTH)).optional(),
  expectedMilestones: z.array(z.string().max(EVAL_MILESTONE_MAX_LENGTH)).optional(),
  maxToolCalls: z.number().int().min(1).nullable().optional(),
});

type RouteParams = { params: Promise<{ id: string; scenarioId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, scenarioId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const scenario = await findScenarioById(scenarioId, user.tenantId, projectId);
    if (!scenario) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, scenario });
  } catch (error) {
    return handleApiError(error, 'EvalScenarios.get');
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, scenarioId } = await params;
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
    const scenario = await updateScenario(scenarioId, user.tenantId, projectId, result.data);
    if (!scenario) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, scenario });
  } catch (error) {
    return handleApiError(error, 'EvalScenarios.update');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, scenarioId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const deleted = await deleteScenario(scenarioId, user.tenantId, projectId);
    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, deleted: scenarioId });
  } catch (error) {
    return handleApiError(error, 'EvalScenarios.delete');
  }
}
