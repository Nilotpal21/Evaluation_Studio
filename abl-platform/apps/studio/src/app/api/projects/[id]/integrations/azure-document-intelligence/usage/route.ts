/**
 * Studio BFF proxy → workflow-engine Azure DI usage endpoints (LLD §3 Phase 3 Task 3.14).
 *
 *   GET   /api/projects/:projectId/integrations/azure-document-intelligence/usage
 *   PATCH /api/projects/:projectId/integrations/azure-document-intelligence/usage-caps
 *
 * The PATCH path lives at `usage-caps/route.ts`; this file only handles the
 * read-side GET that powers the AzureDIUsageView card.
 *
 * The proxy enforces Studio's auth chain (`requireAuth` + `requireProjectAccess`)
 * and forwards to the workflow-engine. Tenant scoping is explicit — Studio
 * route handlers do NOT have AsyncLocalStorage tenant injection (see
 * `apps/studio/CLAUDE.md`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { proxyToWorkflowEngine } from '@/lib/workflow-engine-proxy';
import { errorJson, ErrorCode } from '@/lib/api-response';

function buildPath(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/integrations/azure-document-intelligence/usage`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: projectId } = await params;
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  if (!user.tenantId) {
    return errorJson('Tenant context required', 400, ErrorCode.VALIDATION_ERROR);
  }
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  return proxyToWorkflowEngine(request, buildPath(projectId), {
    method: 'GET',
    tenantId: user.tenantId,
  });
}
