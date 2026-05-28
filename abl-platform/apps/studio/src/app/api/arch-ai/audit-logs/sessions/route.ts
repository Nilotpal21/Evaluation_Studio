import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { requireArchAuditScope, isArchAuditScopeError } from '@/lib/arch-audit-scope';
import { enforceArchAuditRateLimit } from '@/lib/arch-audit-rate-limit';
import { querySessionList } from '@/lib/arch-inspector-reader';

const log = createLogger('api:arch-ai:audit-logs:sessions');

const querySchema = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  hasErrors: z.enum(['true', 'false']).optional(),
  minCost: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const parsed = querySchema.safeParse(rawParams);
    if (!parsed.success) {
      return errorJson('Invalid query parameters', 400, ErrorCode.VALIDATION_ERROR);
    }

    const scope = await requireArchAuditScope(request, parsed.data.projectId);
    if (isArchAuditScopeError(scope)) return scope;
    const rateLimit = await enforceArchAuditRateLimit(scope, 'sessions');
    if (rateLimit) return rateLimit;

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from = parsed.data.from ? new Date(parsed.data.from) : defaultFrom;
    const to = parsed.data.to ? new Date(parsed.data.to) : now;

    const result = await querySessionList({
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      userId: parsed.data.userId,
      from,
      to,
      hasErrors: parsed.data.hasErrors === 'true',
      minCost: parsed.data.minCost ? Number.parseFloat(parsed.data.minCost) : undefined,
      limit: Math.min(Number.parseInt(parsed.data.limit || '50', 10), 100),
      offset: Number.parseInt(parsed.data.offset || '0', 10),
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Session list error', { error: message });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
