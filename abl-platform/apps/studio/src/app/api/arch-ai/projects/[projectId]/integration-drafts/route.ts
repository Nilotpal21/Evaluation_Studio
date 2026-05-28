/**
 * GET /api/arch-ai/projects/:projectId/integration-drafts — Project-scoped list
 * of integration drafts (excludes archived). Powers the in-project Integrations
 * panel which mounts independently of any active session.
 */

import { NextRequest } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { successJson, handleApiError } from '@/lib/api-response';
import { listNonArchivedIntegrationDrafts } from '@/lib/arch-ai/integration-draft-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { projectId } = await params;

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const drafts = await listNonArchivedIntegrationDrafts({
      tenantId: auth.tenantId,
      projectId,
    });

    return successJson('drafts', drafts);
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai');
  }
}
