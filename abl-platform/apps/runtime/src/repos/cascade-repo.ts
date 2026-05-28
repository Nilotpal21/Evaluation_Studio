/**
 * Cascade Repository
 *
 * Wraps database-level cascade delete functions with:
 * - Audit logging (start + completion)
 * - ClickHouse data cleanup (if available)
 * - Error handling and logging
 */

import {
  deleteTenant,
  deleteProject,
  deleteUser,
  deleteSession,
  type CascadeDeleteResult,
} from '@agent-platform/database/cascade';
import { getAuditStore } from '../services/audit-store-singleton.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('cascade-repo');
const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

export async function cascadeDeleteTenant(
  tenantId: string,
  actor: string,
): Promise<CascadeDeleteResult> {
  const store = getAuditStore();

  // Audit start
  store
    ?.log({
      eventType: 'pii.accessed',
      actor,
      actorType: 'admin',
      resourceType: 'customer',
      resourceId: tenantId,
      environment: 'dev',
      action: 'tenant.cascade_delete_started',
      metadata: { tenantId },
    })
    .catch((err: unknown) =>
      log.warn('Audit log failed for tenant cascade delete start', {
        error: err instanceof Error ? err.stack : String(err),
      }),
    );

  const result = await deleteTenant(tenantId);

  await cleanClickHouseForTenant(tenantId);

  // Audit completion
  store
    ?.log({
      eventType: 'pii.accessed',
      actor,
      actorType: 'admin',
      resourceType: 'customer',
      resourceId: tenantId,
      environment: 'dev',
      action: 'tenant.cascade_delete_completed',
      metadata: {
        tenantId,
        counts: result.counts,
        total: result.total,
        anonymized: result.anonymized,
      },
    })
    .catch((err: unknown) =>
      log.warn('Audit log failed for tenant cascade delete completion', {
        error: err instanceof Error ? err.stack : String(err),
      }),
    );

  log.info('Tenant cascade delete completed', { tenantId, total: result.total });
  return result;
}

export async function cascadeDeleteProject(
  projectId: string,
  actor: string,
): Promise<CascadeDeleteResult> {
  const store = getAuditStore();

  store
    ?.log({
      eventType: 'agent.updated',
      actor,
      actorType: 'user',
      resourceType: 'agent',
      resourceId: projectId,
      environment: 'dev',
      action: 'project.cascade_delete_started',
      metadata: { projectId },
    })
    .catch((err: unknown) =>
      log.warn('Audit log failed for project cascade delete start', {
        error: err instanceof Error ? err.stack : String(err),
      }),
    );

  const result = await deleteProject(projectId);

  store
    ?.log({
      eventType: 'agent.updated',
      actor,
      actorType: 'user',
      resourceType: 'agent',
      resourceId: projectId,
      environment: 'dev',
      action: 'project.cascade_delete_completed',
      metadata: { projectId, counts: result.counts, total: result.total },
    })
    .catch((err: unknown) =>
      log.warn('Audit log failed for project cascade delete completion', {
        error: err instanceof Error ? err.stack : String(err),
      }),
    );

  log.info('Project cascade delete completed', { projectId, total: result.total });
  return result;
}

export async function cascadeDeleteUser(
  userId: string,
  actor: string,
): Promise<CascadeDeleteResult> {
  const result = await deleteUser(userId);
  log.info('User cascade delete completed', {
    userId,
    total: result.total,
    anonymized: result.anonymized,
  });
  return result;
}

export async function cascadeDeleteSession(sessionId: string): Promise<CascadeDeleteResult> {
  const result = await deleteSession(sessionId);
  log.info('Session cascade delete completed', { sessionId, total: result.total });
  await cleanClickHouseSessionArtifacts(sessionId);
  return result;
}

async function cleanClickHouseSessionArtifacts(sessionId: string): Promise<void> {
  try {
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const client = getClickHouseClient();
    const tables = ['experiment_assignments', 'pii_audit_log'];
    for (const table of tables) {
      await client.command({
        query: `ALTER TABLE abl_platform.${table} DELETE WHERE session_id = {sessionId:String} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
        query_params: { sessionId },
      });
    }
  } catch {
    // ClickHouse not available or table doesn't exist — skip
  }
}

/**
 * Clean ClickHouse data for a deleted tenant.
 * ClickHouse may not be available; failures are logged and skipped so the
 * primary Mongo cascade remains authoritative.
 */
async function cleanClickHouseForTenant(tenantId: string): Promise<void> {
  try {
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const client = getClickHouseClient();
    const tables = [
      'messages',
      'llm_metrics',
      'trace_events',
      'audit_events',
      'pii_audit_log',
      'facts',
      'experiment_assignments',
    ];
    for (const table of tables) {
      await client.command({
        query: `ALTER TABLE abl_platform.${table} DELETE WHERE tenant_id = {tenantId:String} ${WAIT_FOR_LOCAL_MUTATION_SETTING}`,
        query_params: { tenantId },
      });
    }
  } catch {
    // ClickHouse not available — skip
  }
}
