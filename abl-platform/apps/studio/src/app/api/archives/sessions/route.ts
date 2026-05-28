/**
 * POST /api/archives/sessions - Trigger session archival
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, requireAdminRole, isAuthError } from '@/lib/auth';
import { createArchiveManifest } from '@/repos/archive-repo';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const log = createLogger('archives-sessions-route');

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  try {
    const adminError = await requireAdminRole(user.id, user.tenantId);
    if (adminError) return adminError;

    const { Session } = await import('@agent-platform/database/models');

    const body = await request.json().catch(() => ({}));
    const olderThan = body.olderThan ? new Date(body.olderThan) : undefined;

    // Count sessions to archive
    const where: any = { tenantId: user.tenantId };
    if (olderThan) where.createdAt = { $lt: olderThan };

    const count = await Session.countDocuments(where);

    if (count === 0) {
      return NextResponse.json({ message: 'No sessions to archive' });
    }

    // Create archive manifest
    const manifest = await createArchiveManifest({
      tenantId: user.tenantId,
      type: 'sessions',
      recordCount: count,
      storageKey: `${user.tenantId}/archives/sessions/${Date.now()}.ndjson.gz`,
      sizeBytes: 0,
      checksum: '',
      dateRangeStart: olderThan || new Date(0),
      dateRangeEnd: new Date(),
    });

    await logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.ARCHIVE_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        archiveType: 'sessions',
        recordCount: count,
        resourceType: 'archive',
        resourceId: manifest.id,
      },
    });

    return NextResponse.json(manifest);
  } catch (error) {
    log.error('Session archive error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Archive failed' }, { status: 500 });
  }
}
