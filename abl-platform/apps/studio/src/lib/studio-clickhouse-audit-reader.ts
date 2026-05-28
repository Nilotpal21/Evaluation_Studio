import type {
  AuditActorType,
  AuditEventType,
  AuditResourceType,
  Environment,
} from '@abl/compiler/platform';
import {
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
  type QueryAuditParams,
} from '@abl/compiler/platform/stores';
import type { AuditLog } from '@abl/compiler/platform/core/types';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import {
  queryStudioAuditExplorer,
  type StudioAuditExplorerQuery,
} from '@/lib/audit/audit-explorer-query';
import {
  AUDIT_EXPLORER_CATEGORIES,
  getAuditExplorerCategoryValues,
  type AuditExplorerCategory,
} from '@/lib/audit/audit-explorer-catalog';

export type StudioAuditScope = 'personal' | 'workspace';
export type StudioPersonalScopeMode = 'tenant-safe';

export interface StudioClickHouseAuditQueryOptions {
  scope: StudioAuditScope;
  personalScopeMode: StudioPersonalScopeMode;
  userId: string;
  tenantId?: string;
  action?: string;
  actions?: string[];
  eventTypes?: AuditEventType[];
  categories?: AuditExplorerCategory[];
  query?: string;
  actor?: string;
  actorTypes?: AuditActorType[];
  projectId?: string;
  resourceTypes?: AuditResourceType[];
  resourceId?: string;
  traceId?: string;
  sources?: string[];
  environments?: Environment[];
  success?: 'success' | 'failure';
  ipAddress?: string;
  metadataKey?: string;
  metadataValue?: string;
  cursor?: string;
  includeFacets?: boolean;
  from?: string | null;
  to?: string | null;
  limit: number;
  offset: number;
}

function resolveDateRange(
  from?: string | null,
  to?: string | null,
): Pick<QueryAuditParams, 'startTime' | 'endTime'> {
  const startTime = from ? new Date(from) : new Date(0);
  const endTime = to ? new Date(to) : new Date();

  return {
    startTime: Number.isNaN(startTime.getTime()) ? new Date(0) : startTime,
    endTime: Number.isNaN(endTime.getTime()) ? new Date() : endTime,
  };
}

function matchesAnyValue(value: string | undefined, values?: readonly string[]): boolean {
  if (!values || values.length === 0) return true;
  return typeof value === 'string' && values.includes(value);
}

function matchesSearch(log: AuditLog, query?: string): boolean {
  if (!query) return true;
  const haystack = [
    log.action,
    log.eventType,
    log.actor,
    log.actorType,
    log.resourceType,
    log.resourceId,
    log.projectId,
    log.traceId,
    log.ipAddress,
    JSON.stringify(log.metadata),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function matchesCategory(log: AuditLog, categories?: readonly AuditExplorerCategory[]): boolean {
  if (!categories || categories.length === 0) return true;
  const categoryFilters = getAuditExplorerCategoryValues(categories);
  const candidates = [log.action, log.eventType];

  return candidates.some(
    (candidate) =>
      categoryFilters.values.includes(candidate) ||
      categoryFilters.prefixes.some((prefix) => candidate.startsWith(prefix)),
  );
}

function matchesComplianceAuditCategory(log: AuditLog): boolean {
  return matchesCategory(log, AUDIT_EXPLORER_CATEGORIES);
}

function getMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function applyInMemoryExplorerFilters(
  result: { logs: AuditLog[]; total: number },
  options: StudioClickHouseAuditQueryOptions,
) {
  const filtered = result.logs.filter((log) => {
    if (!matchesComplianceAuditCategory(log)) return false;
    if (!matchesCategory(log, options.categories)) return false;
    if (!matchesSearch(log, options.query)) return false;
    if (options.actor && log.actor !== options.actor) return false;
    if (!matchesAnyValue(log.actorType, options.actorTypes)) return false;
    if (options.projectId && log.projectId !== options.projectId) return false;
    if (!matchesAnyValue(log.resourceType, options.resourceTypes)) return false;
    if (options.resourceId && log.resourceId !== options.resourceId) return false;
    if (
      options.traceId &&
      log.traceId !== options.traceId &&
      getMetadataString(log.metadata, 'traceId') !== options.traceId
    ) {
      return false;
    }
    if (
      !matchesAnyValue(log.source ?? getMetadataString(log.metadata, 'source'), options.sources)
    ) {
      return false;
    }
    if (!matchesAnyValue(log.environment, options.environments)) return false;
    if (options.success) {
      const success = log.metadata.success;
      const normalizedSuccess =
        typeof success === 'boolean'
          ? success
          : typeof success === 'string'
            ? success.toLowerCase() === 'true'
            : undefined;
      if (normalizedSuccess !== (options.success === 'success')) {
        return false;
      }
    }
    if (options.ipAddress && !log.ipAddress?.startsWith(options.ipAddress)) return false;
    if (options.metadataKey) {
      const value = log.metadata[options.metadataKey];
      if (options.metadataValue) {
        return String(value ?? '')
          .toLowerCase()
          .includes(options.metadataValue.toLowerCase());
      }
      return value !== undefined;
    }
    return true;
  });

  return {
    logs: filtered,
    total: filtered.length,
  };
}

export async function queryStudioAuditLogsFromClickHouse(
  options: StudioClickHouseAuditQueryOptions,
): Promise<{ logs: AuditLog[]; total: number; nextCursor?: string }> {
  if (!options.tenantId) {
    throw new Error('tenantId is required for Studio audit queries');
  }

  const queryParams: QueryAuditParams = {
    ...resolveDateRange(options.from, options.to),
    tenantId: options.tenantId,
    limit: options.limit,
    offset: options.offset,
  };

  if (options.scope === 'personal') {
    queryParams.actor = options.userId;
  }

  if (options.actor) {
    queryParams.actor = options.actor;
  }
  if (options.projectId) {
    queryParams.projectId = options.projectId;
  }
  if (options.resourceId) {
    queryParams.resourceId = options.resourceId;
  }
  if (options.eventTypes?.length) {
    queryParams.eventTypes = options.eventTypes;
  }
  if (options.actions?.length || options.action) {
    queryParams.actions = [
      ...new Set(
        [...(options.actions ?? []), options.action].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        ),
      ),
    ];
  }

  if (isInMemoryAuditTestBackendEnabled()) {
    return applyInMemoryExplorerFilters(await queryInMemoryAuditTestLogs(queryParams), options);
  }

  const explorerQuery: StudioAuditExplorerQuery & { tenantId: string; userId: string } = {
    scope: options.scope,
    personalScopeMode: options.personalScopeMode,
    action: options.action,
    from: options.from ?? null,
    to: options.to ?? null,
    limit: options.limit,
    offset: options.offset,
    cursor: options.cursor,
    query: options.query,
    categories: options.categories,
    eventTypes: options.eventTypes,
    actions:
      options.actions?.length || options.action
        ? [...new Set([...(options.actions ?? []), options.action].filter(Boolean) as string[])]
        : undefined,
    actor: options.actor,
    actorTypes: options.actorTypes,
    projectId: options.projectId,
    resourceTypes: options.resourceTypes,
    resourceId: options.resourceId,
    traceId: options.traceId,
    sources: options.sources,
    environments: options.environments,
    success: options.success,
    ipAddress: options.ipAddress,
    metadataKey: options.metadataKey,
    metadataValue: options.metadataValue,
    includeFacets: options.includeFacets ?? false,
    tenantId: options.tenantId,
    userId: options.userId,
  };

  return queryStudioAuditExplorer(getClickHouseClient(), explorerQuery);
}
