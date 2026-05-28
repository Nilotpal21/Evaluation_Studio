/**
 * GET /api/archives/:id/download - Get presigned download URL
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { findTenantMembership } from '@/repos/auth-repo';
import { findArchiveManifestById } from '@/repos/archive-repo';
import { getArchiveStore } from '@/services/archive/archive-service';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const log = createLogger('archives-download-route');

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id } = await params;

  try {
    const tenantMembership = await findTenantMembership(user.id, user.tenantId);
    if (!tenantMembership) {
      return NextResponse.json({ error: 'Archive not found' }, { status: 404 });
    }

    const archive = await findArchiveManifestById(id, user.tenantId);

    if (!archive) {
      return NextResponse.json({ error: 'Archive not found' }, { status: 404 });
    }

    const downloadUrl = await getArchiveStore().getDownloadUrlForTenant(
      user.tenantId,
      archive.storageKey,
      3600,
    );

    await logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.ARCHIVE_DOWNLOADED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        resourceType: 'archive',
        resourceId: archive.id,
        storageKey: archive.storageKey,
      },
    });

    return NextResponse.json({
      downloadUrl,
      expiresIn: 3600,
    });
  } catch (error) {
    log.error('Archive download error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
