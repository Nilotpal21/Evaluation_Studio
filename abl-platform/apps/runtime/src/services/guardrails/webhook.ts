/**
 * Async webhook delivery for guardrail events.
 *
 * Signs payloads with HMAC-SHA256 using a per-webhook secret.
 * Retries up to 3 times with exponential backoff (1s, 4s, 16s).
 * 10-second timeout per delivery attempt.
 *
 * Non-retryable: 4xx status codes (except 429).
 * Retryable: 5xx, 429, network errors, timeouts.
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { getObservabilityContext } from '@abl/compiler/platform/observability';
import { assertUrlSafeForSSRF, getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

const log = createLogger('guardrail-webhook');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of retry attempts after the initial attempt */
const MAX_RETRIES = 3;

/** Exponential backoff delays in ms: 1s, 4s, 16s */
const RETRY_DELAYS_MS = [1000, 4000, 16000];

/** Per-attempt timeout in ms */
const WEBHOOK_TIMEOUT_MS = 10000;

/**
 * Format a W3C traceparent header from trace/span IDs.
 * Version 00, trace-flags 01 (sampled).
 */
function formatTraceparentHeader(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookConfig {
  /** URL to POST webhook payloads to */
  url: string;
  /** Secret used for HMAC-SHA256 signature */
  secret: string;
  /** Optional event type filter: only deliver these event types (empty/undefined = all) */
  events?: string[];
}

export interface WebhookDeliveryResult {
  /** Whether delivery succeeded */
  success: boolean;
  /** HTTP status code from the last attempt (if any) */
  statusCode?: number;
  /** Total number of delivery attempts made (0 if skipped by filter) */
  attempts: number;
  /** Error message if delivery failed */
  error?: string;
}

// ---------------------------------------------------------------------------
// GuardrailWebhookDelivery
// ---------------------------------------------------------------------------

/**
 * Async webhook delivery with HMAC-SHA256 signing and retry.
 *
 * Signs the payload with HMAC-SHA256 using the webhook secret.
 * Signature is in the X-Guardrail-Signature header.
 * Retries up to 3 times with exponential backoff (1s, 4s, 16s).
 * 10s timeout per attempt.
 */
export class GuardrailWebhookDelivery {
  private config: WebhookConfig;

  constructor(config: WebhookConfig) {
    assertUrlSafeForSSRF(config.url, getDevSSRFOptions());
    this.config = config;
  }

  /**
   * Sign the payload with HMAC-SHA256.
   * Returns the hex-encoded signature string.
   */
  sign(payload: string): string {
    return crypto.createHmac('sha256', this.config.secret).update(payload).digest('hex');
  }

  /**
   * Check if the event type should be delivered based on the configured filter.
   * Returns true if no filter is set or the filter is empty (deliver all).
   */
  shouldDeliver(eventType: string): boolean {
    if (!this.config.events || this.config.events.length === 0) {
      return true;
    }
    return this.config.events.includes(eventType);
  }

  /**
   * Deliver a guardrail event via webhook with retry.
   *
   * - Filters events based on config before attempting delivery.
   * - Signs the JSON payload with HMAC-SHA256.
   * - Retries on 5xx, 429, network errors, and timeouts.
   * - Does NOT retry on 4xx errors (except 429).
   */
  async deliver(event: {
    type: string;
    timestamp: number;
    data: Record<string, unknown>;
  }): Promise<WebhookDeliveryResult> {
    if (!this.shouldDeliver(event.type)) {
      return { success: true, attempts: 0 };
    }

    const payload = JSON.stringify(event);
    const signature = this.sign(payload);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const baseDelay = RETRY_DELAYS_MS[attempt - 1];
          const jitteredDelay = baseDelay * (0.75 + Math.random() * 0.5);
          await new Promise((resolve) => setTimeout(resolve, jitteredDelay));
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

        try {
          // Build headers with trace propagation
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Guardrail-Signature': signature,
            'X-Guardrail-Event': event.type,
          };
          const obsCtx = getObservabilityContext();
          if (obsCtx?.traceId) {
            headers['traceparent'] = formatTraceparentHeader(obsCtx.traceId, obsCtx.spanId);
            headers['X-Trace-Id'] = obsCtx.traceId;
          }

          const response = await fetch(this.config.url, {
            method: 'POST',
            headers,
            body: payload,
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (response.ok) {
            return { success: true, statusCode: response.status, attempts: attempt + 1 };
          }

          // Non-retryable: 4xx except 429 (rate limited)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            return {
              success: false,
              statusCode: response.status,
              attempts: attempt + 1,
              error: `HTTP ${response.status}`,
            };
          }

          // Retryable: 5xx, 429
          log.warn('Webhook delivery failed, will retry', {
            url: this.config.url,
            status: response.status,
            attempt: attempt + 1,
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (attempt >= MAX_RETRIES) {
          return {
            success: false,
            attempts: attempt + 1,
            error: errorMsg,
          };
        }
        log.warn('Webhook delivery error, will retry', {
          url: this.config.url,
          error: errorMsg,
          attempt: attempt + 1,
        });
      }
    }

    return { success: false, attempts: MAX_RETRIES + 1, error: 'Max retries exceeded' };
  }
}
