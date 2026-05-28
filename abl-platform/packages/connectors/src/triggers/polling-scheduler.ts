/**
 * Polling Scheduler
 *
 * Manages BullMQ repeatable jobs for polling-based triggers.
 * On each poll: loads registration → resolves connector → calls trigger.run()
 * with cursor state → deduplicates items by content hash → invokes Restate
 * per new item → updates cursor.
 */

import crypto from 'crypto';
import { createLogger } from '../logger.js';
import type { ConnectorRegistry } from '../registry.js';
import type { KeyValueStore } from '../types.js';
import type {
  TriggerRegistrationModel,
  RestateIngressClient,
  TriggerQueue,
  TriggerJobData,
} from './types.js';
import {
  DEFAULT_POLLING_INTERVAL_MS,
  MIN_POLLING_INTERVAL_MS,
  MAX_POLLING_INTERVAL_MS,
  TRIGGER_AUTO_PAUSE_THRESHOLD,
} from './constants.js';

const log = createLogger('polling-scheduler');

/** Resolves decrypted auth credentials for a connection */
export interface PollingAuthResolver {
  resolveConnectionAuth(opts: {
    connectionId: string;
    tenantId: string;
    projectId: string;
  }): Promise<Record<string, unknown>>;
}

/**
 * Resolves the workflow definition needed to start a Restate execution.
 *
 * Returns the canonical wire-ready shape — legacy `steps` workflows and
 * canvas-authored (`nodes`+`edges`) workflows both produce the same result.
 * The concrete implementation in `apps/workflow-engine/src/index.ts` runs
 * `convertCanvasToSteps(..., { full: true })` for canvas workflows so
 * `outputMappings` and `nameToIdMap` are populated; legacy `steps`
 * workflows can omit those fields (undefined is forwarded).
 */
export interface WorkflowDefinitionResolver {
  resolve(opts: { workflowId: string; tenantId: string; projectId: string }): Promise<{
    workflowName: string;
    steps: unknown[];
    /** Canvas conversion output mappings — omit for legacy `steps` workflows. */
    outputMappings?: unknown;
    /** Canvas name→id map — omit for legacy `steps` workflows. */
    nameToIdMap?: Record<string, string>;
  } | null>;
}

/** Dependencies for the polling scheduler */
export interface PollingSchedulerDeps {
  registry: ConnectorRegistry;
  registrationModel: TriggerRegistrationModel;
  restateClient: RestateIngressClient;
  queue: TriggerQueue;
  storeFactory: (connectionId: string) => KeyValueStore;
  authResolver?: PollingAuthResolver;
  workflowResolver?: WorkflowDefinitionResolver;
  /**
   * Optional file writer — stores attachment bytes and returns a public download URL.
   * When absent, the AP adapter falls back to base64 data URIs.
   */
  fileWriter?: (fileName: string, data: Buffer, mimeType: string) => Promise<string>;
}

/**
 * Register a polling trigger as a BullMQ repeatable job.
 */
export async function registerPollingTrigger(
  registration: {
    _id: string;
    tenantId: string;
    projectId: string;
    connectorName: string;
    triggerName: string;
    connectionId: string;
    pollingIntervalMs?: number;
    workflowVersionId?: string;
    environment?: string;
  },
  deps: PollingSchedulerDeps,
): Promise<void> {
  const intervalMs = clampInterval(registration.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS);

  await deps.queue.add(
    'poll-trigger',
    {
      registrationId: registration._id,
      tenantId: registration.tenantId,
      projectId: registration.projectId,
      connectorName: registration.connectorName,
      triggerName: registration.triggerName,
      connectionId: registration.connectionId,
      ...(registration.workflowVersionId
        ? { workflowVersionId: registration.workflowVersionId }
        : {}),
      ...(registration.environment ? { environment: registration.environment } : {}),
    },
    {
      repeat: { every: intervalMs },
      jobId: `poll:${registration._id}`,
    },
  );
}

/**
 * Remove a polling trigger's repeatable job.
 */
export async function deregisterPollingTrigger(
  registrationId: string,
  intervalMs: number,
  deps: Pick<PollingSchedulerDeps, 'queue'>,
): Promise<void> {
  await deps.queue.removeRepeatable('poll-trigger', {
    every: clampInterval(intervalMs),
    jobId: `poll:${registrationId}`,
  });
}

/**
 * Process a single polling job.
 * Called by the BullMQ worker processor.
 */
export async function processPollingJob(
  job: TriggerJobData,
  deps: PollingSchedulerDeps,
): Promise<void> {
  const registration = await deps.registrationModel.findOne({
    _id: job.registrationId,
    tenantId: job.tenantId,
    status: 'active',
  });

  if (!registration) return;

  const connector = await deps.registry.get(job.connectorName);
  const trigger = connector.triggers.find((t) => t.name === job.triggerName);
  if (!trigger) return;

  const store = deps.storeFactory(job.registrationId);

  try {
    // Resolve OAuth/API key credentials for this connection
    let auth: Record<string, unknown> = {};
    if (deps.authResolver) {
      auth = await deps.authResolver.resolveConnectionAuth({
        connectionId: job.connectionId,
        tenantId: job.tenantId,
        projectId: job.projectId,
      });
    }

    const lastRunData = await store.get<unknown>(`cursor:${job.registrationId}`);

    // Read user-configured trigger parameters from the registration config
    const triggerParams = (registration.config as Record<string, unknown>).triggerParams as
      | Record<string, unknown>
      | undefined;

    const items = await trigger.run({
      auth,
      tenantId: job.tenantId,
      projectId: job.projectId,
      connectionId: job.connectionId,
      store,
      lastRunData,
      propsValue: triggerParams,
      connectorName: job.connectorName,
      ...(deps.fileWriter ? { fileWriter: deps.fileWriter } : {}),
    });

    // Dedup window: at least 3× the poll interval so an item seen in one poll is
    // still remembered when the next poll fires. Floor at 15 min for fast intervals.
    const pollIntervalMs = clampInterval(
      registration.pollingIntervalMs ?? trigger.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
    );
    const dedupTtlMs = Math.max(pollIntervalMs * 3, 15 * 60 * 1000);

    // Deduplicate items by content hash
    const newItems = await deduplicateItems(items, job.registrationId, store, dedupTtlMs);

    if (newItems.length > 0) {
      log.info('Polling trigger found new items', {
        registrationId: job.registrationId,
        connectorName: job.connectorName,
        triggerName: job.triggerName,
        newCount: newItems.length,
      });
    }

    // Resolve workflow definition (name + steps, plus canvas wiring data
    // when the workflow is canvas-authored) for Restate.
    let workflowName = '';
    let steps: unknown[] = [];
    let outputMappings: unknown | undefined;
    let nameToIdMap: Record<string, string> | undefined;
    if (deps.workflowResolver && newItems.length > 0) {
      const wf = await deps.workflowResolver.resolve({
        workflowId: registration.workflowId,
        tenantId: registration.tenantId,
        projectId: registration.projectId,
      });
      if (!wf) {
        log.error('Workflow not found for polling trigger', {
          registrationId: job.registrationId,
          workflowId: registration.workflowId,
        });
        return;
      }
      workflowName = wf.workflowName;
      steps = wf.steps;
      outputMappings = wf.outputMappings;
      nameToIdMap = wf.nameToIdMap;
    }

    // Invoke Restate for each new item.
    // `triggerType: 'event'` classifies the run in the Monitor tab + audit
    // logs by the user-visible category — connector-backed triggers are
    // "events from an app". The BullMQ polling cadence is an internal
    // delivery detail, not the trigger category.
    for (const item of newItems) {
      const executionId = crypto.randomUUID();
      await deps.restateClient.startWorkflow(executionId, {
        workflowId: registration.workflowId,
        workflowName,
        ...(registration.workflowVersionId
          ? { workflowVersionId: registration.workflowVersionId }
          : {}),
        tenantId: registration.tenantId,
        projectId: registration.projectId,
        triggerType: 'event',
        triggerPayload: item as Record<string, unknown>,
        triggerMetadata: {
          connectorName: job.connectorName,
          triggerName: job.triggerName,
          registrationId: job.registrationId,
          firedAt: new Date().toISOString(),
        },
        steps,
        ...(outputMappings !== undefined ? { outputMappings } : {}),
        ...(nameToIdMap !== undefined ? { nameToIdMap } : {}),
      });
    }

    // Update cursor with latest run data
    if (items.length > 0) {
      await store.set(`cursor:${job.registrationId}`, items[items.length - 1]);
    }

    // Reset error counter on success
    await deps.registrationModel.findOneAndUpdate(
      { _id: job.registrationId, tenantId: job.tenantId },
      { $set: { lastFiredAt: new Date(), consecutiveErrors: 0 } },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? (err.stack ?? '') : '';
    log.error('Polling trigger failed', {
      registrationId: job.registrationId,
      connectorName: job.connectorName,
      triggerName: job.triggerName,
      error: errMsg,
      stack: errStack,
    });
    // Track consecutive errors
    const updated = await deps.registrationModel.findOneAndUpdate(
      { _id: job.registrationId, tenantId: job.tenantId },
      { $inc: { consecutiveErrors: 1 }, $set: { lastErrorAt: new Date() } },
      { new: true },
    );

    if (updated && updated.consecutiveErrors >= TRIGGER_AUTO_PAUSE_THRESHOLD) {
      await deps.registrationModel.findOneAndUpdate(
        { _id: job.registrationId, tenantId: job.tenantId },
        { $set: { status: 'error' } },
      );
    }
  }
}

/**
 * Deduplicate polling items by content hash.
 * Returns only items not seen in the dedup window.
 */
async function deduplicateItems(
  items: unknown[],
  registrationId: string,
  store: KeyValueStore,
  ttlMs: number,
): Promise<unknown[]> {
  const newItems: unknown[] = [];

  for (const item of items) {
    const hash = contentHash(item);
    const key = `dedup:${registrationId}:${hash}`;
    const seen = await store.get(key);

    if (!seen) {
      await store.set(key, '1', ttlMs);
      newItems.push(item);
    }
  }

  return newItems;
}

/** SHA-256 hash of JSON-serialized item for dedup */
function contentHash(item: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 16);
}

/** Clamp polling interval to safe range */
function clampInterval(ms: number): number {
  return Math.max(MIN_POLLING_INTERVAL_MS, Math.min(MAX_POLLING_INTERVAL_MS, ms));
}
