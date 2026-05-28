/**
 * V1 async-push callback delivery.
 *
 * When the caller sends `isAsync: true` + a `callbackUrl`, Kore.ai Agent
 * Assist's V1 contract expects us to:
 *   1. Return an immediate minimal "processing" envelope on the original HTTP call.
 *   2. POST the final envelope to `callbackUrl` once ready.
 *
 * Fire-and-forget direct delivery with a short timeout. Durable delivery
 * with HMAC signing, retries, and dead-letter semantics runs through the
 * BullMQ callback worker (see FR-25 + FR-14).
 */

import { createLogger } from '@abl/compiler/platform';
import { safeFetch } from '@agent-platform/shared-kernel/security/safe-fetch';
import { SIGNATURE_HEADER, resolveSigningSecret, signCallbackPayload } from './callback-signer.js';
import { resolveValidationOptions, validateCallbackUrl } from './callback-url-validator.js';
import type { V1ExecuteResponse } from './types.js';

const log = createLogger('agent-assist:callback-sender');

/** Default HTTP timeout for callback delivery. */
const CALLBACK_TIMEOUT_MS = 10_000;

export interface CallbackDeliveryContext {
  appId: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  runId: string;
}

export interface CallbackDeliveryResult {
  delivered: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

/**
 * Fire-and-forget the callback POST. Never throws — any failure is logged
 * and swallowed so it cannot affect the runtime. Returns the delivery result
 * so tests (and the durable BullMQ callback worker) can await it if needed.
 */
export async function deliverAsyncCallback(
  callbackUrl: string,
  envelope: V1ExecuteResponse,
  ctx: CallbackDeliveryContext,
): Promise<CallbackDeliveryResult> {
  const startedAt = Date.now();
  const urlCheck = validateCallbackUrl(callbackUrl, resolveValidationOptions());
  if (!urlCheck.valid) {
    log.warn('agent-assist async callback refused — invalid URL', {
      appId: ctx.appId,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      reason: urlCheck.reason,
    });
    return { delivered: false, error: urlCheck.reason, durationMs: Date.now() - startedAt };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  const body = JSON.stringify(envelope);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'ABL-Agent-Assist-Compat/1',
    'X-ABL-Source': 'agent-assist-v1',
    'X-ABL-Run-Id': ctx.runId,
    'X-ABL-Event': 'agentic.callback.complete',
  };
  const secret = resolveSigningSecret();
  if (secret) {
    headers[SIGNATURE_HEADER] = signCallbackPayload(body, secret);
  }

  try {
    const response = await safeFetch(
      callbackUrl,
      {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
      },
      { maxRedirects: 0 },
    );
    const durationMs = Date.now() - startedAt;
    if (response.ok) {
      log.info('agent-assist async callback delivered', {
        appId: ctx.appId,
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        host: new URL(callbackUrl).host,
        status: response.status,
        durationMs,
      });
      return { delivered: true, status: response.status, durationMs };
    }
    const bodyPreview = await response.text().then(
      (t) => (t.length > 512 ? t.slice(0, 512) + '…' : t),
      () => '<unreadable>',
    );
    log.warn('agent-assist async callback non-2xx', {
      appId: ctx.appId,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      host: new URL(callbackUrl).host,
      status: response.status,
      bodyPreview,
      durationMs,
    });
    return {
      delivered: false,
      status: response.status,
      error: `non_2xx: ${response.status}`,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof Error
          ? err.message
          : String(err);
    log.error('agent-assist async callback failed', {
      appId: ctx.appId,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      host: new URL(callbackUrl).host,
      reason,
      durationMs,
    });
    return { delivered: false, error: reason, durationMs };
  } finally {
    clearTimeout(timeout);
  }
}
