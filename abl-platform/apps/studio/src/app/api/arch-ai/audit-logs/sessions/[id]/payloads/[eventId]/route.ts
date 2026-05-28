import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { requireArchAuditScope, isArchAuditScopeError } from '@/lib/arch-audit-scope';
import { enforceArchAuditRateLimit } from '@/lib/arch-audit-rate-limit';
import { queryPayload } from '@/lib/arch-inspector-reader';

const log = createLogger('api:arch-ai:audit-logs:session-payload');

const querySchema = z.object({
  projectId: z.string().min(1).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  try {
    const { id: sessionId, eventId } = await params;
    if (!sessionId || !eventId) {
      return errorJson('Session ID and event ID are required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const parsed = querySchema.safeParse(rawParams);
    if (!parsed.success) {
      return errorJson('Invalid query parameters', 400, ErrorCode.VALIDATION_ERROR);
    }

    const scope = await requireArchAuditScope(request, parsed.data.projectId);
    if (isArchAuditScopeError(scope)) return scope;
    const rateLimit = await enforceArchAuditRateLimit(scope, 'session-payload');
    if (rateLimit) return rateLimit;

    const payload = await queryPayload(scope.tenantId, eventId);
    if (!payload) {
      return errorJson('Payload not found', 404, ErrorCode.NOT_FOUND);
    }

    return NextResponse.json({ success: true, payload });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Session payload error', { error: message });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
