/**
 * GET /api/projects/:id/evals/personas/templates - List built-in adversarial persona templates
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
    const { ADVERSARIAL_PERSONA_TEMPLATES } =
      await import('@agent-platform/database/templates/eval-persona-templates');
    const templates = ADVERSARIAL_PERSONA_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.data.name,
      description: t.data.description,
      communicationStyle: t.data.communicationStyle,
      domainKnowledge: t.data.domainKnowledge,
      adversarialType: t.data.adversarialType,
    }));
    return NextResponse.json({ success: true, templates });
  } catch (error) {
    return handleApiError(error, 'EvalPersonas.templates');
  }
}
