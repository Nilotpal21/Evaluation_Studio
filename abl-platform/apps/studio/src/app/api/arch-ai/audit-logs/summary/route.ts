/**
 * GET /api/arch-ai/audit-logs/summary — Aggregate KPI stats.
 *
 * Returns: totalEvents, totalTokens (input/output/total), estimatedCost,
 * errorCount by severity, event count by category.
 *
 * Uses the shared Arch audit reader so ClickHouse and the in-memory test backend
 * stay aligned.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { requireArchAuditScope, isArchAuditScopeError } from '@/lib/arch-audit-scope';
import { enforceArchAuditRateLimit } from '@/lib/arch-audit-rate-limit';
import { summarizeArchAuditLogs } from '@/lib/arch-clickhouse-audit-reader';

const log = createLogger('api:arch-ai:audit-logs:summary');

const DEFAULT_DAYS_BACK = 7;

const querySchema = z.object({
  projectId: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const parsed = querySchema.safeParse(rawParams);
    if (!parsed.success) {
      return errorJson('Invalid query parameters', 400, ErrorCode.VALIDATION_ERROR);
    }

    const now = new Date();
    const from = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(now.getTime() - DEFAULT_DAYS_BACK * 86400000);
    const to = parsed.data.to ? new Date(parsed.data.to) : now;

    const scope = await requireArchAuditScope(request, parsed.data.projectId);
    if (isArchAuditScopeError(scope)) return scope;
    const rateLimit = await enforceArchAuditRateLimit(scope, 'summary');
    if (rateLimit) return rateLimit;

    const summary = await summarizeArchAuditLogs({
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      from,
      to,
    });

    return NextResponse.json({
      success: true,
      data: summary,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Audit logs summary error', { error: message });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
