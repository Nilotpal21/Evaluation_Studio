/**
 * GET /api/arch-ai/audit-logs — List audit log entries with filters, pagination, and export.
 *
 * Auth:
 *   - Workspace mode: requireTenantAuth + requireAdminRole (OWNER/ADMIN only).
 *   - Project mode: ?projectId=... + requireProjectAccess.
 * Isolation: explicit { tenantId, projectId? } filter (plugin is defense-in-depth).
 *
 * Modes:
 *   - Default (no format): paginated JSON envelope
 *   - format=csv: full filtered set (up to 10K), Content-Disposition: attachment
 *   - format=json-export: full filtered set as JSON array, Content-Disposition: attachment
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { AUDIT_LOG_CATEGORIES } from '@agent-platform/arch-ai/audit';
import { requireArchAuditScope, isArchAuditScopeError } from '@/lib/arch-audit-scope';
import { enforceArchAuditRateLimit } from '@/lib/arch-audit-rate-limit';
import {
  normalizeArchAuditCategories,
  normalizeArchAuditSeverities,
  queryArchAuditLogs,
  type ArchAuditLogRecord,
  type ArchAuditListQuery,
} from '@/lib/arch-clickhouse-audit-reader';

const log = createLogger('api:arch-ai:audit-logs');

const EXPORT_LIMIT = 10_000;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_DAYS_BACK = 7;

const querySchema = z.object({
  projectId: z.string().min(1).optional(),
  category: z.string().optional(),
  severity: z.string().optional(),
  phase: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  specialist: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional().default(DEFAULT_LIMIT),
  format: z.enum(['csv', 'json-export']).optional(),
});

function buildQuery(
  tenantId: string,
  projectId: string | undefined,
  params: z.infer<typeof querySchema>,
): ArchAuditListQuery | { _invalid: true } | { _invalid_range: true } {
  const categories = normalizeArchAuditCategories(params.category);
  const severities = normalizeArchAuditSeverities(params.severity);

  if (params.category) {
    if (categories.length === 0) {
      return { _invalid: true };
    }
  }

  if (params.severity) {
    if (severities.length === 0) {
      return { _invalid: true };
    }
  }

  const now = new Date();
  const from = params.from
    ? new Date(params.from)
    : new Date(now.getTime() - DEFAULT_DAYS_BACK * 86400000);
  const to = params.to ? new Date(params.to) : now;

  if (from > to) {
    return { _invalid_range: true };
  }

  return {
    tenantId,
    projectId,
    categories: categories.length > 0 ? categories : undefined,
    severities: severities.length > 0 ? severities : undefined,
    phase: params.phase,
    userId: params.userId,
    sessionId: params.sessionId,
    specialist: params.specialist,
    from,
    to,
    limit: params.limit,
    offset: (params.page - 1) * params.limit,
  };
}

function toCsvRow(entry: ArchAuditLogRecord): string {
  const fields = [
    entry._id,
    entry.tenantId,
    entry.userId,
    entry.sessionId,
    entry.projectId ?? '',
    entry.category,
    entry.severity,
    entry.summary,
    entry.phase ?? '',
    entry.specialist ?? '',
    entry.durationMs ?? '',
    entry.tokens ? JSON.stringify(entry.tokens) : '',
    JSON.stringify(entry.detail ?? {}),
    entry.timestamp,
  ];
  return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(',');
}

const CSV_HEADER =
  '"_id","tenantId","userId","sessionId","projectId","category","severity","summary","phase","specialist","durationMs","tokens","detail","timestamp"';

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const parsed = querySchema.safeParse(rawParams);
    if (!parsed.success) {
      return errorJson(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const scope = await requireArchAuditScope(request, parsed.data.projectId);
    if (isArchAuditScopeError(scope)) return scope;
    const rateLimit = await enforceArchAuditRateLimit(
      scope,
      parsed.data.format ? 'list-export' : 'list',
    );
    if (rateLimit) return rateLimit;

    const query = buildQuery(scope.tenantId, scope.projectId, parsed.data);

    if ('_invalid' in query) {
      return errorJson(
        `Invalid category. Valid values: ${AUDIT_LOG_CATEGORIES.join(', ')}`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if ('_invalid_range' in query) {
      return errorJson(
        'Invalid date range: "from" must be before "to"',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // ─── Export mode ───────────────────────────────────────────────
    if (parsed.data.format) {
      const { entries } = await queryArchAuditLogs({
        ...query,
        limit: EXPORT_LIMIT,
        offset: 0,
      });

      if (parsed.data.format === 'csv') {
        const rows = [CSV_HEADER, ...entries.map(toCsvRow)].join('\n');
        return new NextResponse(rows, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="arch-audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
          },
        });
      }

      // json-export
      return new NextResponse(JSON.stringify(entries), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="arch-audit-logs-${new Date().toISOString().slice(0, 10)}.json"`,
        },
      });
    }

    // ─── Paginated list mode ───────────────────────────────────────
    const { entries, total } = await queryArchAuditLogs(query);

    return NextResponse.json({
      success: true,
      entries,
      total,
      page: parsed.data.page,
      hasMore: query.offset + entries.length < total,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Audit logs list error', { error: message });
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }
}
