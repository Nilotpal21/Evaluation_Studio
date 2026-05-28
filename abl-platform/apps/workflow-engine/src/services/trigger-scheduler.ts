/**
 * TriggerScheduler
 *
 * BullMQ-based scheduler for cron and polling triggers.
 * When a job fires, it loads the trigger registration from MongoDB,
 * and starts a workflow execution via Restate.
 */

import { Queue, Worker, type Job } from 'bullmq';
import {
  createBullMQPair,
  BULLMQ_CLUSTER_SAFE_PREFIX,
  type BullMQConnectionPair,
  type Redis,
  type RedisClient,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import crypto from 'node:crypto';
import { resolveWorkflowDefinition } from '../lib/version-resolution.js';
import { buildWorkflowExecutionPayload } from '../lib/execution-payload.js';
import { environmentsMatch } from './trigger-engine.js';

const log = createLogger('workflow-engine:trigger-scheduler');

const QUEUE_NAME = 'workflow-triggers';

export interface TriggerJobData {
  registrationId: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  type: 'cron' | 'polling' | 'once';
  workflowVersionId?: string;
  environment?: string;
}

export interface TriggerSchedulerDeps {
  triggerModel: {
    findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null>;
  };
  workflowModel: {
    findOne(filter: Record<string, unknown>): Promise<{
      _id: string;
      name: string;
      steps?: unknown[];
      nodes?: { id: string; nodeType: string; name: string; config?: Record<string, unknown> }[];
      edges?: { id: string; source: string; sourceHandle?: string; target: string }[];
    } | null>;
  };
  restateClient: {
    startWorkflow(executionId: string, input: Record<string, unknown>): Promise<void>;
  };
  /**
   * Optional: WorkflowVersion model for the fire-time version cascade.
   * `find` is required for semver-desc default resolution in production; older
   * tests stub only `findOne` and that still works because the cascade falls
   * through to the draft/working-copy tiers.
   */
  workflowVersionModel?: {
    findOne(filter: Record<string, unknown>): { lean(): Promise<Record<string, unknown> | null> };
    find?(filter: Record<string, unknown>): { lean(): Promise<Record<string, unknown>[]> };
  };
  /**
   * Optional: Deployment model for environment-based version resolution. When
   * omitted the cascade skips the deployment tier.
   */
  deploymentModel?: {
    findOne(filter: Record<string, unknown>): {
      sort(sort: Record<string, number>): {
        lean(): Promise<Record<string, unknown> | null>;
      };
    };
  };
  /**
   * Optional: override createBullMQPair for testing without module mocking.
   * Injected in tests so the constructor can succeed with a fake Redis handle.
   */
  createBullMQPairFn?: (handle: RedisConnectionHandle) => BullMQConnectionPair;
}

export class TriggerScheduler {
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly bullMQPair: BullMQConnectionPair;
  private readonly redis: RedisClient;

  constructor(
    redisOrHandle: Redis | RedisConnectionHandle,
    private readonly deps: TriggerSchedulerDeps,
  ) {
    // Accept either a raw Redis client (legacy callers) or a connection handle
    // (preferred — cluster-aware). The handle path uses createBullMQPair, which
    // builds fresh Cluster instances from seed nodes in cluster mode.
    const handle: RedisConnectionHandle =
      'client' in redisOrHandle
        ? (redisOrHandle as RedisConnectionHandle)
        : {
            client: redisOrHandle as RedisClient,
            isReady: () => (redisOrHandle as Redis).status === 'ready',
            duplicate: (overrides = {}) =>
              (redisOrHandle as Redis).duplicate({
                maxRetriesPerRequest:
                  overrides.maxRetriesPerRequest === undefined
                    ? null
                    : overrides.maxRetriesPerRequest,
              }),
            disconnect: async () => {
              /* legacy caller manages its own client lifecycle */
            },
          };
    this.redis = handle.client;
    this.bullMQPair = (deps.createBullMQPairFn ?? createBullMQPair)(handle);

    this.queue = new Queue(QUEUE_NAME, {
      connection: this.bullMQPair.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });

    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job<TriggerJobData>) => {
        await this.processJob(job);
      },
      {
        connection: this.bullMQPair.workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: 10,
      },
    );

    this.worker.on('failed', (job: Job<TriggerJobData> | undefined, err: Error) => {
      log.warn('Trigger job failed', {
        jobId: job?.id,
        registrationId: job?.data?.registrationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('TriggerScheduler initialized');
  }

  /**
   * Schedule a cron trigger as a repeatable BullMQ job.
   */
  async scheduleCron(
    registrationId: string,
    data: TriggerJobData,
    cronExpression: string,
    tz?: string,
  ): Promise<void> {
    await this.queue.add(`cron:${registrationId}`, data, {
      repeat: {
        pattern: cronExpression,
        ...(tz ? { tz } : {}),
      },
      jobId: registrationId,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
    log.info('Cron trigger scheduled', { registrationId, cronExpression, tz });
  }

  /**
   * Schedule a polling trigger as a repeatable BullMQ job.
   */
  async schedulePolling(
    registrationId: string,
    data: TriggerJobData,
    intervalMs: number,
  ): Promise<void> {
    await this.queue.add(`poll:${registrationId}`, data, {
      repeat: {
        every: intervalMs,
      },
      jobId: registrationId,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
    log.info('Polling trigger scheduled', { registrationId, intervalMs });
  }

  /**
   * Schedule a one-shot trigger that fires once after a delay.
   */
  async scheduleOnce(registrationId: string, data: TriggerJobData, delayMs: number): Promise<void> {
    await this.queue.add(`once:${registrationId}`, data, {
      delay: delayMs,
      jobId: registrationId,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
    log.info('One-shot trigger scheduled', { registrationId, delayMs });
  }

  /**
   * Remove a scheduled trigger job.
   *
   * Covers all three scheduling strategies used by this class:
   *
   *   1. `scheduleCron` + `schedulePolling` — repeatable jobs keyed by
   *      `registrationId`. Removed via `removeRepeatableByKey(job.key)`.
   *
   *   2. `scheduleOnce` — delayed one-shot jobs keyed by `registrationId`
   *      (via the `jobId` option, not the `repeat` option). These are NOT
   *      returned by `getRepeatableJobs()`, so pausing or deleting a
   *      one-shot trigger used to leave a phantom delayed job that would
   *      still fire — finding ABLP-2 #6. `queue.remove(registrationId)`
   *      removes waiting / delayed / active jobs by `jobId`.
   *
   * `queue.remove` returns a falsy value when no job matches, so it's safe
   * to always call after the repeatable sweep; it's idempotent for triggers
   * that were cron or polling only.
   */
  async unschedule(registrationId: string): Promise<void> {
    // Remove all repeatable jobs matching this registration (cron / polling).
    const repeatableJobs = await this.queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      if (job.id === registrationId) {
        await this.queue.removeRepeatableByKey(job.key);
      }
    }

    // Remove any one-shot (delayed) job scheduled via `scheduleOnce`. BullMQ's
    // `Queue.remove` resolves to `0` when nothing matches — surface unexpected
    // errors (e.g., connection failure) rather than swallowing them, but
    // accept the "no matching job" case as a no-op.
    try {
      await this.queue.remove(registrationId);
    } catch (err) {
      log.warn('Failed to remove one-shot trigger job during unschedule', {
        registrationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('Trigger unscheduled', { registrationId });
  }

  /**
   * Graceful shutdown — close worker and queue.
   */
  async shutdown(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    // BullMQ .close() does not disconnect the underlying Redis connections.
    // Explicitly disconnect duplicated connections to prevent leaks.
    this.bullMQPair.disconnect();
    log.info('TriggerScheduler shut down');
  }

  /**
   * Process a trigger job — loads registration, workflow, and starts execution.
   */
  private async processJob(job: Job<TriggerJobData>): Promise<void> {
    const { registrationId, tenantId, projectId, workflowId, type } = job.data;

    // Verify trigger is still active
    const trigger = await this.deps.triggerModel.findOne({
      _id: registrationId,
      tenantId,
      status: 'active',
    });
    if (!trigger) {
      log.warn('Trigger no longer active, skipping', { registrationId });
      return;
    }

    // Environment gate (FR-17): skip if event/trigger environments don't match
    if (!environmentsMatch(job.data.environment, trigger.environment as string | undefined)) {
      log.warn('Cron trigger skipped — environment mismatch', {
        registrationId,
        jobEnvironment: job.data.environment ?? null,
        triggerEnvironment: (trigger.environment as string) ?? null,
      });
      return;
    }

    // Always load the workflow doc — needed for `workflowName` in the Restate
    // payload and for the working-copy fallback tier.
    const workflow = await this.deps.workflowModel.findOne({
      _id: workflowId,
      tenantId,
      projectId,
    });
    if (!workflow) {
      log.warn('Workflow not found for trigger', { registrationId, workflowId });
      return;
    }

    // Full fire-time version cascade (pinned → deployment → semver-desc →
    // draft → working copy). Mirrors `fireWebhookTrigger` so cron-fired
    // executions cannot silently run a different definition than webhook
    // triggers for the same workflow.
    const resolved = await resolveWorkflowDefinition(
      {
        workflow: {
          _id: workflowId,
          name: workflow.name,
          steps: workflow.steps,
          nodes: workflow.nodes,
          edges: workflow.edges,
        },
        tenantId,
        projectId,
        pinnedVersionId: job.data.workflowVersionId,
        environment: job.data.environment ?? (trigger.environment as string | undefined),
        logContext: { registrationId },
      },
      {
        workflowVersionModel: this.deps.workflowVersionModel,
        deploymentModel: this.deps.deploymentModel,
      },
    );

    const executionId = crypto.randomUUID();
    await this.deps.restateClient.startWorkflow(
      executionId,
      buildWorkflowExecutionPayload({
        workflowId,
        workflowName: workflow.name,
        tenantId,
        projectId,
        triggerType: 'cron',
        triggerPayload: {
          ...(trigger.config as Record<string, unknown>),
          scheduledAt: new Date().toISOString(),
        },
        triggerMetadata: {
          registrationId,
          firedAt: new Date().toISOString(),
          jobId: job.id,
          ...(trigger.config && (trigger.config as Record<string, unknown>).callbackUrl
            ? { callbackUrl: (trigger.config as Record<string, unknown>).callbackUrl }
            : {}),
        },
        steps: resolved.steps,
        nameToIdMap: resolved.nameToIdMap,
        outputMappings: resolved.outputMappings,
        outputMappingsByEndNodeId: resolved.outputMappingsByEndNodeId,
        startInputVariables: resolved.startInputVariables,
        inDegreeMap: resolved.inDegreeMap,
        edgeMap: resolved.edgeMap,
        workflowVersion: resolved.workflowVersion,
        workflowVersionId: resolved.workflowVersionId,
        deploymentId: resolved.deploymentId,
      }),
    );

    log.info('Scheduled trigger fired', {
      registrationId,
      executionId,
      type,
      workflowId,
      workflowVersion: resolved.workflowVersion,
      resolutionTier: resolved.tier,
    });

    // One-shot triggers should be paused after firing
    if (type === 'once') {
      await this.deps.triggerModel.findOneAndUpdate(
        { _id: registrationId, tenantId },
        { $set: { status: 'paused' } },
      );
      log.info('One-shot trigger paused after firing', { registrationId });
    }
  }
}
