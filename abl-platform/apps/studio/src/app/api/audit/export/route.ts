import { NextRequest, NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { parseStudioAuditExplorerQuery } from '@/lib/audit/audit-explorer-query';
import {
  queryStudioAuditLogsFromClickHouse,
  type StudioClickHouseAuditQueryOptions,
} from '@/lib/studio-clickhouse-audit-reader';
import {
  getAuditExplorerCategoryLabel,
  resolveAuditExplorerCategory,
} from '@/lib/audit/audit-explorer-catalog';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);
const EXPORT_LIMIT = 200;

const exportFormatSchema = z.enum(['csv', 'json', 'ndjson']).default('csv');
type AuditExportLog = Awaited<
  ReturnType<typeof queryStudioAuditLogsFromClickHouse>
>['logs'][number];
type AuditExportRow = AuditExportLog & {
  category: string;
  categoryLabel: string;
};

function encodeCsvCell(value: unknown): string {
  const rawText = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const text = /^[=+\-@]/.test(rawText) ? `'${rawText}` : rawText;
  return `"${text.replace(/"/g, '""')}"`;
}

function withAuditCategories(logs: readonly AuditExportLog[]): AuditExportRow[] {
  return logs.map((log) => {
    const category = resolveAuditExplorerCategory(log.action, log.eventType);
    return {
      ...log,
      category,
      categoryLabel: getAuditExplorerCategoryLabel(category),
    };
  });
}

function serializeCsv(logs: readonly AuditExportRow[]) {
  const headers = [
    'id',
    'timestamp',
    'category',
    'categoryLabel',
    'tenantId',
    'projectId',
    'eventType',
    'action',
    'actor',
    'actorType',
    'resourceType',
    'resourceId',
    'environment',
    'source',
    'ipAddress',
    'traceId',
    'metadata',
  ];
  const rows = logs.map((log) =>
    [
      log.id,
      log.timestamp.toISOString(),
      log.category,
      log.categoryLabel,
      log.tenantId,
      log.projectId ?? null,
      log.eventType,
      log.action,
      log.actor,
      log.actorType,
      log.resourceType,
      log.resourceId,
      log.environment,
      log.source ??
        (typeof log.metadata.source === 'string' && log.metadata.source.length > 0
          ? log.metadata.source
          : null),
      log.ipAddress ?? null,
      log.traceId ?? null,
      log.metadata,
    ]
      .map(encodeCsvCell)
      .join(','),
  );
  return [headers.join(','), ...rows].join('\n');
}

function serializeExport(format: 'csv' | 'json' | 'ndjson', logs: readonly AuditExportRow[]) {
  if (format === 'json') {
    return {
      body: JSON.stringify({ logs }, null, 2),
      contentType: 'application/json',
      extension: 'json',
    };
  }
  if (format === 'ndjson') {
    return {
      body: logs.map((log) => JSON.stringify(log)).join('\n'),
      contentType: 'application/x-ndjson',
      extension: 'ndjson',
    };
  }
  return {
    body: serializeCsv(logs),
    contentType: 'text/csv',
    extension: 'csv',
  };
}

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    if (!user.tenantId) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    const format = exportFormatSchema.parse(request.nextUrl.searchParams.get('format') ?? 'csv');
    const queryParams = new URLSearchParams(request.nextUrl.searchParams);
    queryParams.delete('format');
    queryParams.set('scope', queryParams.get('scope') ?? 'workspace');
    queryParams.set('limit', String(EXPORT_LIMIT));
    queryParams.set('offset', '0');

    const query = parseStudioAuditExplorerQuery(queryParams);
    if (query.scope === 'workspace' && (!user.role || !ADMIN_ROLES.has(user.role))) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }
    if (!query.from || !query.to) {
      return errorJson(
        'from and to are required for audit exports',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const clickHouseOptions: StudioClickHouseAuditQueryOptions = {
      scope: query.scope,
      personalScopeMode: query.personalScopeMode,
      userId: user.id,
      tenantId: user.tenantId,
      action: query.action,
      actions: query.actions,
      eventTypes: query.eventTypes,
      categories: query.categories,
      query: query.query,
      actor: query.actor,
      actorTypes: query.actorTypes,
      projectId: query.projectId,
      resourceTypes: query.resourceTypes,
      resourceId: query.resourceId,
      traceId: query.traceId,
      sources: query.sources,
      environments: query.environments,
      success: query.success,
      ipAddress: query.ipAddress,
      metadataKey: query.metadataKey,
      metadataValue: query.metadataValue,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    };
    const result = await queryStudioAuditLogsFromClickHouse(clickHouseOptions);
    const logs = withAuditCategories(result.logs);
    const serialized = serializeExport(format, logs);

    void logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.AUDIT_EXPORT_DOWNLOADED,
      metadata: {
        exportType: 'audit_logs',
        format,
        recordCount: logs.length,
        scope: query.scope,
      },
    });

    return new NextResponse(serialized.body, {
      status: 200,
      headers: {
        'content-type': serialized.contentType,
        'content-disposition': `attachment; filename="audit-logs.${serialized.extension}"`,
        'x-audit-export-row-count': String(logs.length),
      },
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return errorJson(
        error.issues.map((issue) => issue.message),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    return handleApiError(error, 'Audit.Export.GET');
  }
}
