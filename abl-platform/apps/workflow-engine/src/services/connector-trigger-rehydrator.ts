/**
 * Connector Trigger Rehydrator
 *
 * At workflow-engine boot, re-enqueues BullMQ polling jobs for every active
 * connector-backed trigger found in MongoDB. Required because:
 *
 * - BullMQ repeatable-job state lives in Redis. A Redis restart / flush
 *   loses the schedule but not the trigger registration document. Without
 *   rehydrate, those registrations look active in Studio but never fire.
 * - The unified-trigger-types refactor (commit 27f03ee221, 2026-04-14)
 *   temporarily broke `TriggerEngine.register()` for connector triggers.
 *   Registrations created during that window exist in Mongo but have no
 *   BullMQ job. The fix (commit 33db1df381) only helps NEW registrations;
 *   rehydrate is what heals the backlog.
 *
 * Idempotent: BullMQ `jobId: poll:<registrationId>` dedupes re-adds, so
 * calling this on every boot is safe even when all jobs already exist.
 *
 * Per-registration errors (bad connector name, missing connection, etc.)
 * are logged and skipped — a single malformed doc must not block the
 * rest of the tenant's triggers.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('workflow-engine:connector-rehydrate');

/** Subset of TriggerRegistration fields the rehydrator reads. */
export interface ConnectorTriggerDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  status: string;
  config: Record<string, unknown>;
  workflowVersionId?: string;
  environment?: string;
}

export interface RehydrateDeps {
  triggerModel: {
    find(filter: Record<string, unknown>): {
      lean(): Promise<ConnectorTriggerDoc[]>;
    };
  };
  connectorTriggerEngine: {
    registerTrigger(input: {
      registrationId: string;
      tenantId: string;
      projectId: string;
      workflowId: string;
      connectorName: string;
      triggerName: string;
      connectionId: string;
      pollingIntervalMs?: number;
      cronExpression?: string;
      workflowVersionId?: string;
      environment?: string;
    }): Promise<{ triggerType: string }>;
  };
}

export interface RehydrateResult {
  /** Registrations that completed registerTrigger without throwing. */
  rehydrated: number;
  /** Registrations missing required config (connectorName/triggerName/connectionId). */
  skipped: number;
  /** Registrations where registerTrigger threw. */
  failed: number;
}

/**
 * Scan active connector-backed trigger registrations and re-enqueue their
 * scheduled jobs. Intended to be called once at workflow-engine boot after
 * `connectorTriggerEngine` and the polling worker are wired.
 */
export async function rehydrateConnectorTriggers(deps: RehydrateDeps): Promise<RehydrateResult> {
  const registrations = await deps.triggerModel
    .find({
      status: 'active',
      'config.connectorName': { $exists: true, $ne: null },
    })
    .lean();

  let rehydrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const reg of registrations) {
    const connectorName = reg.config.connectorName as string | undefined;
    const triggerName = reg.config.triggerName as string | undefined;
    const connectionId = reg.config.connectionId as string | undefined;

    if (!connectorName || !triggerName || !connectionId) {
      skipped++;
      log.warn('Skipping connector trigger rehydrate — missing required config', {
        registrationId: reg._id,
        hasConnectorName: Boolean(connectorName),
        hasTriggerName: Boolean(triggerName),
        hasConnectionId: Boolean(connectionId),
      });
      continue;
    }

    try {
      await deps.connectorTriggerEngine.registerTrigger({
        registrationId: reg._id,
        tenantId: reg.tenantId,
        projectId: reg.projectId,
        workflowId: reg.workflowId,
        connectorName,
        triggerName,
        connectionId,
        pollingIntervalMs: reg.config.pollingIntervalMs as number | undefined,
        cronExpression: reg.config.cronExpression as string | undefined,
        workflowVersionId: reg.workflowVersionId,
        environment: reg.environment,
      });
      rehydrated++;
    } catch (err) {
      failed++;
      log.error('Failed to rehydrate connector trigger', {
        registrationId: reg._id,
        connectorName,
        triggerName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Connector trigger rehydrate complete', {
    rehydrated,
    skipped,
    failed,
    total: registrations.length,
  });

  return { rehydrated, skipped, failed };
}
