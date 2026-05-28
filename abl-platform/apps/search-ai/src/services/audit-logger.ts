/**
 * Audit Logger Service
 *
 * Centralized service for logging sensitive operations.
 * Used for compliance, security monitoring, and incident investigation.
 */

import { createLogger, type AuditLog } from '@abl/compiler/platform';
import {
  buildSearchAIAuditPipelineEvent,
  publishSearchAIAuditPipelineEvent,
} from './search-ai-audit-pipeline-writer.js';
import { querySearchAIAuditLogsFromClickHouse } from './search-ai-clickhouse-audit-reader.js';

const logger = createLogger('audit-logger');

/** Convert unknown error to loggable Record */
function errorToData(error: unknown): Record<string, unknown> {
  return { error: error instanceof Error ? error.message : String(error) };
}

interface AuditLogEntry {
  eventType: string;
  tenantId: string;
  userId: string;
  resourceType: string;
  resourceId: string;
  action: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Logs an audit event to the shared audit pipeline
 */
export async function logAuditEvent(entry: AuditLogEntry): Promise<void> {
  try {
    const event = buildSearchAIAuditPipelineEvent({
      eventType: entry.eventType,
      action: `${entry.resourceType}.${entry.action}`,
      actorId: entry.userId,
      actorType: 'user',
      tenantId: entry.tenantId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      metadata: {
        eventType: entry.eventType,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        ...entry.metadata,
      },
    });

    publishSearchAIAuditPipelineEvent(event, entry.tenantId);

    logger.info('Audit event logged', {
      eventType: entry.eventType,
      tenantId: entry.tenantId,
      userId: entry.userId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      action: entry.action,
    });
  } catch (error) {
    // Audit logging failure should not break the main operation
    logger.error('Failed to log audit event', errorToData(error));
  }
}

/**
 * Logs custom domain creation
 */
export async function logCustomDomainCreated(params: {
  tenantId: string;
  userId: string;
  domainId: string;
  domainName: string;
  industry: string;
  generatedByLLM: boolean;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  await logAuditEvent({
    eventType: 'custom_domain_created',
    tenantId: params.tenantId,
    userId: params.userId,
    resourceType: 'custom_domain',
    resourceId: params.domainId,
    action: 'create',
    metadata: {
      domainName: params.domainName,
      industry: params.industry,
      generatedByLLM: params.generatedByLLM,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Logs custom domain access (read)
 */
export async function logCustomDomainAccessed(params: {
  tenantId: string;
  userId: string;
  domainId: string;
  domainName: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  await logAuditEvent({
    eventType: 'custom_domain_accessed',
    tenantId: params.tenantId,
    userId: params.userId,
    resourceType: 'custom_domain',
    resourceId: params.domainId,
    action: 'read',
    metadata: {
      domainName: params.domainName,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Logs custom domain deletion
 */
export async function logCustomDomainDeleted(params: {
  tenantId: string;
  userId: string;
  domainId: string;
  domainName: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  await logAuditEvent({
    eventType: 'custom_domain_deleted',
    tenantId: params.tenantId,
    userId: params.userId,
    resourceType: 'custom_domain',
    resourceId: params.domainId,
    action: 'delete',
    metadata: {
      domainName: params.domainName,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Logs taxonomy refinement
 */
export async function logTaxonomyRefined(params: {
  tenantId: string;
  userId: string;
  taxonomyId: string;
  indexId: string;
  refinementAction: string;
  affectedDocCount: number;
  estimatedCost: number;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  await logAuditEvent({
    eventType: 'taxonomy_refined',
    tenantId: params.tenantId,
    userId: params.userId,
    resourceType: 'taxonomy',
    resourceId: params.taxonomyId,
    action: 'update',
    metadata: {
      indexId: params.indexId,
      refinementAction: params.refinementAction,
      affectedDocCount: params.affectedDocCount,
      estimatedCost: params.estimatedCost,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Logs taxonomy rollback
 */
export async function logTaxonomyRolledBack(params: {
  tenantId: string;
  userId: string;
  taxonomyId: string;
  indexId: string;
  targetVersion: string;
  rollbackReason: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  await logAuditEvent({
    eventType: 'taxonomy_rolled_back',
    tenantId: params.tenantId,
    userId: params.userId,
    resourceType: 'taxonomy',
    resourceId: params.taxonomyId,
    action: 'update',
    metadata: {
      indexId: params.indexId,
      targetVersion: params.targetVersion,
      rollbackReason: params.rollbackReason,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Retrieves audit logs for a specific resource
 */
export async function getAuditLogsForResource(params: {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  limit?: number;
}): Promise<AuditLog[]> {
  return querySearchAIAuditLogsFromClickHouse({
    tenantId: params.tenantId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    limit: params.limit || 100,
  });
}

/**
 * Retrieves audit logs for a specific user
 */
export async function getAuditLogsForUser(params: {
  tenantId: string;
  userId: string;
  limit?: number;
}): Promise<AuditLog[]> {
  return querySearchAIAuditLogsFromClickHouse({
    tenantId: params.tenantId,
    actor: params.userId,
    limit: params.limit || 100,
  });
}

/**
 * Retrieves recent audit logs for a tenant
 */
export async function getRecentAuditLogs(params: {
  tenantId: string;
  eventType?: string;
  limit?: number;
}): Promise<AuditLog[]> {
  return querySearchAIAuditLogsFromClickHouse({
    tenantId: params.tenantId,
    eventType: params.eventType,
    limit: params.limit || 100,
  });
}
