/**
 * Audit Logger
 *
 * Logs admin access events and queries audit history.
 * This admin dashboard is read-only — mutation audit trails
 * live in Git commits and ArgoCD sync history.
 */

import { randomUUID } from 'node:crypto';
import { publishAdminAuditPipelineEvent } from './admin-audit-pipeline-writer';
import {
  queryAdminAuditLogsFromClickHouse,
  type AdminAuditReadScope,
} from './admin-clickhouse-audit-reader';

export type AdminAction =
  | 'config_view'
  | 'secret_list'
  | 'secret_create'
  | 'secret_update'
  | 'secret_delete'
  | 'secret_rotate'
  | 'compat_binding_create'
  | 'compat_binding_update'
  | 'compat_binding_disable'
  | 'compat_binding_enable'
  | 'compat_binding_delete'
  | 'platform_admin_grant'
  | 'platform_admin_revoke'
  | 'platform_domain_add'
  | 'platform_domain_revoke'
  | 'platform_email_allow'
  | 'platform_email_revoke';

export interface AuditEntry {
  timestamp: Date;
  actor: string;
  actorRole: string;
  action: AdminAction;
  target: string;
  environment?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

type Environment = 'dev' | 'staging' | 'production';

function writeStructuredAuditLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  metadata: Record<string, unknown>,
): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(
    `${JSON.stringify({
      level,
      module: 'admin-audit-logger',
      message,
      timestamp: new Date().toISOString(),
      ...metadata,
    })}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function asEnvironment(value: unknown): Environment | null {
  if (value === 'dev' || value === 'staging' || value === 'production') {
    return value;
  }
  return null;
}

function inferResourceType(action: AdminAction): string | null {
  if (action.startsWith('secret_')) {
    return 'secret';
  }
  if (action.startsWith('config_')) {
    return 'config';
  }
  if (action.startsWith('platform_admin')) {
    return 'platform_admin';
  }
  if (action.startsWith('platform_domain')) {
    return 'platform_domain';
  }
  if (action.startsWith('platform_email')) {
    return 'platform_email';
  }
  return null;
}

function inferRetentionClass(action: AdminAction): 'default' | 'crud' {
  if (
    action.includes('create') ||
    action.includes('update') ||
    action.includes('delete') ||
    action.includes('rotate') ||
    action.startsWith('platform_')
  ) {
    return 'crud';
  }
  return 'default';
}

function buildAdminAuditPipelineEvent(entry: AuditEntry): Record<string, unknown> {
  const metadata = entry.metadata ?? {};
  const tenantId = asString(metadata.tenantId);
  const projectId = asString(metadata.projectId);
  const resourceType = asString(metadata.resourceType) ?? inferResourceType(entry.action);
  const resourceId = asString(metadata.resourceId) ?? entry.target;
  const environment = asEnvironment(entry.environment ?? metadata.environment);
  const traceId = asString(metadata.traceId);
  const retentionClass = inferRetentionClass(entry.action);

  return {
    auditId: randomUUID(),
    stream: 'shared',
    schemaVersion: 2,
    timestamp: entry.timestamp,
    source: 'admin',
    eventType: entry.action,
    action: entry.action,
    actorId: entry.actor,
    actorType: 'admin',
    tenantId,
    projectId,
    resourceType,
    resourceId,
    environment,
    traceId,
    ipAddress: entry.ipAddress ?? null,
    userAgent: null,
    metadata: {
      ...metadata,
      target: entry.target,
      actorRole: entry.actorRole,
    },
    metadataEncoding: 'object',
    retentionClass,
    expiresAt: null,
    oldValue: null,
    newValue: null,
  };
}

/**
 * Log an admin access event to the AuditLog collection.
 * Falls back to structured app logging if MongoDB is unavailable.
 */
export async function logAdminAction(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
  const fullEntry: AuditEntry = {
    ...entry,
    timestamp: new Date(),
  };

  writeStructuredAuditLog('info', 'Admin audit action recorded', {
    action: fullEntry.action,
    target: fullEntry.target,
    actor: fullEntry.actor,
    ipAddress: fullEntry.ipAddress ?? 'unknown',
  });

  try {
    publishAdminAuditPipelineEvent(
      buildAdminAuditPipelineEvent(fullEntry),
      asString(fullEntry.metadata?.tenantId),
    );
  } catch (err) {
    writeStructuredAuditLog('error', 'Admin audit pipeline publish failed', {
      action: fullEntry.action,
      target: fullEntry.target,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
}

/**
 * Query audit entries from the database.
 */
export async function queryAuditLog(filters?: {
  actor?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  tenantId?: string;
  scope?: AdminAuditReadScope;
}): Promise<AuditEntry[]> {
  try {
    return await queryAdminAuditLogsFromClickHouse(filters);
  } catch (err) {
    writeStructuredAuditLog('error', 'Failed to query admin audit events', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
