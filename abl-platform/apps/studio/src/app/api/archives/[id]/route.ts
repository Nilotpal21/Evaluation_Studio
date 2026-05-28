/**
 * GET    /api/archives/:id/download - Get download URL for archive
 * DELETE /api/archives/:id - Delete an archive
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, requireAdminRole, isAuthError } from '@/lib/auth';
import { findArchiveManifestById, deleteArchiveManifest } from '@/repos/archive-repo';
import { getArchiveStore } from '@/services/archive/archive-service';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const log = createLogger('archives-route');

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const adminError = await requireAdminRole(user.id, user.tenantId);
    if (adminError) return adminError;

    const archive = await findArchiveManifestById(id, user.tenantId);

    if (!archive) {
      return NextResponse.json({ error: 'Archive not found' }, { status: 404 });
    }

    await getArchiveStore().deleteForTenant(user.tenantId, archive.storageKey);
    await deleteArchiveManifest(archive.id, user.tenantId);

    await logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.ARCHIVE_DELETED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        resourceType: 'archive',
        resourceId: archive.id,
        storageKey: archive.storageKey,
      },
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    log.error('Archive delete error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
