/**
 * GET    /api/projects/:id/evals/personas/:personaId - Get a persona
 * PATCH  /api/projects/:id/evals/personas/:personaId - Update a persona
 * DELETE /api/projects/:id/evals/personas/:personaId - Delete a persona
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findPersonaById, updatePersona, deletePersona } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
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

const updateSchema = z.object({
  name: z.string().min(1).max(EVAL_NAME_MAX_LENGTH).optional(),
  description: z.string().max(EVAL_DESCRIPTION_MAX_LENGTH).optional(),
  communicationStyle: z.enum(['casual', 'formal', 'technical', 'terse', 'verbose']).optional(),
  domainKnowledge: z.enum(['beginner', 'intermediate', 'expert']).optional(),
  behaviorTraits: z
    .array(z.string().max(EVAL_TRAIT_MAX_LENGTH))
    .max(EVAL_BEHAVIOR_TRAITS_MAX_COUNT)
    .optional(),
  goals: z.string().max(EVAL_GOALS_MAX_LENGTH).optional(),
  constraints: z.string().max(EVAL_CONSTRAINTS_MAX_LENGTH).optional(),
  sessionVariables: sessionVariablesSchema,
  systemPrompt: z.string().max(EVAL_SYSTEM_PROMPT_MAX_LENGTH).nullable().optional(),
  isAdversarial: z.boolean().optional(),
  adversarialType: z
    .enum(['prompt_injection', 'social_engineering', 'off_topic', 'abusive', 'edge_case'])
    .nullable()
    .optional(),
});

type RouteParams = { params: Promise<{ id: string; personaId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, personaId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const persona = await findPersonaById(personaId, user.tenantId, projectId);
    if (!persona) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, persona });
  } catch (error) {
    return handleApiError(error, 'EvalPersonas.get');
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, personaId } = await params;
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
    const persona = await updatePersona(personaId, user.tenantId, projectId, result.data);
    if (!persona) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, persona });
  } catch (error) {
    return handleApiError(error, 'EvalPersonas.update');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, personaId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const deleted = await deletePersona(personaId, user.tenantId, projectId);
    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, deleted: personaId });
  } catch (error) {
    return handleApiError(error, 'EvalPersonas.delete');
  }
}
