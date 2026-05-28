/**
 * Workflow-path extraction branch (LLD Phase 1 Task 1.8).
 *
 * Processes a job dequeued from `workflow-docling-extraction`. The
 * `full-ingestion` branch (existing) is untouched — see
 * `docling-extraction-worker.ts:processDoclingExtractionJob`.
 *
 * Pipeline:
 *   1. Re-validate SSRF on the inbound URL (Redis-hop defense).
 *   2. Stream the URL into Docling via `streamUrlToDocling` (Task 1.6).
 *   3. Normalize Docling-native response into `ExtractionEnvelope`. The
 *      canonical normalizer lands in Phase 2 at
 *      `packages/connectors/src/native/docling/normalize.ts`; Phase 1 uses
 *      the temporary local normalizer below (replaced when Phase 2 commits).
 *   4. Reject if serialized envelope exceeds the inline cap
 *      (`DOCLING_WORKFLOW_INLINE_CAP_BYTES`, default 50 MB).
 *   5. POST the result to the workflow-engine callback URL with HMAC headers
 *      via `callback-poster.ts`.
 */

import type { Job } from 'bullmq';
import type { WorkflowDoclingExtractionJobData } from '@agent-platform/search-ai-sdk';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import { getEnvSSRFAllowedHosts } from '@agent-platform/shared-kernel/security/safe-fetch';
import { normalizeDoclingToEnvelope, type ExtractionEnvelope } from '@agent-platform/connectors';
import { unwrapJobDataForDecrypt } from '@agent-platform/shared-encryption';
import { encryptForTenantAuto, decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { workerLog, workerError } from '../shared.js';
import { postCallback } from '../callback-poster.js';
import { streamUrlToDocling, DoclingExtractionError } from './streaming-url-to-docling.js';
import {
  recordEnvelopeBytes,
  recordExtractionError,
  recordExtractionTooLarge,
  recordWaitDurationMs,
} from './extraction-metrics.js';

const DEFAULT_INLINE_CAP_BYTES = 50 * 1024 * 1024;

// SEC-10: derive expected callback hostname from WORKFLOW_ENGINE_PUBLIC_URL.
// Mirrors the same guard in adi-poll-worker.ts — validates callbackUrl after
// decryption so a Redis-compromised job can't redirect results to an attacker host.
// In production the env MUST be set — fail-closed at boot rather than silently
// disabling the guard.
const EXPECTED_CALLBACK_HOST = (() => {
  const raw = process.env.WORKFLOW_ENGINE_PUBLIC_URL;
  const isTest = process.env.NODE_ENV === 'test';
  const isProd = process.env.NODE_ENV === 'production';
  if (!raw) {
    if (isProd) {
      throw new Error(
        'SEC-10: WORKFLOW_ENGINE_PUBLIC_URL must be set in production — callback host validation cannot be silently disabled',
      );
    }
    if (!isTest) {
      workerError(
        'workflow-docling',
        'SEC-10: WORKFLOW_ENGINE_PUBLIC_URL is unset — callback host validation is DISABLED. ' +
          'Set this env var to the public URL of the workflow-engine to enable host pinning.',
        new Error('SEC-10 callback host validation disabled'),
      );
    }
    return '';
  }
  try {
    return new URL(raw).hostname;
  } catch (err) {
    if (isProd) {
      throw new Error(
        `SEC-10: WORKFLOW_ENGINE_PUBLIC_URL is not a valid URL — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isTest) {
      workerError(
        'workflow-docling',
        `SEC-10: WORKFLOW_ENGINE_PUBLIC_URL is not a valid URL — callback host validation is DISABLED`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    return '';
  }
})();

interface CallbackSuccessBody {
  status: 'success';
  envelope: ExtractionEnvelope;
}

interface CallbackFailureBody {
  status: 'failed';
  error: { code: string; message: string };
}

type CallbackBody = CallbackSuccessBody | CallbackFailureBody;

/** Entrypoint invoked by the worker processor when the queue is `workflow-docling-extraction`. */
export async function processExtractionOnly(
  job: Job<WorkflowDoclingExtractionJobData>,
): Promise<void> {
  const jobStart = Date.now();

  // Decrypt `callbackSecret` per the field-encryption manifest. Enqueue-side
  // encryption happens in `apps/workflow-engine/src/index.ts:enqueueWorkflowDoclingJob`
  // (manifest entry: `workflow-docling-extraction`). The wrapper is a no-op
  // when the manifest declares no encrypted fields, so older jobs that
  // landed before this change continue to dequeue without error.
  const decryptedData = (await unwrapJobDataForDecrypt(
    'workflow-docling-extraction',
    job.data as unknown as Record<string, unknown>,
    {
      encryptForTenant: (plaintext, tenantId) => encryptForTenantAuto(plaintext, tenantId),
      decryptForTenant: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
    },
  )) as unknown as WorkflowDoclingExtractionJobData;

  const { sourceUrl, tenantId, projectId, stepId, callbackUrl, callbackSecret, options } =
    decryptedData;

  workerLog('workflow-docling', `Workflow extraction job picked up`, {
    jobId: job.id,
    tenantId,
    projectId,
    stepId,
  });

  // SEC-10: validate callbackUrl hostname post-decryption (mirrors adi-poll-worker.ts).
  if (EXPECTED_CALLBACK_HOST) {
    let callbackHost = '';
    try {
      callbackHost = new URL(callbackUrl).hostname;
    } catch {
      throw new Error(`SEC-10: callbackUrl is not a valid URL: ${callbackUrl}`);
    }
    if (callbackHost !== EXPECTED_CALLBACK_HOST) {
      throw new Error(
        `SEC-10: callbackUrl hostname '${callbackHost}' does not match expected '${EXPECTED_CALLBACK_HOST}'`,
      );
    }
  }

  let callbackBody: CallbackBody;
  try {
    // 1. Defense-in-depth SSRF re-check at the worker (post-Redis hop).
    // `assertUrlSafeForSSRF` throws a plain Error with the reason as message;
    // wrap it in a typed DoclingExtractionError so the classifier maps it to
    // `SSRF_BLOCKED` (not the generic `EXTRACTION_FAILED`).
    //
    // Operator-controlled allowlist: read `SSRF_ALLOWED_HOSTNAMES` (CSV) and
    // pass it through to the static check. This mirrors `safeFetch`'s
    // env-driven allowlist so dev/CI environments can opt-in specific
    // internal targets (e.g. the test fixture on 127.0.0.1) without
    // weakening the production default.
    const allowedHosts = getEnvSSRFAllowedHosts();
    try {
      assertUrlSafeForSSRF(
        sourceUrl,
        allowedHosts.length > 0 ? { additionalAllowedHosts: allowedHosts } : {},
      );
    } catch (ssrfErr) {
      throw new DoclingExtractionError(
        'SSRF_BLOCKED',
        ssrfErr instanceof Error ? ssrfErr.message : 'URL blocked by SSRF guard',
      );
    }

    // 2. Stream URL → Docling
    const doclingResult = await streamUrlToDocling({
      fileUrl: sourceUrl,
      options: {
        extractImages: options?.extractImages ?? true,
        extractTables: options?.extractTables ?? true,
        renderScreenshots: false,
        ocrEnabled: options?.ocrEnabled ?? true,
      },
    });

    // 3. Normalize → ExtractionEnvelope (canonical Phase 2 normalizer).
    const envelope = normalizeDoclingToEnvelope(doclingResult, {
      sourceUrl,
    });

    // 4. Inline-cap check
    const serialized = JSON.stringify({ status: 'success', envelope } satisfies CallbackBody);
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');
    recordEnvelopeBytes(sizeBytes, { provider: 'docling' });
    const limitBytes = Number(
      process.env.DOCLING_WORKFLOW_INLINE_CAP_BYTES ?? DEFAULT_INLINE_CAP_BYTES,
    );
    if (sizeBytes > limitBytes) {
      recordExtractionTooLarge({ tenant: tenantId, provider: 'docling' });
      callbackBody = {
        status: 'failed',
        error: {
          code: 'EXTRACTION_TOO_LARGE',
          message: `Extraction envelope ${sizeBytes} bytes exceeds inline cap ${limitBytes} bytes`,
        },
      };
    } else {
      callbackBody = { status: 'success', envelope };
    }
  } catch (err) {
    const errorCode = classifyError(err);
    recordExtractionError({ tenant: tenantId, error_class: errorCode });
    workerError('workflow-docling', `Workflow extraction failed (code=${errorCode})`, err, {
      jobId: job.id,
      tenantId,
      projectId,
      stepId,
      errorCode,
    });
    callbackBody = {
      status: 'failed',
      error: { code: errorCode, message: sanitizeErrorMessage(err) },
    };
  }

  // 5. POST callback (failures here do NOT poison the job — engine has its own timeout)
  const callbackBodyText = JSON.stringify(callbackBody);
  const outcome = await postCallback({
    url: callbackUrl,
    secret: callbackSecret,
    body: callbackBodyText,
    tenantId,
    workflowExecutionId: decryptedData.workflowExecutionId,
  });

  const durationMs = Date.now() - jobStart;
  recordWaitDurationMs(durationMs, {
    tenant: tenantId,
    status: callbackBody.status,
  });

  if (!outcome.ok) {
    workerError(
      'workflow-docling',
      `Callback POST exhausted (attempts=${outcome.attempts} class=${outcome.errorClass})`,
      new Error('CALLBACK_DELIVERY_FAILED'),
      {
        jobId: job.id,
        tenantId,
        projectId,
        stepId,
        attempts: outcome.attempts,
        errorClass: outcome.errorClass,
      },
    );
    // S-4: Re-throw for non-terminal error classes so BullMQ retries the job
    // (attempts:3 on the queue side). Terminal classes (404, 401, 403, 409) mean
    // the callback URL is permanently gone / auth-rejected — retrying can't help.
    const TERMINAL_CALLBACK_ERROR_CLASSES = new Set([
      'CALLBACK_NOT_FOUND',
      'CALLBACK_GONE',
      'CALLBACK_REJECTED',
      'FORBIDDEN',
      'STEP_NOT_WAITING',
      'SIGNATURE_INVALID',
    ]);
    if (!TERMINAL_CALLBACK_ERROR_CLASSES.has(outcome.errorClass ?? '')) {
      throw new Error(
        `Callback delivery failed (class=${outcome.errorClass ?? 'EXHAUSTED'}) — BullMQ will retry`,
      );
    }
  } else {
    workerLog('workflow-docling', `Workflow extraction completed`, {
      jobId: job.id,
      tenantId,
      stepId,
      status: callbackBody.status,
      durationMs,
    });
  }
}

function classifyError(err: unknown): string {
  if (err instanceof DoclingExtractionError) return err.code;
  if (err instanceof Error) {
    if (err.name === 'SSRFError') return 'SSRF_BLOCKED';
    const code = (err as { code?: string }).code;
    if (code === 'SSRF_BLOCKED') return 'SSRF_BLOCKED';
  }
  return 'EXTRACTION_FAILED';
}

/**
 * Strip internal URLs / response bodies / secrets / IPs from error messages.
 * The trace event must not leak Docling's intra-cluster URL or any HTTP body
 * that may contain credentials echoed back by a misconfigured upstream
 * (FR-19), nor expose cloud-metadata or RFC1918 IPs that SSRF errors
 * legitimately mention by name.
 */
function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    raw
      .replace(/https?:\/\/[^\s'"]+/g, '[url]')
      .replace(/Authorization:\s*[^\s'"]+/gi, 'Authorization: [redacted]')
      // Match `api_key=...`, `api-key:...`, `apiKey=...`, `apikey:...` —
      // separator between "api" and "key" is optional so the catch-all hits
      // every casing variant a misconfigured upstream might echo back.
      .replace(/api\s*[_-]?\s*key\s*[=:]\s*[^\s'"&]+/gi, 'api_key=[redacted]')
      // Redact IPv4 addresses (cloud-metadata, RFC1918, loopback) so SSRF
      // error messages don't echo the blocked target back to the workflow.
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
      // Best-effort IPv6 redaction (matches `::1`, `fe80::...`, `2001:db8::...`)
      .replace(/\b(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\b/gi, '[ip]')
      .slice(0, 500)
  );
}
