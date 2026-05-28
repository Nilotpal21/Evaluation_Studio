/**
 * Azure Document Intelligence Poll Worker
 *
 * BullMQ worker that polls the Azure DI operation URL once per job, then either
 * re-enqueues with exponential backoff (still running) or POSTs the callback to
 * the workflow-engine (succeeded / failed). This moves the Azure polling loop
 * out of the Restate handler — the handler parks on an awakeable immediately
 * and uses near-zero resources until the callback arrives.
 *
 * Queue: workflow-adi-poll
 * Concurrency: 5 (configurable via AZURE_DI_POLL_CONCURRENCY)
 * Lock duration: 10 min (each job takes <1s — generous guard against stale locks)
 *
 * Job lifecycle:
 *   1. Decrypt apiKey + callbackSecret (at-rest via workflow-adi-poll manifest).
 *   2. Enforce timeout: if startedAt + timeoutMs < now → POST STEP_TIMEOUT.
 *   3. GET operationLocation (one HTTP call).
 *   4a. running / notStarted → re-enqueue with nextDelayMs (exponential backoff).
 *   4b. succeeded → normalizeAzureAnalyzeResult → POST callback success.
 *   4c. failed → POST callback failure.
 *   4d. 404 → re-POST :analyze, update operationLocation in job, re-enqueue.
 *   4e. 429 / 5xx → re-enqueue with Retry-After-aware delay.
 */

import { Queue, Worker, type Job } from 'bullmq';
import {
  createBullMQPair,
  BULLMQ_CLUSTER_SAFE_PREFIX,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import { buildSignatureHeaders } from '@agent-platform/shared-kernel/security';
import { unwrapJobDataForDecrypt, wrapJobDataForEncrypt } from '@agent-platform/shared-encryption';
import { encryptForTenantAuto, decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { normalizeAzureAnalyzeResult, type AzureAnalyzeResult } from '@agent-platform/connectors';

const log = createLogger('workflow-engine:adi-poll-worker');

export const QUEUE_WORKFLOW_ADI_POLL = 'workflow-adi-poll';

// Fixed poll interval — Azure recommends polling no more than once every 2s.
// We use a fixed interval (not exponential backoff) because each BullMQ job
// is a discrete execution with no CPU cost between polls. Exponential backoff
// would add unnecessary latency: if Azure finishes at t=28s and the next poll
// is scheduled at t=30s (16s backoff step), the workflow waits 2s after
// completion. With a fixed 2s interval the max wait-after-completion is 2s.
// Backoff only applies to actual errors (429 / 5xx) via Retry-After header.
const POLL_INTERVAL_MS = Number(process.env.AZURE_DI_POLL_INTERVAL_MS ?? '2000');
// SEC-10: derive expected callback hostname from the existing WORKFLOW_ENGINE_PUBLIC_URL.
// callbackUrl is validated at job-start so a Redis-compromised job can't redirect
// extraction results to an attacker host. In production the env MUST be set —
// missing it would silently disable the guard, leaving a fail-open hole that a
// Redis compromise could exploit. Dev/CI may run without it.
const EXPECTED_CALLBACK_HOST = (() => {
  const raw = process.env.WORKFLOW_ENGINE_PUBLIC_URL;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SEC-10: WORKFLOW_ENGINE_PUBLIC_URL must be set in production — callback host validation cannot be silently disabled',
      );
    }
    return '';
  }
  try {
    return new URL(raw).hostname;
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `SEC-10: WORKFLOW_ENGINE_PUBLIC_URL is not a valid URL — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return '';
  }
})();
// Hard cap on re-enqueue cycles regardless of timeoutMs (I-1). At 2s intervals
// this is ~33 minutes — comfortably above any reasonable Azure DI operation but
// prevents an unbounded loop when startedAt is corrupted or timeoutMs is huge.
const MAX_POLL_COUNT = Number(process.env.AZURE_DI_MAX_POLL_COUNT ?? '1000');
// Error backoff cap — only used when Azure returns 429 or 5xx.
const POLL_ERROR_BACKOFF_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ADI_INLINE_CAP_BYTES = Number(
  process.env.AZURE_DI_WORKFLOW_INLINE_CAP_BYTES ?? String(10 * 1024 * 1024),
);

/** Wire shape as produced by the ADI connector action. */
export interface AdiPollJobData {
  mode: 'workflow-adi-poll';
  tenantId: string;
  projectId: string;
  workflowExecutionId: string;
  stepId: string;
  callbackId: string;
  callbackUrl: string;
  /** Plaintext at enqueue-time — encrypted at-rest via workflow-adi-poll manifest. */
  callbackSecret: string;
  operationLocation: string;
  endpoint: string;
  /** Plaintext at enqueue-time — encrypted at-rest via workflow-adi-poll manifest. */
  apiKey: string;
  apiVersion: string;
  sourceUrl: string;
  contentType: string;
  timeoutMs: number;
  startedAt: number;
  /** Error backoff delay — only set when the previous poll hit 429/5xx. 0 means normal fixed interval. */
  errorDelayMs: number;
  /** Monotonically-incrementing re-enqueue counter. Bounds the loop when startedAt is corrupted (I-1).
   *  Absent on the initial job enqueued by the connector action — defaults to 0 in the worker. */
  pollCount?: number;
}

export interface AdiPollWorkerDeps {
  redisHandle: RedisConnectionHandle;
}

export function createAdiPollWorker(deps: AdiPollWorkerDeps): {
  queue: Queue<AdiPollJobData>;
  worker: Worker<AdiPollJobData>;
  close: () => Promise<void>;
} {
  const pair = createBullMQPair(deps.redisHandle);

  const queue = new Queue<AdiPollJobData>(QUEUE_WORKFLOW_ADI_POLL, {
    connection: pair.queueConnection,
    prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    // I-10: retain more jobs for debugging — at concurrency=50 with 2s intervals,
    // 200 completed jobs vanished in ~8 s. 2000/5000 gives ~80 s / 3 min of history.
    defaultJobOptions: { removeOnComplete: { count: 2000 }, removeOnFail: { count: 5000 } },
  });

  // High concurrency — each job does one HTTP GET (~200ms, near-zero CPU).
  // Azure self-limits via 429; our error backoff handles those.
  // BullMQ default is 1 which would serialize all polls — we need a high
  // value to prevent 95 workflows sitting in queue while 5 run.
  const concurrency = Number(process.env.AZURE_DI_POLL_CONCURRENCY ?? '50');
  const worker = new Worker<AdiPollJobData>(
    QUEUE_WORKFLOW_ADI_POLL,
    (job) => processAdiPollJob(job, queue),
    {
      connection: pair.workerConnection,
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency,
      lockDuration: 600_000,
      stalledInterval: 300_000,
    },
  );

  worker.on('failed', (job, err) => {
    log.warn('ADI poll job failed', {
      jobId: job?.id,
      stepId: job?.data?.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info('AdiPollWorker initialized', { concurrency });

  return {
    queue,
    worker,
    close: async () => {
      await worker.close();
      await queue.close();
      pair.disconnect();
    },
  };
}

/** Shared encrypt/decrypt pair reused for decryption and re-enqueue encryption. */
const TENANT_ENCRYPTION = {
  encryptForTenant: (p: string, t: string) => encryptForTenantAuto(p, t),
  decryptForTenant: (c: string, t: string) => decryptForTenantAuto(c, t),
};

async function processAdiPollJob(
  job: Job<AdiPollJobData>,
  queue: Queue<AdiPollJobData>,
): Promise<void> {
  // Decrypt secrets encrypted at-rest via the workflow-adi-poll manifest.
  // If decryption fails the job permanently fails — we cannot post a callback
  // without the plaintext callbackSecret needed to sign it.
  let decryptedData: AdiPollJobData;
  try {
    decryptedData = (await unwrapJobDataForDecrypt(
      QUEUE_WORKFLOW_ADI_POLL,
      job.data as unknown as Record<string, unknown>,
      TENANT_ENCRYPTION,
    )) as unknown as AdiPollJobData;
  } catch (decryptErr) {
    log.error('ADI poll job decryption failed — job permanently abandoned', {
      jobId: job.id,
      error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
    });
    throw decryptErr; // BullMQ marks job failed; no callback possible without secret
  }

  // F-3: top-level catch posts an error callback so the workflow surfaces
  // WORKER_ERROR instead of hanging at waiting_callback until awakeable timeout.
  try {
    await processDecryptedPollJob(decryptedData, queue);
  } catch (err) {
    log.error('ADI poll worker unhandled error', {
      stepId: decryptedData.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
    postCallback(decryptedData.callbackUrl, decryptedData.callbackSecret, decryptedData.tenantId, {
      status: 'failed',
      error: {
        code: 'WORKER_ERROR',
        message: 'Internal poll worker error — check workflow-engine logs',
      },
    }).catch((postErr: unknown) => {
      log.warn('ADI error-callback post also failed', {
        stepId: decryptedData.stepId,
        error: postErr instanceof Error ? postErr.message : String(postErr),
      });
    });
  }
}

async function processDecryptedPollJob(
  decryptedData: AdiPollJobData,
  queue: Queue<AdiPollJobData>,
): Promise<void> {
  const {
    tenantId,
    stepId,
    callbackUrl,
    callbackSecret,
    operationLocation,
    endpoint,
    apiKey,
    sourceUrl,
    contentType,
    timeoutMs,
    startedAt,
    errorDelayMs,
    pollCount = 0,
  } = decryptedData;

  // F-2: Validate operationLocation hostname matches the registered endpoint
  // (defense-in-depth post-Redis hop guards against tampered job data).
  let opHost: string;
  let epHost: string;
  try {
    opHost = new URL(operationLocation).hostname;
    epHost = new URL(endpoint).hostname;
  } catch (urlErr) {
    log.error('ADI operationLocation URL parse failed', {
      stepId,
      error: urlErr instanceof Error ? urlErr.message : String(urlErr),
    });
    await postCallback(callbackUrl, callbackSecret, tenantId, {
      status: 'failed',
      error: { code: 'EXTRACTION_FAILED', message: 'Invalid Azure DI operation-location URL' },
    });
    return;
  }
  if (opHost !== epHost) {
    log.error('ADI operationLocation hostname mismatch — job rejected', { stepId, opHost, epHost });
    await postCallback(callbackUrl, callbackSecret, tenantId, {
      status: 'failed',
      error: {
        code: 'EXTRACTION_FAILED',
        message: 'Azure DI operation-location hostname mismatch',
      },
    });
    return;
  }

  // SEC-10: validate callbackUrl hostname matches the expected workflow-engine host.
  // Guards against a Redis-compromise redirecting extraction results to an attacker.
  if (EXPECTED_CALLBACK_HOST) {
    let cbHost: string;
    try {
      cbHost = new URL(callbackUrl).hostname;
    } catch {
      log.error('ADI callbackUrl URL parse failed — job rejected', { stepId, callbackUrl });
      return; // Cannot POST to an invalid URL; let the stuck-execution sweeper clean up.
    }
    if (cbHost !== EXPECTED_CALLBACK_HOST) {
      log.error('ADI callbackUrl hostname mismatch — job rejected', {
        stepId,
        cbHost,
        expected: EXPECTED_CALLBACK_HOST,
      });
      return;
    }
  }

  // Hard poll-count cap — prevents unbounded re-enqueue when startedAt is
  // corrupted (e.g. set to future) so the timeoutMs check never fires (I-1).
  if (pollCount >= MAX_POLL_COUNT) {
    log.warn('ADI poll max count exceeded', { stepId, pollCount, MAX_POLL_COUNT });
    await postCallback(callbackUrl, callbackSecret, tenantId, {
      status: 'failed',
      error: {
        code: 'STEP_TIMEOUT',
        message: `Azure DI extraction exceeded max poll count (${MAX_POLL_COUNT})`,
      },
    });
    return;
  }

  // Timeout guard: if the overall extraction budget is exhausted, post error.
  if (Date.now() - startedAt > timeoutMs) {
    log.warn('ADI poll timeout exceeded', { stepId, elapsed: Date.now() - startedAt, timeoutMs });
    await postCallback(callbackUrl, callbackSecret, tenantId, {
      status: 'failed',
      error: {
        code: 'STEP_TIMEOUT',
        message: `Azure DI extraction timed out after ${timeoutMs}ms`,
      },
    });
    return;
  }

  // Single HTTP GET to Azure DI operation URL.
  let resp: Response;
  try {
    resp = await fetch(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn('ADI poll fetch error — re-enqueueing', {
      stepId,
      error: err instanceof Error ? err.message : String(err),
    });
    await reEnqueue(queue, decryptedData, POLL_INTERVAL_MS, 0);
    return;
  }

  // Handle 429 / 5xx — use Retry-After header, with exponential backoff only
  // on error responses (not on normal running/notStarted status).
  if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
    const nextErrorDelay = Math.min(
      (errorDelayMs || POLL_INTERVAL_MS) * 2,
      POLL_ERROR_BACKOFF_MAX_MS,
    );
    const delay = parseRetryAfterHeader(resp.headers, nextErrorDelay);
    await reEnqueue(queue, decryptedData, delay, nextErrorDelay);
    return;
  }

  // Handle 404: Azure result expired — fail cleanly.
  if (resp.status === 404) {
    log.warn('ADI operation 404 — Azure result expired or invalid', { stepId });
    await postCallback(callbackUrl, callbackSecret, tenantId, {
      status: 'failed',
      error: { code: 'EXTRACTION_FAILED', message: 'Azure DI operation not found (404)' },
    });
    return;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '<unreadable>');
    log.warn('ADI poll unexpected error status', { stepId, status: resp.status, body });
    await reEnqueue(queue, decryptedData, POLL_INTERVAL_MS, 0);
    return;
  }

  // Parse with selective reviver — drops analyzeResult.content (unused by
  // normalizer, often 50-70% of response size) to reduce peak memory.
  // F-3: Wrap JSON.parse — Azure occasionally returns non-JSON on transient errors.
  const responseText = await resp.text();
  let payload: {
    status?: string;
    analyzeResult?: AzureAnalyzeResult;
    error?: { message?: string; code?: string };
  };
  try {
    payload = JSON.parse(responseText, adiResponseReviver) as typeof payload;
  } catch {
    log.warn('ADI poll: Azure returned non-JSON response — re-enqueueing', { stepId });
    await reEnqueue(queue, decryptedData, POLL_INTERVAL_MS, 0);
    return;
  }

  switch (payload.status) {
    case 'running':
    case 'notStarted': {
      // Fixed interval — no backoff on normal in-progress status.
      await reEnqueue(queue, decryptedData, POLL_INTERVAL_MS, 0);
      return;
    }

    case 'succeeded': {
      if (!payload.analyzeResult) {
        await postCallback(callbackUrl, callbackSecret, tenantId, {
          status: 'failed',
          error: {
            code: 'EXTRACTION_FAILED',
            message: 'Azure DI succeeded but analyzeResult missing',
          },
        });
        return;
      }
      const envelope = normalizeAzureAnalyzeResult(payload.analyzeResult, {
        sourceUrl,
        contentType: contentType || 'application/octet-stream',
      });
      // I-13: serialize once — reuse the string for both the size check and the
      // POST body so the envelope is never stringified twice (peak ~30 MB at 10 MB cap).
      const successBody = JSON.stringify({ status: 'success', envelope });
      const sizeBytes = Buffer.byteLength(successBody, 'utf8');
      if (sizeBytes > ADI_INLINE_CAP_BYTES) {
        await postCallback(callbackUrl, callbackSecret, tenantId, {
          status: 'failed',
          error: {
            code: 'EXTRACTION_TOO_LARGE',
            message: `Normalized envelope ${sizeBytes} bytes exceeds cap ${ADI_INLINE_CAP_BYTES}`,
          },
        });
        return;
      }
      // F-4: If callback delivery fails, re-enqueue for retry — Azure retains
      // results for 24h so the next poll iteration will re-normalize and retry.
      const delivered = await postCallbackRaw(
        callbackUrl,
        callbackSecret,
        tenantId,
        successBody,
        decryptedData.workflowExecutionId,
      );
      if (delivered) {
        log.info('ADI extraction complete', { stepId, sizeBytes });
      } else {
        log.warn('ADI callback delivery failed — re-enqueueing for retry', { stepId });
        await reEnqueue(queue, decryptedData, POLL_INTERVAL_MS * 5, 0);
      }
      return;
    }

    case 'failed': {
      const message =
        payload.error?.message ?? `Azure DI operation failed: ${payload.error?.code ?? 'unknown'}`;
      await postCallback(callbackUrl, callbackSecret, tenantId, {
        status: 'failed',
        error: { code: 'EXTRACTION_FAILED', message },
      });
      return;
    }

    default:
      await reEnqueue(queue, decryptedData, POLL_INTERVAL_MS, 0);
  }
}

async function reEnqueue(
  queue: Queue<AdiPollJobData>,
  data: AdiPollJobData,
  delayMs: number,
  errorDelayMs: number,
): Promise<void> {
  // Increment pollCount so the max-poll-count guard fires after MAX_POLL_COUNT
  // re-enqueues even when timeoutMs is huge or startedAt is corrupted (I-1).
  const payload = { ...data, errorDelayMs, pollCount: (data.pollCount ?? 0) + 1 };

  // SEC-2: If re-encryption fails, throw immediately so BullMQ marks the job
  // failed. This prevents plaintext apiKey / callbackSecret being stored in
  // Redis because wrapJobDataForEncrypt silently no-ops on manifest mismatch.
  let encrypted: AdiPollJobData;
  try {
    encrypted = (await wrapJobDataForEncrypt(
      QUEUE_WORKFLOW_ADI_POLL,
      payload as unknown as Record<string, unknown>,
      TENANT_ENCRYPTION,
    )) as unknown as AdiPollJobData;
  } catch (encryptErr) {
    log.error('ADI reEnqueue: re-encryption failed — job abandoned to prevent plaintext in Redis', {
      stepId: data.stepId,
      error: encryptErr instanceof Error ? encryptErr.message : String(encryptErr),
    });
    throw encryptErr;
  }
  await queue.add('poll', encrypted, { delay: delayMs, attempts: 1 });
}

/**
 * Variant of postCallback that accepts a pre-serialized body string (I-13).
 * Avoids a second JSON.stringify when the caller already serialized for a size check.
 */
async function postCallbackRaw(
  url: string,
  secret: string,
  tenantId: string,
  bodyStr: string,
  workflowExecutionId?: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildSignatureHeaders(secret, bodyStr),
    // O-1: propagate execution ID so workflow-engine logs can correlate across the
    // BullMQ queue boundary without relying on distributed trace headers.
    ...(workflowExecutionId ? { 'x-workflow-execution-id': workflowExecutionId } : {}),
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn('ADI callback POST non-ok', { url, status: resp.status, tenantId });
      return false;
    }
    return true;
  } catch (err) {
    log.error('ADI callback POST failed', {
      url,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Returns true on successful delivery (2xx), false on any failure. Never throws. */
async function postCallback(
  url: string,
  secret: string,
  tenantId: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const bodyStr = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildSignatureHeaders(secret, bodyStr),
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn('ADI callback POST non-ok', { url, status: resp.status, tenantId });
      return false;
    }
    return true;
  } catch (err) {
    log.error('ADI callback POST failed', {
      url,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Drop unused Azure DI fields before they enter the JS heap. */
const ADI_CONTENT_DROP_THRESHOLD = 1_000;
function adiResponseReviver(key: string, value: unknown): unknown {
  if (key === 'content' && typeof value === 'string' && value.length > ADI_CONTENT_DROP_THRESHOLD) {
    return undefined;
  }
  if (key === 'styles' || key === 'keyValuePairs' || key === 'documents') {
    return undefined;
  }
  return value;
}

function parseRetryAfterHeader(headers: Headers, fallbackMs: number): number {
  const raw = headers.get('Retry-After') ?? headers.get('retry-after');
  if (!raw) return fallbackMs;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0)
    return Math.min(seconds * 1000, POLL_ERROR_BACKOFF_MAX_MS);
  return fallbackMs;
}
