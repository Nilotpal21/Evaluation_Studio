import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { requireArchAuditScope, isArchAuditScopeError } from '@/lib/arch-audit-scope';
import { enforceArchAuditRateLimit } from '@/lib/arch-audit-rate-limit';
import { queryPayloadsBatch } from '@/lib/arch-inspector-reader';

const log = createLogger('api:arch-ai:audit-logs:session-payloads');

const bodySchema = z.object({
  eventIds: z.array(z.string().min(1)).min(1).max(50),
  projectId: z.string().min(1).optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: sessionId } = await params;
    if (!sessionId) {
      return errorJson('Session ID is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return errorJson(
        parsed.error.errors.map((e) => e.message).join(', '),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const scope = await requireArchAuditScope(request, parsed.data.projectId);
    if (isArchAuditScopeError(scope)) return scope;
    const rateLimit = await enforceArchAuditRateLimit(scope, 'session-payloads');
    if (rateLimit) return rateLimit;

    const payloads = await queryPayloadsBatch(scope.tenantId, parsed.data.eventIds);

    return NextResponse.json({ success: true, payloads });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Session payloads batch error', { error: message });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
