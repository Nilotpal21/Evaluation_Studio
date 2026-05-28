/**
 * BullMQ worker for Agent Assist V1 async-push callback delivery.
 *
 * Queue: `agent-assist-callback`
 * DLQ:   `agent-assist-callback-dlq`
 *
 * Replays the V1 execution, signs the response with HMAC, and POSTs to the
 * caller's callback URL. Retries on transient failures; terminal failures
 * (4xx except 408/429) go straight to DLQ.
 *
 * See LLD Phase 4 and HLD §3 for the full design.
 */

import { createLogger } from '@abl/compiler/platform';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { safeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';
import {
  signCallbackPayload,
  resolveSigningSecret,
  SIGNATURE_HEADER,
} from '../services/agent-assist/callback-signer.js';
import {
  validateCallbackUrl,
  resolveValidationOptions,
  type CallbackUrlValidationOptions,
} from '../services/agent-assist/callback-url-validator.js';
import {
  emitCallbackScheduled,
  emitCallbackDelivered,
  emitCallbackFailed,
} from '../services/agent-assist/trace-events.js';
import type {
  AgentAssistExecutionInput,
  V1ExecuteResponse,
} from '../services/agent-assist/types.js';

const log = createLogger('agent-assist-worker');

// ─── Constants ──────────────────────────────────────────────────────────

const QUEUE_NAME = 'agent-assist-callback';
const DLQ_QUEUE_NAME = 'agent-assist-callback-dlq';
const CALLBACK_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 10;
const USER_AGENT = 'ABL-Agent-Assist-Compat/1';

/**
 * Per-job lock duration: covers worst-case LLM execution (~60s) + callback delivery (15s)
 * + network/margin. Set > executeTurn + CALLBACK_TIMEOUT_MS to avoid stalled-job re-processing.
 */
const WORKER_LOCK_DURATION_MS = 120_000;
const WORKER_MAX_STALLED_COUNT = 2;

/** HTTP status codes that are terminal (non-retryable) — 4xx except 408 and 429. */
function isTerminalHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// ─── Job Payload ────────────────────────────────────────────────────────

export interface AgentAssistCallbackJob {
  messageId: string;
  runId: string;
  tenantId: string;
  projectId: string;
  appId: string;
  envName: string;
  bindingId: string;
  callbackUrl: string;
  binding: {
    deploymentId?: string | null;
    apiKeyId?: string | null;
    runtimeBaseUrl?: string | null;
  };
  input: {
    executionInput: AgentAssistExecutionInput;
    source?: string;
    metadata?: Record<string, unknown>;
    userReference?: string;
    callerUserId?: string;
    callerApiKeyId?: string;
  };
}

// ─── DLQ Record ─────────────────────────────────────────────────────────

export interface DLQRecord {
  runId: string;
  jobPayload: AgentAssistCallbackJob;
  lastError: {
    code: string;
    message: string;
    statusCode?: number;
    elapsedMs?: number;
  };
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
}

// ─── Dependencies (DI) ─────────────────────────────────────────────────

export interface CallbackWorkerDeps {
  /**
   * Execute a turn and produce the V1 response envelope.
   * Injected to decouple the worker from the execution bridge.
   */
  executeTurnAndBuildEnvelope: (job: AgentAssistCallbackJob) => Promise<V1ExecuteResponse>;

  /**
   * Deliver the callback payload via HTTP POST.
   * Defaults to `deliverCallback` (the real fetch-based impl).
   * Tests inject a fake to avoid real HTTP.
   */
  deliverPayload?: (
    url: string,
    body: string,
    headers: Record<string, string>,
    options: CallbackUrlValidationOptions,
  ) => Promise<DeliveryResult>;
}

export interface DeliveryResult {
  ok: boolean;
  status: number;
  elapsedMs: number;
  errorMessage?: string;
}

// ─── Core delivery logic (pure function for DI) ─────────────────────────

export async function deliverCallback(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: CallbackUrlValidationOptions,
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error', // Do not follow redirects — customers must post the final URL
      },
      {
        maxRedirects: 0,
        allowLocalhost: options.allowHttpLocalhost === true,
      },
    );
    const elapsedMs = Date.now() - startedAt;
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const errorMessage =
      err instanceof Error && err.name === 'AbortError'
        ? 'Callback delivery timed out'
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      status: 0,
      elapsedMs,
      errorMessage,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── DLQ helper ─────────────────────────────────────────────────────────

async function moveToDLQ(
  dlqQueue: { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> },
  record: DLQRecord,
): Promise<void> {
  try {
    await dlqQueue.add('dead-letter', record, {
      removeOnComplete: { count: 1000, age: 30 * 86400 },
      removeOnFail: { count: 1000 },
    });
    log.info('Moved callback job to DLQ', {
      runId: record.runId,
      attempts: record.attempts,
      lastError: record.lastError.code,
    });
  } catch (dlqErr) {
    log.error('Failed to move callback job to DLQ', {
      runId: record.runId,
      error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
    });
  }
}

// ─── Process a single job ───────────────────────────────────────────────

export interface ProcessJobContext {
  deps: CallbackWorkerDeps;
  dlqQueue: { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> };
  urlValidationOptions: CallbackUrlValidationOptions;
}

/**
 * Process a single callback job. Extracted as a pure function for testability.
 *
 * @throws Error to signal BullMQ to retry (retryable failures)
 */
export async function processCallbackJob(
  jobData: AgentAssistCallbackJob,
  attemptsMade: number,
  maxAttempts: number,
  ctx: ProcessJobContext,
): Promise<void> {
  const { deps, dlqQueue, urlValidationOptions } = ctx;
  const { runId, tenantId, projectId, appId, envName, callbackUrl } = jobData;
  const firstAttemptAt = new Date().toISOString();

  const traceCtx = { tenantId, projectId, appId, environment: envName };

  // 1. Re-validate callback URL (defense-in-depth per D-16)
  const urlCheck = validateCallbackUrl(callbackUrl, urlValidationOptions);
  if (!urlCheck.valid) {
    log.warn('Callback URL failed re-validation in worker', {
      runId,
      callbackUrl,
      reason: urlCheck.reason,
    });
    emitCallbackFailed({ ...traceCtx, runId, callbackUrl, reason: urlCheck.reason });
    await moveToDLQ(dlqQueue, {
      runId,
      jobPayload: jobData,
      lastError: { code: 'INVALID_CALLBACK_URL', message: urlCheck.reason },
      attempts: attemptsMade + 1,
      firstAttemptAt,
      lastAttemptAt: new Date().toISOString(),
    });
    return; // Terminal — do not retry
  }

  // 2. Execute the turn and build the V1 envelope
  let envelope: V1ExecuteResponse;
  try {
    envelope = await deps.executeTurnAndBuildEnvelope(jobData);
  } catch (execErr) {
    const message = execErr instanceof Error ? execErr.message : String(execErr);
    log.error('Callback job execution failed', { runId, error: message });

    // Execution failure is retryable — the agent/deployment may be temporarily down
    if (attemptsMade + 1 >= maxAttempts) {
      emitCallbackFailed({
        ...traceCtx,
        runId,
        callbackUrl,
        reason: `Execution failed after ${maxAttempts} attempts: ${message}`,
      });
      await moveToDLQ(dlqQueue, {
        runId,
        jobPayload: jobData,
        lastError: { code: 'EXECUTION_FAILED', message },
        attempts: attemptsMade + 1,
        firstAttemptAt,
        lastAttemptAt: new Date().toISOString(),
      });
      return;
    }
    throw new Error(`Execution failed (retryable): ${message}`);
  }

  // 3. Sign the payload
  const bodyJson = JSON.stringify(envelope);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-ABL-Run-Id': runId,
    'X-ABL-Event': 'agentic.callback.complete',
  };

  const secret = resolveSigningSecret();
  if (secret) {
    headers[SIGNATURE_HEADER] = signCallbackPayload(bodyJson, secret);
  }

  // Emit trace: callback scheduled (about to deliver)
  emitCallbackScheduled({ ...traceCtx, runId, callbackUrl });

  // 4. POST to callback URL
  const deliver = deps.deliverPayload ?? deliverCallback;
  const result = await deliver(callbackUrl, bodyJson, headers, urlValidationOptions);

  if (result.ok) {
    log.info('Callback delivered successfully', {
      runId,
      status: result.status,
      elapsedMs: result.elapsedMs,
    });
    emitCallbackDelivered({
      ...traceCtx,
      runId,
      callbackUrl,
      durationMs: result.elapsedMs,
    });
    return;
  }

  // 5. Classify failure
  const isTerminal = result.status > 0 && isTerminalHttpStatus(result.status);
  const errorMessage = result.errorMessage ?? `HTTP ${result.status}`;

  if (isTerminal) {
    log.warn('Callback delivery terminal failure', {
      runId,
      status: result.status,
      elapsedMs: result.elapsedMs,
    });
    emitCallbackFailed({
      ...traceCtx,
      runId,
      callbackUrl,
      reason: `Terminal HTTP ${result.status}`,
    });
    await moveToDLQ(dlqQueue, {
      runId,
      jobPayload: jobData,
      lastError: {
        code: 'TERMINAL_HTTP_ERROR',
        message: errorMessage,
        statusCode: result.status,
        elapsedMs: result.elapsedMs,
      },
      attempts: attemptsMade + 1,
      firstAttemptAt,
      lastAttemptAt: new Date().toISOString(),
    });
    return; // Terminal — do not retry
  }

  // Retryable failure
  log.warn('Callback delivery retryable failure', {
    runId,
    status: result.status,
    elapsedMs: result.elapsedMs,
    attempt: attemptsMade + 1,
    maxAttempts,
    errorMessage,
  });

  if (attemptsMade + 1 >= maxAttempts) {
    emitCallbackFailed({
      ...traceCtx,
      runId,
      callbackUrl,
      reason: `Exhausted ${maxAttempts} attempts: ${errorMessage}`,
    });
    await moveToDLQ(dlqQueue, {
      runId,
      jobPayload: jobData,
      lastError: {
        code: 'RETRIES_EXHAUSTED',
        message: errorMessage,
        statusCode: result.status > 0 ? result.status : undefined,
        elapsedMs: result.elapsedMs,
      },
      attempts: attemptsMade + 1,
      firstAttemptAt,
      lastAttemptAt: new Date().toISOString(),
    });
    return;
  }

  // Throw to trigger BullMQ retry with backoff
  throw new Error(`Callback delivery failed (retryable): ${errorMessage}`);
}

// ─── Worker startup ─────────────────────────────────────────────────────

export interface StartWorkerOptions {
  /** Pre-created cluster-safe BullMQ queue connection (for DLQ Queue). */
  queueConnection: import('@agent-platform/redis').RedisClient;
  /** Pre-created cluster-safe BullMQ worker connection (for Worker). */
  workerConnection: import('@agent-platform/redis').RedisClient;
  /** Dependencies for job processing. */
  deps: CallbackWorkerDeps;
  /** Override concurrency (default from env or 10). */
  concurrency?: number;
}

let workerInstance: unknown = null;
let dlqQueueInstance: unknown = null;

export async function startAgentAssistCallbackWorker(options: StartWorkerOptions): Promise<void> {
  if (workerInstance) return;

  const bullmq = await import('bullmq');
  const concurrency =
    options.concurrency ??
    (parseInt(process.env.AGENT_ASSIST_WORKER_CONCURRENCY ?? '', 10) || DEFAULT_CONCURRENCY);

  const urlValidationOptions = resolveValidationOptions();

  // DLQ queue for terminal failures
  const rawDlqQueue = new bullmq.Queue(DLQ_QUEUE_NAME, {
    connection: options.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
  });
  dlqQueueInstance = rawDlqQueue;

  // Wrap to satisfy the narrow DI type
  const dlqQueue: ProcessJobContext['dlqQueue'] = {
    add: (name, data, opts) => rawDlqQueue.add(name, data, opts as undefined),
  };

  const MAX_ATTEMPTS = 5;

  const worker = new bullmq.Worker(
    QUEUE_NAME,
    async (job) => {
      const jobData = job.data as AgentAssistCallbackJob;
      log.info('Processing callback job', {
        jobId: job.id,
        runId: jobData.runId,
        attempt: job.attemptsMade + 1,
        maxAttempts: MAX_ATTEMPTS,
      });

      await processCallbackJob(jobData, job.attemptsMade, MAX_ATTEMPTS, {
        deps: options.deps,
        dlqQueue,
        urlValidationOptions,
      });
    },
    {
      connection: options.workerConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency,
      lockDuration: WORKER_LOCK_DURATION_MS,
      maxStalledCount: WORKER_MAX_STALLED_COUNT,
    },
  );

  worker.on('error', (err: Error) => {
    log.error('Agentic compat callback worker error', {
      error: err.message,
    });
  });

  worker.on('failed', (job: unknown, err: Error) => {
    const j = job as { data?: { runId?: string }; attemptsMade?: number } | undefined;
    log.warn('Callback job failed (may retry)', {
      runId: j?.data?.runId,
      attempt: (j?.attemptsMade ?? 0) + 1,
      error: err.message,
    });
  });

  workerInstance = worker;
  log.info('Agentic compat callback worker started', { concurrency });
}

export async function stopAgentAssistCallbackWorker(): Promise<void> {
  if (workerInstance) {
    await (workerInstance as { close: () => Promise<void> }).close();
    workerInstance = null;
    log.info('Agentic compat callback worker stopped');
  }
  if (dlqQueueInstance) {
    await (dlqQueueInstance as { close: () => Promise<void> }).close();
    dlqQueueInstance = null;
  }
}

// ─── Queue factory for producers ────────────────────────────────────────

export { QUEUE_NAME, DLQ_QUEUE_NAME };

export interface CallbackQueueOptions {
  /** Pre-created cluster-safe BullMQ queue connection (from createBullMQPair). */
  queueConnection: import('@agent-platform/redis').RedisClient;
}

/**
 * Create the producer queue for enqueuing callback jobs.
 * Used by the route handler to enqueue jobs.
 */
export async function createCallbackQueue(options: CallbackQueueOptions): Promise<{
  add: (data: AgentAssistCallbackJob) => Promise<unknown>;
  close: () => Promise<void>;
}> {
  const bullmq = await import('bullmq');
  const queue = new bullmq.Queue(QUEUE_NAME, {
    connection: options.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 100, age: 86400 },
      removeOnFail: false,
    },
  });

  return {
    add: (data: AgentAssistCallbackJob) => queue.add('callback', data),
    close: () => queue.close(),
  };
}
