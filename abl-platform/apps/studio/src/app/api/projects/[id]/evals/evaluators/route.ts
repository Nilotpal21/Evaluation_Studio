/**
 * GET  /api/projects/:id/evals/evaluators - List evaluators for a project
 * POST /api/projects/:id/evals/evaluators - Create an evaluator
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findEvaluatorsPageByProject, createEvaluator } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { parseEvalListQuery } from '@/lib/eval-list-query';

const log = createLogger('eval-evaluators');
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_DESCRIPTION_MAX_LENGTH,
  EVAL_JUDGE_PROMPT_MAX_LENGTH,
  EVAL_TEMPERATURE_MIN,
  EVAL_TEMPERATURE_MAX,
  EVAL_DEFAULT_TEMPERATURE,
} from '@agent-platform/database/constants/eval-limits';

const createSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  type: z.enum(['llm_judge', 'code_scorer', 'trajectory', 'human_review']),
  category: z
    .enum(['quality', 'safety', 'efficiency', 'empathy', 'tool_correctness', 'custom'])
    .default('custom'),
  judgeModel: z.string().optional(),
  judgePrompt: z.string().max(EVAL_JUDGE_PROMPT_MAX_LENGTH).optional(),
  chainOfThought: z.boolean().default(true),
  temperature: z
    .number()
    .min(EVAL_TEMPERATURE_MIN)
    .max(EVAL_TEMPERATURE_MAX)
    .default(EVAL_DEFAULT_TEMPERATURE),
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
    .optional(),
  biasSettings: z
    .object({
      positionSwapEnabled: z.boolean().default(true),
      blindEvaluation: z.boolean().default(true),
      crossModelJudge: z.boolean().default(false),
      evidenceFirstMode: z.boolean().default(true),
    })
    .optional(),
  scorerName: z.string().optional(),
  scorerConfig: z.record(z.unknown()).optional(),
  trajectoryMetrics: z
    .array(
      z.enum(['milestone_completion', 'handoff_correctness', 'path_efficiency', 'tool_sequence']),
    )
    .optional(),
  humanReviewThreshold: z.number().optional(),
  templateId: z.string().optional(),
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
    const result = await findEvaluatorsPageByProject(projectId, user.tenantId, query);
    return NextResponse.json({
      success: true,
      evaluators: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    return handleApiError(error, 'EvalEvaluators.list');
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
    const issues = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
      received: i.code === 'invalid_type' ? (i as z.ZodInvalidTypeIssue).received : undefined,
    }));
    log.error('Evaluator create validation failed', { projectId: (await params).id, issues });
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: issues },
      { status: 400 },
    );
  }

  try {
    const evaluator = await createEvaluator({
      ...result.data,
      tenantId: user.tenantId,
      projectId,
      createdBy: formatUserLabel(user),
    });
    return NextResponse.json({ success: true, evaluator }, { status: 201 });
  } catch (error) {
    return handleApiError(error, 'EvalEvaluators.create');
  }
}
