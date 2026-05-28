import {
  ClickHouseAuditReader,
  isInMemoryAuditTestBackendEnabled,
  queryInMemoryAuditTestLogs,
  type QueryAuditParams,
} from '@abl/compiler/platform/stores';
import type { AuditLog } from '@abl/compiler/platform/core/types';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { AdminAction, AuditEntry } from './audit-logger';

export type AdminAuditReadScope = 'platform' | 'tenant';

const CANONICAL_METADATA_KEYS = new Set([
  'eventType',
  'actorType',
  'tenantId',
  'projectId',
  'resourceType',
  'resourceId',
  'environment',
  'traceId',
  'source',
  'schemaVersion',
  'metadataEncoding',
  'retentionClass',
  'expiresAt',
]);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveDateRange(from?: Date, to?: Date): Pick<QueryAuditParams, 'startTime' | 'endTime'> {
  return {
    startTime: from ?? new Date(0),
    endTime: to ?? new Date(),
  };
}

function stripCanonicalMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !CANONICAL_METADATA_KEYS.has(key)),
  );
}

function mapAuditLogToAdminEntry(log: AuditLog): AuditEntry {
  const metadata = stripCanonicalMetadata(log.metadata ?? {});

  return {
    timestamp: log.timestamp,
    actor: log.actor,
    actorRole: asString(metadata.actorRole) ?? log.actorType ?? 'unknown',
    action: log.action as AdminAction,
    target: asString(metadata.target) ?? log.resourceId,
    environment: log.environment,
    ipAddress: log.ipAddress,
    metadata,
  };
}

export async function queryAdminAuditLogsFromClickHouse(filters?: {
  actor?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  tenantId?: string;
  scope?: AdminAuditReadScope;
}): Promise<AuditEntry[]> {
  const scope = filters?.scope ?? 'platform';
  const queryParams: QueryAuditParams = {
    ...resolveDateRange(filters?.from, filters?.to),
    limit: filters?.limit ?? 50,
  };

  if (scope === 'tenant') {
    if (!filters?.tenantId) {
      throw new Error('tenantId is required for tenant-scoped admin audit reads');
    }

    queryParams.tenantId = filters.tenantId;
  }

  if (filters?.actor) {
    queryParams.actor = filters.actor;
  }

  if (filters?.action) {
    queryParams.actions = [filters.action];
  }

  const result = isInMemoryAuditTestBackendEnabled()
    ? await queryInMemoryAuditTestLogs(queryParams)
    : await new ClickHouseAuditReader(getClickHouseClient(), {
        ...(scope === 'tenant'
          ? {
              tenantId: filters?.tenantId,
              requireTenantId: true,
            }
          : {
              requireTenantId: false,
            }),
      }).query(queryParams);
  return result.logs.map((log) => mapAuditLogToAdminEntry(log));
}
