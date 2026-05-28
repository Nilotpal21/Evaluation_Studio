/**
 * GET    /api/projects/:id/evals/evaluators/:evaluatorId - Get an evaluator
 * PATCH  /api/projects/:id/evals/evaluators/:evaluatorId - Update an evaluator
 * DELETE /api/projects/:id/evals/evaluators/:evaluatorId - Delete an evaluator
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findEvaluatorById, updateEvaluator, deleteEvaluator } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_DESCRIPTION_MAX_LENGTH,
  EVAL_JUDGE_PROMPT_MAX_LENGTH,
  EVAL_TEMPERATURE_MIN,
  EVAL_TEMPERATURE_MAX,
} from '@agent-platform/database/constants/eval-limits';

const updateSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH).optional(),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  type: z.enum(['llm_judge', 'code_scorer', 'trajectory', 'human_review']).optional(),
  category: z
    .enum(['quality', 'safety', 'efficiency', 'empathy', 'tool_correctness', 'custom'])
    .optional(),
  judgeModel: z.string().nullable().optional(),
  judgePrompt: z.string().max(EVAL_JUDGE_PROMPT_MAX_LENGTH).nullable().optional(),
  chainOfThought: z.boolean().optional(),
  temperature: z.number().min(EVAL_TEMPERATURE_MIN).max(EVAL_TEMPERATURE_MAX).optional(),
  scoringRubric: z
    .object({
      scaleType: z.enum(['1-5', 'pass-fail']),
      points: z.array(
        z.object({
          value: z.number(),
          label: z.string(),
          criteria: z.string(),
          examples: z.array(z.string()).optional(),
        }),
      ),
    })
    .nullable()
    .optional(),
  biasSettings: z
    .object({
      positionSwapEnabled: z.boolean().default(true),
      blindEvaluation: z.boolean().default(true),
      crossModelJudge: z.boolean().default(false),
      evidenceFirstMode: z.boolean().default(true),
    })
    .nullable()
    .optional(),
  scorerName: z.string().nullable().optional(),
  scorerConfig: z.record(z.unknown()).nullable().optional(),
  trajectoryMetrics: z
    .array(
      z.enum(['milestone_completion', 'handoff_correctness', 'path_efficiency', 'tool_sequence']),
    )
    .optional(),
  humanReviewThreshold: z.number().nullable().optional(),
});

type RouteParams = { params: Promise<{ id: string; evaluatorId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, evaluatorId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const evaluator = await findEvaluatorById(evaluatorId, user.tenantId, projectId);
    if (!evaluator) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, evaluator });
  } catch (error) {
    return handleApiError(error, 'EvalEvaluators.get');
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, evaluatorId } = await params;
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
    const evaluator = await updateEvaluator(evaluatorId, user.tenantId, projectId, result.data);
    if (!evaluator) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, evaluator });
  } catch (error) {
    return handleApiError(error, 'EvalEvaluators.update');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, evaluatorId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const deleted = await deleteEvaluator(evaluatorId, user.tenantId, projectId);
    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, deleted: evaluatorId });
  } catch (error) {
    return handleApiError(error, 'EvalEvaluators.delete');
  }
}
