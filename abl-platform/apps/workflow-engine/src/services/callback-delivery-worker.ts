/**
 * Callback Delivery Worker
 *
 * BullMQ worker that delivers webhook callbacks to external URLs
 * after workflow completion. Uses HMAC-SHA256 signing for integrity.
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
import { buildSignatureHeaders } from '@agent-platform/shared-kernel/security';
import {
  SSRFError,
  assertUrlSafeForFetch,
  safeFetch,
} from '@agent-platform/shared-kernel/security/safe-fetch';
import { WorkflowExecution } from '@agent-platform/database/models';

const log = createLogger('workflow-engine:callback-delivery');

export const CALLBACK_QUEUE_NAME = 'workflow-callbacks';

export interface CallbackDeliveryDeps {
  webhookSecret: (tenantId: string, source?: string) => Promise<string>;
  /**
   * Tenant-scoped secret decryption. Invoked only for jobs that carry
   * {@link CallbackJobData.encryptedAccessToken}; the plaintext bearer token
   * lives on the stack for the duration of one `fetch` call and is never
   * logged or persisted.
   */
  decryptSecret: (ciphertext: string, tenantId: string) => Promise<string>;
  /**
   * Optional factory override for BullMQ connection pair — injected in tests
   * to avoid vi.mock of @agent-platform/redis (platform mock prohibition).
   * Production code uses the real createBullMQPair.
   */
  createBullMQPairFn?: (handle: RedisConnectionHandle) => BullMQConnectionPair;
}

export interface CallbackJobData {
  executionId: string;
  tenantId: string;
  callbackUrl: string;
  /**
   * Bearer token supplied by the caller (e.g. API-key clients using
   * `mode=async_push`), persisted as tenant-scoped ciphertext. The worker
   * decrypts immediately before setting `Authorization: Bearer <token>`;
   * Redis never holds the plaintext.
   */
  encryptedAccessToken?: string;
  /** Optional per-request callback signing secret (tenant-scoped ciphertext). */
  encryptedCallbackSecret?: string;
  source?: string;
  payload: {
    traceId: string;
    status: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
    executionId?: string;
    tenantId?: string;
    projectId?: string;
    sessionId?: string;
    workflowId?: string;
    workflowName?: string;
    source?: string;
  };
}

export class CallbackDeliveryWorker {
  readonly queue: Queue<CallbackJobData>;
  private readonly worker: Worker<CallbackJobData>;
  private readonly bullMQPair: BullMQConnectionPair;

  constructor(
    redisOrHandle: Redis | RedisConnectionHandle,
    private readonly deps: CallbackDeliveryDeps,
  ) {
    // Accept either a raw Redis client (legacy callers) or a connection handle
    // (preferred — cluster-aware via createBullMQPair).
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
    this.bullMQPair = (this.deps.createBullMQPairFn ?? createBullMQPair)(handle);

    this.queue = new Queue(CALLBACK_QUEUE_NAME, {
      connection: this.bullMQPair.queueConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: parseInt(process.env.CALLBACK_MAX_RETRIES ?? '3', 10),
        backoff: {
          type: 'exponential',
          delay: parseInt(process.env.CALLBACK_RETRY_BASE_MS ?? '1000', 10),
        },
      },
    });

    this.worker = new Worker(
      CALLBACK_QUEUE_NAME,
      async (job: Job<CallbackJobData>) => {
        await this.processJob(job);
      },
      {
        connection: this.bullMQPair.workerConnection,
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        lockDuration: 30000,
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, err) => {
      log.warn('Callback delivery failed', {
        jobId: job?.id,
        executionId: job?.data?.executionId,
        attempt: job?.attemptsMade,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    log.info('CallbackDeliveryWorker initialized');
  }

  private async processJob(job: Job<CallbackJobData>): Promise<void> {
    const { callbackUrl, tenantId, payload, executionId, encryptedAccessToken } = job.data;

    // SSRF check — uses the canonical shared-kernel DNS-pinning validator.
    try {
      await assertUrlSafeForFetch(callbackUrl);
    } catch (ssrfErr) {
      log.error('Callback URL blocked (SSRF protection)', {
        executionId,
        reason: ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr),
      });
      // Don't retry — permanent rejection (return without throwing)
      return;
    }

    // Resolve HMAC secret for this tenant unless the caller supplied a
    // per-request callback secret (used by parent workflows waiting on child
    // workflow-tool completion).
    const secret = job.data.encryptedCallbackSecret
      ? await this.deps.decryptSecret(job.data.encryptedCallbackSecret, tenantId)
      : await this.deps.webhookSecret(tenantId, job.data.source);

    // Build signed payload
    const bodyStr = JSON.stringify(payload);
    const signatureHeaders = buildSignatureHeaders(secret, bodyStr);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...signatureHeaders,
    };
    if (encryptedAccessToken) {
      // Decrypt into a local only — the plaintext never leaves this frame,
      // never touches disk, and the only externally visible surface is the
      // outbound `Authorization: Bearer …` header below.
      const bearer = await this.deps.decryptSecret(encryptedAccessToken, tenantId);
      headers['Authorization'] = `Bearer ${bearer}`;
    }

    // Deliver callback with 15s timeout
    let response: Response;
    try {
      response = await safeFetch(callbackUrl, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (err instanceof SSRFError || (err instanceof Error && err.name === 'SSRFError')) {
        log.error('Callback URL blocked during delivery (SSRF protection)', {
          executionId,
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      throw err;
    }

    if (!response.ok) {
      throw new Error(`Callback delivery failed: HTTP ${response.status} ${response.statusText}`);
    }

    // Update callback status on execution document
    await WorkflowExecution.findOneAndUpdate(
      { _id: executionId, tenantId },
      { $set: { 'triggerMetadata.callbackStatus': 'delivered' } },
    );

    log.info('Callback delivered', {
      executionId,
      attempt: job.attemptsMade,
    });
  }

  async shutdown(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    this.bullMQPair.disconnect();
    log.info('CallbackDeliveryWorker shut down');
  }
}
