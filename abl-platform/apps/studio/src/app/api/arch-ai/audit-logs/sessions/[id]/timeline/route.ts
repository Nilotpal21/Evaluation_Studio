/**
 * GET /api/arch-ai/audit-logs/sessions/:id/timeline — Session event timeline.
 *
 * Returns all audit log entries for a session in chronological order (ascending).
 * Empty array for non-existent sessions (not 404).
 *
 * Isolation: tenantId from auth + sessionId from URL + optional projectId.
 * Note: without projectId, workspace admins see all sessions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { requireArchAuditScope, isArchAuditScopeError } from '@/lib/arch-audit-scope';
import { enforceArchAuditRateLimit } from '@/lib/arch-audit-rate-limit';
import { queryArchAuditTimeline } from '@/lib/arch-clickhouse-audit-reader';

const log = createLogger('api:arch-ai:audit-logs:timeline');

const querySchema = z.object({
  projectId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const parsed = querySchema.safeParse(rawParams);
    if (!parsed.success) {
      return errorJson('Invalid query parameters', 400, ErrorCode.VALIDATION_ERROR);
    }

    const scope = await requireArchAuditScope(request, parsed.data.projectId);
    if (isArchAuditScopeError(scope)) return scope;
    const rateLimit = await enforceArchAuditRateLimit(scope, 'timeline');
    if (rateLimit) return rateLimit;

    const { id: sessionId } = await params;
    if (!sessionId) {
      return errorJson('Session ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const entries = await queryArchAuditTimeline(scope.tenantId, sessionId, scope.projectId);

    return NextResponse.json({ success: true, entries });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Audit logs timeline error', { error: message });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
