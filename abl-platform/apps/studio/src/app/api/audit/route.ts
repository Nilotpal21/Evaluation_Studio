/**
 * GET /api/audit - Get recent audit logs
 *
 * Supports two scopes via ?scope= query param:
 *   - "personal" (default): logs for the authenticated user only
 *   - "workspace": all logs for the tenant (requires OWNER or ADMIN role)
 */

import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { requireAuth, isAuthError } from '@/lib/auth';
import { handleApiError, errorJson, ErrorCode } from '@/lib/api-response';
import {
  queryStudioAuditLogsFromClickHouse,
  type StudioClickHouseAuditQueryOptions,
} from '@/lib/studio-clickhouse-audit-reader';
import { parseStudioAuditExplorerQuery } from '@/lib/audit/audit-explorer-query';
import {
  getAuditExplorerCategoryLabel,
  resolveAuditExplorerCategory,
} from '@/lib/audit/audit-explorer-catalog';

const ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);
const TENANT_SAFE_PERSONAL_MODE = 'tenant-safe';

type PersonalScopeMode = typeof TENANT_SAFE_PERSONAL_MODE;
type AuditApiLogRecord = {
  id: string;
  userId: string | null;
  tenantId: string | null;
  projectId: string | null;
  eventType: string;
  category: string;
  categoryLabel: string;
  action: string;
  actorType: string | null;
  resourceType: string | null;
  resourceId: string | null;
  environment: string | null;
  traceId: string | null;
  source: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date | string;
};

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAuditMetadata(metadata: unknown): Record<string, unknown> | null {
  if (isMetadataRecord(metadata)) {
    return metadata;
  }

  if (typeof metadata !== 'string' || metadata.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(metadata) as unknown;
    return isMetadataRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePersonalScopeMode(requestedMode: string | null): PersonalScopeMode {
  return requestedMode === TENANT_SAFE_PERSONAL_MODE
    ? TENANT_SAFE_PERSONAL_MODE
    : TENANT_SAFE_PERSONAL_MODE;
}

export async function GET(request: NextRequest) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  try {
    const query = parseStudioAuditExplorerQuery(request.nextUrl.searchParams);
    const scope = query.scope;
    const personalScopeMode = resolvePersonalScopeMode(query.personalScopeMode);

    if (!user.tenantId) {
      return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
    }

    if (scope === 'workspace') {
      // Workspace scope requires admin role and tenant context
      if (!user.role || !ADMIN_ROLES.has(user.role)) {
        return errorJson('Not found', 404, ErrorCode.NOT_FOUND);
      }
    }

    const clickHouseOptions: StudioClickHouseAuditQueryOptions = {
      scope: scope === 'workspace' ? 'workspace' : 'personal',
      personalScopeMode,
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
      cursor: query.cursor,
      includeFacets: query.includeFacets,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    };
    const clickHouseResult = await queryStudioAuditLogsFromClickHouse(clickHouseOptions);

    const logs: AuditApiLogRecord[] = clickHouseResult.logs.map((log) => {
      const eventType = log.eventType ?? log.action;
      const category = resolveAuditExplorerCategory(log.action, eventType);

      return {
        id: log.id,
        userId: log.actor,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        eventType,
        category,
        categoryLabel: getAuditExplorerCategoryLabel(category),
        action: log.action,
        actorType: log.actorType ?? null,
        resourceType: log.resourceType ?? null,
        resourceId: log.resourceId ?? null,
        environment: log.environment ?? null,
        traceId: log.traceId ?? null,
        source:
          isMetadataRecord(log.metadata) && typeof log.metadata.source === 'string'
            ? log.metadata.source
            : typeof log.source === 'string'
              ? log.source
              : null,
        ip: log.ipAddress ?? null,
        userAgent: null,
        metadata: log.metadata,
        createdAt: log.timestamp,
      };
    });
    const total = clickHouseResult.total;

    return NextResponse.json({
      logs: logs.map((log) => ({
        id: log.id,
        userId: log.userId,
        tenantId: log.tenantId,
        projectId: log.projectId,
        eventType: log.eventType,
        category: log.category,
        categoryLabel: log.categoryLabel,
        action: log.action,
        actorType: log.actorType,
        resourceType: log.resourceType,
        resourceId: log.resourceId,
        environment: log.environment,
        traceId: log.traceId,
        source: log.source,
        ip: log.ip,
        userAgent: log.userAgent,
        metadata: parseAuditMetadata(log.metadata),
        createdAt: log.createdAt,
      })),
      total,
      nextCursor: clickHouseResult.nextCursor,
      limit: query.limit,
      offset: query.offset,
      scope,
      personalScopeMode: scope === 'personal' ? personalScopeMode : undefined,
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      return errorJson(
        error.issues.map((issue) => issue.message),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }
    return handleApiError(error, 'Audit.GET');
  }
}
