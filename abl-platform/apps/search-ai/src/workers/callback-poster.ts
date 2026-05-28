/**
 * Workflow callback poster.
 *
 * Posts the worker's extraction result to the workflow-engine's
 * `/api/v1/workflows/callbacks/:executionId/:stepId` endpoint with the
 * platform-standard HMAC signature headers (`x-webhook-signature`,
 * `x-webhook-timestamp`, `x-webhook-id`). The callback route's `getHeader`
 * fallback accepts both `x-webhook-*` and `x-callback-*` (see
 * `apps/workflow-engine/src/routes/workflow-callbacks.ts:103,110`), so emitting
 * the platform helper's headers verbatim is preferred over hand-renaming
 * (LLD Phase 1 Task 1.7 — Round 6 platform-audit finding 2).
 *
 * Backoff: 1s, 2s, 4s, 8s between the 5 attempts (cap 30s — defensive
 * future-proofing if MAX_ATTEMPTS is raised; not reached at the current
 * configuration). Total wall-clock for a fully-exhausted retry sequence is
 * ~15s plus the per-attempt fetch latency.
 *
 * Terminal classes (no retry): 404 (callback gone), 401/403 (auth refused),
 *   409 (step no longer waiting — late callback after engine timeout).
 */

import { buildSignatureHeaders } from '@agent-platform/shared-kernel/security';
import { workerLog, workerError } from './shared.js';
import {
  recordCallbackPostAttempt,
  recordCallbackPostFailure,
  recordCallbackPostSuccess,
} from './branches/extraction-metrics.js';

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ── In-process circuit breaker (P-1) ──────────────────────────────────────
// Prevents 50 concurrent extraction jobs each hammering a dead workflow-engine
// with 5 retries × backoff (250 total requests) when the engine is down.
// Thresholds are conservative — the primary retry logic already handles transient
// failures; the breaker only fires when failures are persistent (> threshold).
const CB_FAILURE_THRESHOLD = 10; // open after 10 consecutive failures
const CB_HALF_OPEN_AFTER_MS = 30_000; // try one probe request after 30s
let cbConsecutiveFailures = 0;
let cbOpenSince = 0; // epoch ms when breaker opened; 0 = closed

function isBreakerOpen(): boolean {
  if (cbOpenSince === 0) return false;
  if (Date.now() - cbOpenSince >= CB_HALF_OPEN_AFTER_MS) return false; // half-open: allow one probe
  return true;
}

function onCallbackSuccess(): void {
  cbConsecutiveFailures = 0;
  cbOpenSince = 0;
}

function onCallbackFailure(errorClass: string): void {
  // Only count server errors — not auth/routing failures that indicate the
  // engine is up but rejecting a specific request (those are terminal anyway).
  if (errorClass === 'SERVER_ERROR' || errorClass === 'NETWORK' || errorClass === 'CONN_REFUSED') {
    cbConsecutiveFailures++;
    if (cbConsecutiveFailures >= CB_FAILURE_THRESHOLD && cbOpenSince === 0) {
      cbOpenSince = Date.now();
    }
  }
}

/** HTTP status codes that should NOT be retried (callback delivery is terminal). */
const TERMINAL_STATUS = new Set<number>([401, 403, 404, 409, 410, 422]);

export interface CallbackPostInput {
  /** Absolute URL of the callback target. Builder owns the URL shape. */
  url: string;
  /** Plaintext HMAC secret from the BullMQ job payload. */
  secret: string;
  /** JSON-serialized payload. The poster signs the exact bytes it transmits. */
  body: string;
  /** Tenant id — used for metric tagging. */
  tenantId: string;
  /** O-1: workflow execution ID forwarded as x-workflow-execution-id header for cross-queue tracing. */
  workflowExecutionId?: string;
  /**
   * Optional fetch implementation for tests. Production callers omit it and
   * `globalThis.fetch` is used.
   */
  fetchImpl?: typeof fetch;
}

export interface CallbackPostOutcome {
  ok: boolean;
  status?: number;
  attempts: number;
  /** Set when delivery never succeeded. Sanitized; not raw HTTP body. */
  errorClass?: string;
}

/**
 * Post the callback with exponential backoff. Returns the outcome rather than
 * throwing — the caller (extraction-only branch) decides whether to fail the
 * BullMQ job. A failed callback should NOT poison the BullMQ job (the engine
 * already parked the step; if the callback never arrives the engine times out
 * via its own `raceTimeout`).
 */
export async function postCallback(input: CallbackPostInput): Promise<CallbackPostOutcome> {
  const fetchFn: typeof fetch = input.fetchImpl ?? fetch;
  let lastStatus: number | undefined;
  let lastErrorClass: string | undefined;
  let delayMs = BACKOFF_BASE_MS;

  // Circuit-breaker check — fail fast when the workflow-engine is down (P-1).
  if (isBreakerOpen()) {
    const errorClass = 'CIRCUIT_OPEN';
    recordCallbackPostFailure({ tenant: input.tenantId, error_class: errorClass });
    workerError(
      'workflow-docling',
      'Callback POST skipped — circuit breaker is open (workflow-engine appears down)',
      new Error('CIRCUIT_OPEN'),
    );
    return { ok: false, attempts: 0, errorClass };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let retryAfterMs = 0;
    recordCallbackPostAttempt({ tenant: input.tenantId, attempt });
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildSignatureHeaders(input.secret, input.body),
        // O-1: carry execution ID across the BullMQ boundary for log correlation.
        ...(input.workflowExecutionId
          ? { 'x-workflow-execution-id': input.workflowExecutionId }
          : {}),
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchFn(input.url, {
          method: 'POST',
          headers,
          body: input.body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      lastStatus = response.status;

      if (response.ok) {
        onCallbackSuccess();
        recordCallbackPostSuccess({ tenant: input.tenantId });
        workerLog('workflow-docling', `Callback POST succeeded`, {
          attempt,
          status: response.status,
        });
        return { ok: true, status: response.status, attempts: attempt };
      }

      // For 401 responses the callback route emits a `code` field in the
      // body distinguishing TIMESTAMP_EXPIRED from SIGNATURE_INVALID
      // (Round-7 split). Read it once for the error_class dimension.
      let routeCode: string | undefined;
      if (response.status === 401) {
        try {
          const body = (await response.clone().json()) as { code?: unknown };
          if (typeof body?.code === 'string') routeCode = body.code;
        } catch (parseErr) {
          // Non-JSON body — fall back to the status-based classifier. Log at
          // warn so a misbehaving route is observable rather than silently
          // collapsing to the SIGNATURE_INVALID bucket.
          workerLog(
            'workflow-docling',
            'Callback 401 body was not JSON; using status-only classifier',
            {
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            },
          );
        }
      }

      lastErrorClass = classifyHttpStatus(response.status, routeCode);
      onCallbackFailure(lastErrorClass);
      recordCallbackPostFailure({ tenant: input.tenantId, error_class: lastErrorClass });

      if (TERMINAL_STATUS.has(response.status)) {
        workerError(
          'workflow-docling',
          `Callback POST terminal (status=${response.status} class=${lastErrorClass})`,
          new Error(`HTTP ${response.status}`),
        );
        return {
          ok: false,
          status: response.status,
          attempts: attempt,
          errorClass: lastErrorClass,
        };
      }

      // Respect server-specified Retry-After on 429 — use it for the next sleep
      // instead of the exponential step to avoid amplifying load on a rate-limited engine.
      if (response.status === 429) {
        const raw = response.headers.get('retry-after');
        if (raw) {
          const secs = Number(raw);
          if (!isNaN(secs) && secs > 0) retryAfterMs = Math.min(secs * 1_000, BACKOFF_CAP_MS);
        }
      }
    } catch (err) {
      lastErrorClass = classifyTransportError(err);
      onCallbackFailure(lastErrorClass);
      recordCallbackPostFailure({ tenant: input.tenantId, error_class: lastErrorClass });
      workerError(
        'workflow-docling',
        `Callback POST attempt ${attempt} failed (class=${lastErrorClass})`,
        err,
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(retryAfterMs > 0 ? retryAfterMs : delayMs);
      delayMs = Math.min(delayMs * 2, BACKOFF_CAP_MS);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    attempts: MAX_ATTEMPTS,
    errorClass: lastErrorClass ?? 'EXHAUSTED',
  };
}

/**
 * Classify a non-2xx response into a metric-friendly error class.
 *
 * For 401 we honour the route's `code` body field — `TIMESTAMP_EXPIRED`,
 * `TIMESTAMP_MISSING`, `SIGNATURE_MISSING`, `SIGNATURE_INVALID` — so the
 * callback-poster failures metric can split clock-skew (operator-fixable)
 * from authentic HMAC mismatches (security event). Falls back to the legacy
 * `SIGNATURE_INVALID` bucket when the route returns no code (older route
 * builds), keeping the dimension cardinality bounded.
 */
function classifyHttpStatus(status: number, routeCode?: string): string {
  if (status === 401) {
    if (routeCode === 'TIMESTAMP_EXPIRED') return 'TIMESTAMP_EXPIRED';
    if (routeCode === 'TIMESTAMP_MISSING') return 'TIMESTAMP_MISSING';
    if (routeCode === 'SIGNATURE_MISSING') return 'SIGNATURE_MISSING';
    return 'SIGNATURE_INVALID';
  }
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'CALLBACK_NOT_FOUND';
  if (status === 409) return 'STEP_NOT_WAITING';
  if (status === 410) return 'CALLBACK_GONE';
  if (status === 422) return 'CALLBACK_REJECTED';
  if (status >= 500) return 'SERVER_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  return 'HTTP_' + String(status);
}

function classifyTransportError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'TIMEOUT';
    const code = (err as { code?: string }).code;
    if (code === 'ECONNREFUSED') return 'CONN_REFUSED';
    if (code === 'ENOTFOUND') return 'DNS_FAILED';
    if (code === 'ECONNRESET') return 'CONN_RESET';
  }
  return 'NETWORK';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
