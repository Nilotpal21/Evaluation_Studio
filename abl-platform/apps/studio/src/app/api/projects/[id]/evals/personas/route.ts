/**
 * GET  /api/projects/:id/evals/personas - List personas for a project
 * POST /api/projects/:id/evals/personas - Create a persona
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findPersonasPageByProject, createPersona } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { parseEvalListQuery } from '@/lib/eval-list-query';
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_DESCRIPTION_MAX_LENGTH,
  EVAL_TRAIT_MAX_LENGTH,
  EVAL_BEHAVIOR_TRAITS_MAX_COUNT,
  EVAL_GOALS_MAX_LENGTH,
  EVAL_CONSTRAINTS_MAX_LENGTH,
  EVAL_SYSTEM_PROMPT_MAX_LENGTH,
  EVAL_SESSION_VARIABLES_MAX_BYTES,
} from '@agent-platform/database/constants/eval-limits';

const sessionVariablesSchema = z
  .record(z.unknown())
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <= EVAL_SESSION_VARIABLES_MAX_BYTES,
    `Session variables must be ${EVAL_SESSION_VARIABLES_MAX_BYTES} bytes or smaller`,
  )
  .optional();

const createSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  communicationStyle: z
    .enum(['casual', 'formal', 'technical', 'terse', 'verbose'])
    .default('casual'),
  domainKnowledge: z.enum(['beginner', 'intermediate', 'expert']).default('intermediate'),
  behaviorTraits: z
    .array(z.string().max(EVAL_TRAIT_MAX_LENGTH))
    .max(EVAL_BEHAVIOR_TRAITS_MAX_COUNT)
    .default([]),
  goals: z.string().max(EVAL_GOALS_MAX_LENGTH).default(''),
  constraints: z.string().max(EVAL_CONSTRAINTS_MAX_LENGTH).default(''),
  sessionVariables: sessionVariablesSchema,
  systemPrompt: z.string().max(EVAL_SYSTEM_PROMPT_MAX_LENGTH).optional(),
  source: z.enum(['ai-generated', 'custom', 'template', 'adversarial']).default('custom'),
  templateId: z.string().optional(),
  isAdversarial: z.boolean().default(false),
  adversarialType: z
    .enum(['prompt_injection', 'social_engineering', 'off_topic', 'abusive', 'edge_case'])
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
    const result = await findPersonasPageByProject(projectId, user.tenantId, query);
    return NextResponse.json({
      success: true,
      personas: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    return handleApiError(error, 'EvalPersonas.list');
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
    const persona = await createPersona({
      ...result.data,
      tenantId: user.tenantId,
      projectId,
      createdBy: formatUserLabel(user),
    });
    return NextResponse.json({ success: true, persona }, { status: 201 });
  } catch (error) {
    return handleApiError(error, 'EvalPersonas.create');
  }
}
