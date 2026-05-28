/**
 * DELETE /api/sdk/keys/:keyId - Revoke an SDK API key
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withOpenAPI } from '@agent-platform/openapi/nextjs';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireAuth, isAuthError } from '@/lib/auth';
import { findPublicApiKeys, updatePublicApiKey } from '@/repos/sdk-repo';
import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';

const pathParamsSchema = z.object({
  keyId: z.string().min(1),
});

const deleteResponseSchema = z.object({
  success: z.boolean(),
});

type RouteParams = { params: Promise<{ keyId: string }> };
const log = createLogger('studio-sdk-key-revoke');

async function deleteHandler(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { keyId } = await params;
  if (!user.tenantId) {
    return NextResponse.json({ error: 'Tenant context required' }, { status: 403 });
  }

  try {
    const [key] = await findPublicApiKeys({ id: keyId, tenantId: user.tenantId });
    if (!key || typeof key.projectId !== 'string' || key.projectId.trim().length === 0) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }

    const projectAccess = await requireSdkProjectAccess(key.projectId, user, 'write');
    if (isSdkProjectAccessError(projectAccess)) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }

    // Soft-revoke by deactivating (preserves audit trail) - use repo function
    // PublicApiKey is project-scoped, not tenant-scoped
    await updatePublicApiKey(keyId, key.projectId, projectAccess.project.tenantId, {
      isActive: false,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('Failed to revoke SDK key', {
      error: error instanceof Error ? error.message : String(error),
      keyId,
      userId: user.id,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const DELETE = withOpenAPI(
  {
    summary: 'Revoke SDK API key',
    description: 'Revoke an SDK API key by deactivating it (soft delete).',
    params: pathParamsSchema,
    response: deleteResponseSchema,
    successStatus: 200,
    auth: true,
  },
  deleteHandler as any,
);
