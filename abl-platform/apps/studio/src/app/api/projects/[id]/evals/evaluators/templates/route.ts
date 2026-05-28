/**
 * GET /api/projects/:id/evals/evaluators/templates - List built-in rubric templates
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const { RUBRIC_TEMPLATES } =
      await import('@agent-platform/database/templates/eval-rubric-templates');
    const templates = RUBRIC_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      description: t.description,
      rubric: t.rubric,
      defaultJudgePrompt: t.defaultJudgePrompt,
    }));
    return NextResponse.json({ success: true, templates });
  } catch (error) {
    return handleApiError(error, 'EvalEvaluators.templates');
  }
}
