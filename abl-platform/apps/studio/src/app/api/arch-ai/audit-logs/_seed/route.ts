/**
 * POST /api/arch-ai/audit-logs/_seed — Test-only seeding endpoint.
 *
 * Guarded by NODE_ENV=test. Accepts an array of audit log entries and
 * writes them through the real AuditLogEmitter pipeline.
 *
 * ONLY available in test environments.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, requireAdminRole, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { AuditLogEmitter } from '@agent-platform/arch-ai';
import type { AuditLogEntry } from '@agent-platform/arch-ai';
import { getStudioArchAuditPipelineWriter } from '@/lib/arch-audit-pipeline-writer';

const log = createLogger('api:arch-ai:audit-logs:seed');

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV !== 'test') {
    return NextResponse.json({ success: false }, { status: 404 });
  }

  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const adminCheck = await requireAdminRole(auth.id, auth.tenantId);
    if (adminCheck) return adminCheck;

    const body = (await request.json()) as { entries?: AuditLogEntry[]; sessionId?: string };
    if (!Array.isArray(body.entries) || body.entries.length === 0) {
      return errorJson('entries array is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const sessionId = body.sessionId ?? 'seed-session';
    const emitter = new AuditLogEmitter(
      { tenantId: auth.tenantId, userId: auth.id, sessionId },
      getStudioArchAuditPipelineWriter(),
      { bufferThreshold: body.entries.length + 1 }, // don't auto-flush mid-seed
    );

    for (const entry of body.entries) {
      emitter.emit(entry);
    }
    await emitter.flush();
    emitter.destroy();

    log.info('Audit logs seeded', { count: body.entries.length, tenantId: auth.tenantId });

    return NextResponse.json({ success: true, count: body.entries.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Audit logs seed error', { error: message });
    return errorJson('Seed failed', 500, ErrorCode.INTERNAL_ERROR);
  }
}
