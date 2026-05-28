/**
 * Webhook Handler
 *
 * Handles inbound webhook POSTs for connector triggers.
 * Security: HMAC signature verification (connector-specific or generic SHA-256),
 * replay protection via timestamp check, idempotency via event ID dedup.
 *
 * Does NOT import Express directly — receives a router builder and dependencies
 * via injection for testability. The actual Express wiring lives in the
 * workflow-engine app.
 */

import crypto from 'crypto';
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { createLogger } from '../logger.js';
import type { ConnectorRegistry } from '../registry.js';
import type {
  TriggerRegistrationModel,
  TriggerRedisClient,
  RestateIngressClient,
  DecryptSecretFn,
} from './types.js';
import {
  WEBHOOK_DEDUP_WINDOW_MS,
  WEBHOOK_REPLAY_TOLERANCE_MS,
  TRIGGER_AUTO_PAUSE_THRESHOLD,
} from './constants.js';

const log = createLogger('webhook-handler');

const tracer = trace.getTracer('abl-connectors', '1.0.0');

/** Incoming webhook request — framework-agnostic */
export interface WebhookRequest {
  params: { connectorName: string; registrationId: string };
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
}

/** Webhook processing result */
export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** Dependencies for the webhook handler */
export interface WebhookHandlerDeps {
  registry: ConnectorRegistry;
  registrationModel: TriggerRegistrationModel;
  redis: TriggerRedisClient;
  restateClient: RestateIngressClient;
  decryptSecret: DecryptSecretFn;
  /**
   * Resolves workflow name + step definitions for the Restate invocation.
   * Required to pass `steps` so the workflow-handler knows what to execute.
   * When absent, Restate receives an empty steps array and the workflow
   * completes immediately with no step execution.
   */
  workflowResolver?: {
    resolve(opts: {
      workflowId: string;
      tenantId: string;
      projectId: string;
    }): Promise<{ workflowName: string; steps: unknown[] } | null>;
  };
}

/**
 * Process an incoming webhook request.
 *
 * Steps:
 * 1. Load trigger registration (tenant-scoped)
 * 2. Connector-specific signature verification
 * 3. Generic HMAC-SHA256 fallback
 * 4. Replay protection (timestamp check)
 * 5. Idempotency (event ID dedup via Redis)
 * 6. Invoke Restate workflow
 * 7. Update trigger health
 */
export async function handleWebhook(
  req: WebhookRequest,
  deps: WebhookHandlerDeps,
): Promise<WebhookResult> {
  const { connectorName, registrationId } = req.params;

  return tracer.startActiveSpan(
    'connector.webhook',
    {
      attributes: {
        'connector.name': connectorName,
        'registration.id': registrationId,
      },
    },
    async (span: Span) => {
      try {
        const result = await processWebhook(req, deps, connectorName, registrationId, span);
        if (result.status >= 400) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message:
              typeof result.body.error === 'object' && result.body.error !== null
                ? ((result.body.error as { message?: string }).message ?? `HTTP ${result.status}`)
                : String(result.body.error ?? `HTTP ${result.status}`),
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof Error) {
          span.recordException(err);
        }
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Internal webhook processing logic — separated for span wrapping */
async function processWebhook(
  req: WebhookRequest,
  deps: WebhookHandlerDeps,
  connectorName: string,
  registrationId: string,
  span: Span,
): Promise<WebhookResult> {
  // 1. Load registration
  const registration = await deps.registrationModel.findOne({
    _id: registrationId,
    connectorName,
    status: 'active',
  });

  if (!registration) {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } };
  }

  span.setAttribute('tenant.id', registration.tenantId);

  // 2. Reject if signature verification is expected but rawBody is missing
  if (registration.webhookSecret && !req.rawBody) {
    return {
      status: 400,
      body: {
        error: { code: 'BAD_REQUEST', message: 'Missing raw body for signature verification' },
      },
    };
  }

  // 3. Connector-specific signature verification (lazy-loads connector on first use)
  const connector = await deps.registry.get(connectorName);
  const trigger = connector.triggers.find((t) => t.name === registration.triggerName);

  if (trigger?.verify && req.rawBody) {
    const auth = registration.webhookSecret
      ? { secret: await deps.decryptSecret(registration.webhookSecret, registration.tenantId) }
      : {};

    const isValid = await trigger.verify({
      headers: normalizeHeaders(req.headers),
      body: req.body,
      rawBody: req.rawBody,
      auth,
    });

    if (!isValid) {
      return {
        status: 401,
        body: { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } },
      };
    }
  }

  // 3. Generic HMAC-SHA256 fallback (if connector doesn't have verify())
  if (!trigger?.verify && registration.webhookSecret && req.rawBody) {
    const signature =
      getHeader(req.headers, 'x-signature-256') || getHeader(req.headers, 'x-hub-signature-256');

    if (!signature) {
      return {
        status: 401,
        body: { error: { code: 'MISSING_SIGNATURE', message: 'Missing signature' } },
      };
    }

    const secret = await deps.decryptSecret(registration.webhookSecret, registration.tenantId);
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const sig = String(signature).replace(/^sha256=/, '');

    // Timing-safe comparison to prevent timing attacks
    try {
      const sigBuf = Buffer.from(sig, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return {
          status: 401,
          body: { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } },
        };
      }
    } catch (err: unknown) {
      log.debug('Signature comparison failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 401,
        body: { error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } },
      };
    }
  }

  // 4. Replay protection: reject stale events
  const timestamp =
    getHeader(req.headers, 'x-webhook-timestamp') ||
    getHeader(req.headers, 'x-slack-request-timestamp');

  if (timestamp) {
    // Parse as Unix epoch seconds (integer) or ISO 8601 string
    const tsStr = String(timestamp);
    const tsNum = Number(tsStr);
    const eventTime =
      !isNaN(tsNum) && tsNum > 0
        ? tsNum < 1e12
          ? tsNum * 1000
          : tsNum // seconds vs milliseconds
        : new Date(tsStr).getTime();
    if (isNaN(eventTime)) {
      return {
        status: 400,
        body: { error: { code: 'BAD_REQUEST', message: 'Invalid timestamp' } },
      };
    }
    const eventAge = Math.abs(Date.now() - eventTime);
    if (eventAge > WEBHOOK_REPLAY_TOLERANCE_MS) {
      return {
        status: 401,
        body: { error: { code: 'REPLAY_DETECTED', message: 'Replay detected' } },
      };
    }
  }

  // 5. Idempotency: deduplicate by event ID
  const eventId =
    getHeader(req.headers, 'x-webhook-id') || getHeader(req.headers, 'x-github-delivery');

  if (eventId) {
    // Hash event ID to prevent Redis key injection from unsanitized header values
    const safeEventId = crypto.createHash('sha256').update(eventId).digest('hex');
    const deduped = await deps.redis.set(
      `webhook:dedup:${safeEventId}`,
      '1',
      'PX',
      WEBHOOK_DEDUP_WINDOW_MS,
      'NX',
    );
    if (!deduped) {
      return { status: 200, body: { ok: true, deduplicated: true } };
    }
  }

  // 6. Invoke Restate workflow
  const executionId = crypto.randomUUID();

  // Resolve workflow definition (name + steps) so Restate has the full
  // execution plan. Without steps the workflow completes instantly.
  let workflowName = '';
  let steps: unknown[] = [];
  if (deps.workflowResolver) {
    const wf = await deps.workflowResolver.resolve({
      workflowId: registration.workflowId,
      tenantId: registration.tenantId,
      projectId: registration.projectId,
    });
    if (wf) {
      workflowName = wf.workflowName;
      steps = wf.steps;
    }
  }

  try {
    await deps.restateClient.startWorkflow(executionId, {
      workflowId: registration.workflowId,
      workflowName,
      ...(registration.workflowVersionId
        ? { workflowVersionId: registration.workflowVersionId }
        : {}),
      tenantId: registration.tenantId,
      projectId: registration.projectId,
      triggerType: 'event',
      triggerPayload: (req.body as Record<string, unknown>) ?? {},
      triggerMetadata: {
        connectorName,
        triggerName: registration.triggerName,
        registrationId,
        firedAt: new Date().toISOString(),
      },
      steps,
    });

    // 7. Update trigger health — reset error counter
    await deps.registrationModel.findOneAndUpdate(
      { _id: registrationId, tenantId: registration.tenantId },
      { $set: { lastFiredAt: new Date(), consecutiveErrors: 0 } },
    );

    return { status: 200, body: { ok: true, executionId } };
  } catch (err: unknown) {
    log.error('Webhook workflow invocation failed', {
      registrationId,
      connectorName,
      error: err instanceof Error ? err.message : String(err),
    });
    // Track consecutive errors, auto-pause after threshold
    const updated = await deps.registrationModel.findOneAndUpdate(
      { _id: registrationId, tenantId: registration.tenantId },
      { $inc: { consecutiveErrors: 1 }, $set: { lastErrorAt: new Date() } },
      { new: true },
    );

    if (updated && updated.consecutiveErrors >= TRIGGER_AUTO_PAUSE_THRESHOLD) {
      await deps.registrationModel.findOneAndUpdate(
        { _id: registrationId, tenantId: registration.tenantId },
        { $set: { status: 'error' } },
      );
    }

    return {
      status: 503,
      body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Workflow engine unavailable' } },
    };
  }
}

/** Normalize headers to string values */
function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
  }
  return normalized;
}

/** Get a single header value (case-insensitive) */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return undefined;
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}
