/**
 * POST /api/archives/audit-export - Export audit logs as archive
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, requireAdminRole, isAuthError } from '@/lib/auth';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import { archiveAuditLogs } from '@/services/archive/archive-service';

const log = createLogger('archives-audit-export-route');

export async function POST(request: NextRequest) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  try {
    const adminError = await requireAdminRole(user.id, user.tenantId);
    if (adminError) return adminError;

    const body = await request.json().catch(() => ({}));
    const olderThan = body.olderThan ? new Date(body.olderThan) : undefined;

    const manifest = await archiveAuditLogs({
      tenantId: user.tenantId,
      type: 'audit_logs',
      olderThan,
    });

    if (!manifest) {
      return NextResponse.json({ message: 'No audit logs to archive' });
    }

    await logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.ARCHIVE_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        archiveType: 'audit_logs',
        recordCount: manifest.recordCount,
        resourceType: 'archive',
        resourceId: manifest.id,
      },
    });

    return NextResponse.json(manifest);
  } catch (error) {
    log.error('Audit export error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Archive failed' }, { status: 500 });
  }
}
