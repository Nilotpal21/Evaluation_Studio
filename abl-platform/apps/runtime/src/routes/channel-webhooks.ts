/**
 * Generic Channel Webhook Route
 *
 * POST /api/v1/channels/:channelType/webhook                    — generic (identifier from body)
 * POST /api/v1/channels/:channelType/webhook/:connectionIdentifier — explicit identifier in URL
 *
 * Handles inbound webhooks from external platforms (Slack, WhatsApp, etc.).
 * The generic route extracts the identifier from the parsed body (e.g. team_id:app_id).
 * The explicit route uses the identifier from the URL path.
 *
 * The flow is:
 *   1. Look up adapter from channel registry
 *   2. Handle verification challenges (e.g., Slack url_verification)
 *   3. Filter events (skip bot messages, etc.)
 *   4. Resolve channel connection via URL identifier → tenant/project
 *   5. Verify request signature (using per-connection secrets)
 *   6. Normalize message
 *   7. Enqueue to BullMQ channel-inbound queue
 *   8. Return 200 quickly (Slack requires < 3s ACK)
 */

import express, { Router, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { getCurrentTraceId, getObservabilityContext } from '@abl/compiler/platform/observability';
import { injectTrace } from '@agent-platform/shared-observability/tracing';
import { getChannelRegistry } from '../channels/registry.js';
import type { ChannelType, InboundJobPayload } from '../channels/types.js';
import { WEBHOOK_CAPABLE_TYPES, META_WEBHOOK_TYPES } from '../channels/manifest.js';
import { resolveWhatsAppProvider } from '../channels/adapters/whatsapp-provider.js';

const router: RouterType = Router();
const log = createLogger('channel-webhooks');

// Slack interactive payloads (block_actions, view_submission) are sent as
// application/x-www-form-urlencoded with a `payload` field containing URL-encoded JSON.
// The global JSON body parser ignores this Content-Type, so we add a urlencoded parser here.
router.use(
  express.urlencoded({
    extended: false,
    limit: '1mb',
    verify: (req: any, _res, buf) => {
      // Capture raw body for signature verification (same pattern as JSON parser in server.ts).
      // Do NOT overwrite rawBody if already set by the JSON parser.
      if (!req.rawBody) {
        req.rawBody = buf;
      }
    },
  }),
);

/** Channel types accepting inbound webhooks — derived from channel manifest. */
const ALLOWED_CHANNEL_TYPES = WEBHOOK_CAPABLE_TYPES;
type SuccessResponseMode = 'json_ok' | 'empty_200';

function maskIdentifier(value: string): string {
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '***' + value.slice(-4);
}

function sendWebhookSuccessResponse(
  res: import('express').Response,
  channelType: ChannelType,
  body: unknown,
  successResponse: SuccessResponseMode,
): void {
  if (channelType === 'slack' && (body as { type?: string } | null)?.type === 'view_submission') {
    res.status(200).json({ response_action: 'clear' });
    return;
  }

  // Twilio expects TwiML response — return empty Response to suppress inline auto-reply
  if (channelType === 'twilio_sms') {
    res.set('Content-Type', 'text/xml');
    res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  if (successResponse === 'empty_200') {
    res.sendStatus(200);
    return;
  }

  res.status(200).json({ ok: true });
}

function resolveWebhookRawBody(
  req: import('express').Request,
  channelType: ChannelType,
): Buffer | undefined {
  const rawBody = (req as { rawBody?: Buffer | string }).rawBody;
  if (rawBody) {
    return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  }

  // Slack signs the original form payload for interactive callbacks and slash commands.
  // If an upstream urlencoded parser already consumed the stream, reconstruct the
  // canonical form body from the parsed fields so HMAC verification still happens
  // against the transport payload shape rather than the parsed JSON body.
  if (channelType === 'slack' && req.is('application/x-www-form-urlencoded')) {
    const formBody = req.body;
    if (formBody && typeof formBody === 'object') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(formBody as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            params.append(key, String(item));
          }
          continue;
        }

        if (value !== undefined) {
          params.append(key, String(value));
        }
      }

      const serialized = params.toString();
      if (serialized) {
        log.debug('Reconstructed missing raw Slack form body for signature verification', {
          channelType,
        });
        return Buffer.from(serialized, 'utf8');
      }
    }
  }

  return undefined;
}

/**
 * GET /api/v1/channels/:channelType/webhook
 *
 * Meta webhook verification (Messenger, WhatsApp). Meta sends a GET request
 * with hub.mode, hub.verify_token, and hub.challenge query parameters during
 * webhook setup. We verify the token and echo back the challenge as plain text.
 *
 * The verify_token is stored per-connection in encrypted credentials. We use
 * a SHA-256 hash of the verify_token (indexed on the connection document) to
 * look up the matching connection in a single query.
 */
/** Channel types using Meta webhook verification — derived from channel manifest. */
const META_CHANNEL_TYPES = META_WEBHOOK_TYPES;

router.get('/:channelType/webhook', async (req, res) => {
  try {
    const channelType = req.params.channelType as string;

    if (!META_CHANNEL_TYPES.has(channelType)) {
      return res.status(404).send('GET verification not supported for this channel');
    }

    const registry = getChannelRegistry();
    const adapter = registry.get(channelType as any);

    if (!adapter || typeof (adapter as any).handleWebhookVerification !== 'function') {
      return res.status(404).send('Adapter does not support webhook verification');
    }

    const query = req.query as Record<string, string>;
    const verifyToken = query['hub.verify_token'];

    // Resolve the connection by verify_token hash (indexed lookup)
    let connection = null;
    if (verifyToken) {
      const { resolveConnectionByVerifyToken } = await import('../channels/connection-resolver.js');
      connection = await resolveConnectionByVerifyToken(channelType as any, verifyToken);
    }

    const challenge = (adapter as any).handleWebhookVerification(query, connection);

    if (challenge) {
      log.info('Webhook verification successful', {
        channelType,
        connectionId: connection?.id,
      });
      return res.status(200).send(challenge);
    }

    log.warn('Webhook verification failed', { channelType });
    return res.status(403).send('Verification failed');
  } catch (error) {
    log.error('Webhook verification error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Shared webhook POST handler logic.
 * Used by both the path-based route (Slack, etc.) and the body-based route (Meta channels).
 */
async function handleWebhookPost(
  channelType: ChannelType,
  externalIdentifier: string,
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
  options: { successResponse?: SuccessResponseMode; providerHint?: string } = {},
): Promise<void> {
  const successResponse = options.successResponse ?? 'json_ok';
  const providerHint = options.providerHint;

  // 1. Look up adapter
  const registry = getChannelRegistry();
  const adapter = registry.get(channelType);

  if (!adapter) {
    log.warn('No adapter registered for channel type', { channelType });
    res.status(404).json({ error: `Unknown channel type: ${channelType}` });
    return;
  }

  // Extract Slack interactive payloads: form-urlencoded with a `payload` JSON field.
  // The urlencoded middleware parses the form body, but the actual event data is inside
  // the `payload` string field. Parse it here before any adapter calls.
  let body = req.body;
  if (body?.payload && typeof body.payload === 'string') {
    try {
      body = JSON.parse(body.payload);
    } catch (err) {
      log.warn('Failed to parse Slack interactive payload', {
        channelType,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(400).send('Invalid payload');
      return;
    }
  }

  const verificationChallenge =
    typeof (adapter as any).handleVerificationChallenge === 'function'
      ? (adapter as any).handleVerificationChallenge(body)
      : null;

  // 3. Pre-connection filter: cheap checks that don't need connection context
  if (!verificationChallenge && providerHint && channelType === 'whatsapp') {
    const provider = resolveWhatsAppProvider(providerHint);
    if (!provider.shouldProcess(body)) {
      res.status(200).json({ ok: true });
      return;
    }
  } else if (!verificationChallenge && typeof (adapter as any).shouldProcess === 'function') {
    if (!(adapter as any).shouldProcess(body)) {
      // Event filtered out (bot message, irrelevant subtype, etc.)
      sendWebhookSuccessResponse(res, channelType, body, successResponse);
      return;
    }
  }

  // 4. Resolve channel connection
  const { resolveChannelConnection } = await import('../channels/connection-resolver.js');
  const connection = await resolveChannelConnection(channelType, externalIdentifier);

  if (!connection) {
    log.warn('No channel connection found', {
      channelType,
      externalIdentifier: maskIdentifier(externalIdentifier),
    });
    res.status(404).json({ error: 'Channel not configured for this workspace' });
    return;
  }

  // 4b. Post-connection filter: checks that need connection context (e.g. group chat bot mentions)
  if (!verificationChallenge && providerHint && channelType === 'whatsapp') {
    const provider = resolveWhatsAppProvider(providerHint);
    if (!provider.shouldProcess(body)) {
      sendWebhookSuccessResponse(res, channelType, body, successResponse);
      return;
    }
  } else if (!verificationChallenge && typeof (adapter as any).shouldProcess === 'function') {
    if (!(adapter as any).shouldProcess(body, connection)) {
      sendWebhookSuccessResponse(res, channelType, body, successResponse);
      return;
    }
  }

  // 5. Verify request signature (with connection credentials for per-connection secrets)
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
  }

  // NOTE: for form-urlencoded payloads (Slack interactive), `body` here is the
  // parsed inner JSON — not the raw form string Slack signed. Signature verification
  // MUST use `rawBody` (the original wire bytes) and MUST NOT use `body` for HMAC.
  const rawBody = resolveWebhookRawBody(req, channelType);

  // Build full webhook URL for adapters that need it (e.g., Twilio HMAC-SHA1).
  // Use the configured public base URL to avoid proxy/header mismatches — same
  // pattern as voice.ts and channel-connections.ts.
  const runtimeBaseUrl = (
    process.env.RUNTIME_PUBLIC_BASE_URL ||
    process.env.RUNTIME_BASE_URL ||
    `${req.protocol}://${req.get('host') || 'localhost:3112'}`
  ).replace(/\/+$/, '');
  const fullWebhookUrl = `${runtimeBaseUrl}${req.originalUrl}`;

  const isValid = await adapter.verifyRequest(headers, body, rawBody, connection, fullWebhookUrl);
  if (!isValid) {
    log.warn('Webhook signature verification failed', { channelType });
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  if (verificationChallenge) {
    log.info('Responding to verification challenge', { channelType });
    res.json({ challenge: verificationChallenge });
    return;
  }

  // 6. Normalize one or more inbound messages
  let normalizedMessages: Array<{
    message: InboundJobPayload['message'];
    eventId: string | null;
  }> = [];

  if (typeof (adapter as any).buildNormalizedMessages === 'function') {
    const built = (adapter as any).buildNormalizedMessages(body, connection);
    if (!Array.isArray(built)) {
      log.error('Adapter returned invalid buildNormalizedMessages result', { channelType });
      res.status(500).json({ error: 'Adapter configuration error' });
      return;
    }

    normalizedMessages = built
      .map((item: unknown) => {
        if (item && typeof item === 'object' && 'message' in item) {
          const batchItem = item as {
            message?: InboundJobPayload['message'];
            eventId?: string | null;
          };
          if (!batchItem.message) return null;
          return {
            message: batchItem.message,
            eventId: batchItem.eventId ?? null,
          };
        }

        return {
          message: item as InboundJobPayload['message'],
          eventId: null,
        };
      })
      .filter(
        (
          item,
        ): item is {
          message: InboundJobPayload['message'];
          eventId: string | null;
        } => item !== null,
      );
  } else if (providerHint && channelType === 'whatsapp') {
    const provider = resolveWhatsAppProvider(providerHint);
    const eventId = provider.extractEventId(body);
    normalizedMessages = [
      {
        message: provider.buildNormalizedMessage(body),
        eventId,
      },
    ];
  } else if (typeof (adapter as any).buildNormalizedMessage === 'function') {
    let eventId: string | null = null;
    if (typeof (adapter as any).extractEventId === 'function') {
      eventId = (adapter as any).extractEventId(body);
    }

    normalizedMessages = [
      {
        message: (adapter as any).buildNormalizedMessage(body, connection),
        eventId,
      },
    ];
  } else {
    log.error('Adapter missing buildNormalizedMessage', { channelType });
    res.status(500).json({ error: 'Adapter configuration error' });
    return;
  }

  if (normalizedMessages.length === 0) {
    sendWebhookSuccessResponse(res, channelType, body, successResponse);
    return;
  }

  // 7. Enqueue to BullMQ
  try {
    const { getInboundQueue } = await import('../services/queues/channel-queues.js');
    const queue = getInboundQueue();

    if (!queue) {
      log.error('Inbound queue not available');
      res.status(503).json({ error: 'Queue unavailable' });
      return;
    }

    for (const normalized of normalizedMessages) {
      const idempotencyKey = normalized.eventId || normalized.message.externalMessageId;
      const jobPayload: InboundJobPayload = {
        connectionId: connection.id,
        tenantId: connection.tenantId,
        projectId: connection.projectId,
        agentId: connection.agentId,
        deploymentId: connection.deploymentId ?? undefined,
        environment: connection.environment ?? undefined,
        channelType,
        message: normalized.message,
        subscriptionId: '', // Not used for direct-send channels like Slack
        idempotencyKey,
        traceId: getCurrentTraceId(),
      };

      // Inject full span context (traceId + spanId + parentSpanId) for cross-boundary propagation.
      // Falls back to traceId-only if no active observability context.
      const obsCtx = getObservabilityContext();
      if (obsCtx) {
        injectTrace(jobPayload as unknown as Record<string, unknown>, {
          traceId: obsCtx.traceId,
          spanId: obsCtx.spanId,
        });
      }

      // Sanitize job ID: BullMQ disallows colons in custom IDs
      const safeKey = idempotencyKey.replace(/:/g, '-');
      await queue.add('process-message', jobPayload, {
        jobId: `${channelType}-${connection.tenantId}-${safeKey}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    }

    log.info('Webhook enqueued', {
      channelType,
      messageCount: normalizedMessages.length,
      connectionId: connection.id,
    });

    // Return 200 quickly — Slack requires < 3s response.
    sendWebhookSuccessResponse(res, channelType, body, successResponse);
  } catch (error) {
    log.error('Failed to enqueue webhook', {
      channelType,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    res.status(503).json({ error: 'Queue temporarily unavailable' });
  }
}

// Provider-specific webhook route (e.g., /whatsapp/infobip/webhook).
// The provider is known from the URL path, so we use it directly.
router.post('/:channelType/:provider/webhook', async (req, res, next) => {
  try {
    const channelType = req.params.channelType as ChannelType;
    const providerId = req.params.provider;

    if (!ALLOWED_CHANNEL_TYPES.has(channelType)) {
      return res.status(400).json({ error: `Unsupported channel type: ${channelType}` });
    }

    // Provider-specific routing is currently only supported for whatsapp
    if (channelType !== 'whatsapp') {
      return res.status(400).json({ error: `Provider routing not supported for ${channelType}` });
    }

    // Provider registration is tied to channel registry initialization.
    getChannelRegistry();

    // Resolve provider and extract identifier
    let externalIdentifier: string | null = null;
    try {
      const provider = resolveWhatsAppProvider(providerId);
      externalIdentifier = provider.extractExternalIdentifier(req.body);
    } catch {
      return res.status(400).json({ error: `Unknown provider: ${providerId}` });
    }

    if (!externalIdentifier) {
      log.warn('Could not extract external identifier from body', { channelType, providerId });
      return res.status(400).json({ error: 'Missing external identifier' });
    }

    await handleWebhookPost(channelType, externalIdentifier, req, res, next, {
      providerHint: providerId,
    });
  } catch (error) {
    log.error('Unhandled webhook error (provider route)', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    next(error);
  }
});

// Provider-specific webhook route with explicit identifier
router.post('/:channelType/:provider/webhook/:connectionIdentifier', async (req, res, next) => {
  try {
    const channelType = req.params.channelType as ChannelType;
    const providerId = req.params.provider;

    if (!ALLOWED_CHANNEL_TYPES.has(channelType)) {
      return res.status(400).json({ error: `Unsupported channel type: ${channelType}` });
    }

    // Provider-specific routing is currently only supported for whatsapp
    if (channelType !== 'whatsapp') {
      return res.status(400).json({ error: `Provider routing not supported for ${channelType}` });
    }

    // Provider registration is tied to channel registry initialization.
    getChannelRegistry();

    // Validate provider exists
    try {
      resolveWhatsAppProvider(providerId);
    } catch {
      return res.status(400).json({ error: `Unknown provider: ${providerId}` });
    }

    const externalIdentifier = decodeURIComponent(req.params.connectionIdentifier);
    await handleWebhookPost(channelType, externalIdentifier, req, res, next, {
      providerHint: providerId,
    });
  } catch (error) {
    log.error('Unhandled webhook error (provider route)', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    next(error);
  }
});

// Generic webhook route (no identifier in URL).
// Used as the Slack Event Subscriptions URL for multi-workspace apps.
// The identifier is extracted from the parsed request body via the adapter.
router.post('/:channelType/webhook', async (req, res, next) => {
  try {
    const channelType = req.params.channelType as ChannelType;
    if (!ALLOWED_CHANNEL_TYPES.has(channelType)) {
      log.warn('Rejected webhook for unknown channel type', { channelType });
      return res.status(400).json({ error: `Unsupported channel type: ${channelType}` });
    }

    const registry = getChannelRegistry();
    const adapter = registry.get(channelType);
    if (!adapter) {
      return res.status(404).json({ error: `Unknown channel type: ${channelType}` });
    }

    // Parse form-encoded interactive payloads (e.g. Slack block_actions)
    let body = req.body;
    if (body?.payload && typeof body.payload === 'string') {
      try {
        body = JSON.parse(body.payload);
      } catch {
        return res.status(400).send('Invalid payload');
      }
    }

    const verificationChallenge =
      typeof (adapter as any).handleVerificationChallenge === 'function'
        ? (adapter as any).handleVerificationChallenge(body)
        : null;

    // Extract identifier from the parsed body
    let externalIdentifier: string | null = null;
    if (typeof (adapter as any).extractExternalIdentifier === 'function') {
      externalIdentifier = (adapter as any).extractExternalIdentifier(body);
    }

    if (!externalIdentifier) {
      if (verificationChallenge) {
        // TODO(channel-hardening): Stop answering generic verification challenges until a
        // connection identifier is resolved and the request can be verified against the
        // scoped channel connection instead of responding on the public fallback path.
        log.info('Responding to unrouted verification challenge (generic route)', { channelType });
        return res.json({ challenge: verificationChallenge });
      }

      log.warn('Could not extract external identifier from body', { channelType });
      return res.status(400).json({ error: 'Missing external identifier' });
    }

    await handleWebhookPost(channelType, externalIdentifier, req, res, next);
  } catch (error) {
    log.error('Unhandled webhook error (generic route)', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    next(error);
  }
});

// Dedicated Slack slash-command endpoint. Slack command registration points
// directly to this route because slash commands use a different form-encoded
// payload contract than the Events API.
router.post('/slack/slash/:connectionIdentifier', async (req, res, next) => {
  await handleWebhookPost(
    'slack',
    decodeURIComponent(req.params.connectionIdentifier),
    req,
    res,
    next,
    { successResponse: 'empty_200' },
  );
});

// Webhook URL with explicit identifier for connection routing:
//   /api/v1/channels/slack/webhook/T051VGKPZU1:A0AE36W3M2B
// This handles all payload types (event_callback, block_actions, view_submission)
// without needing to parse the body for routing.
router.post('/:channelType/webhook/:connectionIdentifier', async (req, res, next) => {
  try {
    const channelType = req.params.channelType as ChannelType;
    if (!ALLOWED_CHANNEL_TYPES.has(channelType)) {
      log.warn('Rejected webhook for unknown channel type', { channelType });
      return res.status(400).json({ error: `Unsupported channel type: ${channelType}` });
    }
    const externalIdentifier = decodeURIComponent(req.params.connectionIdentifier);
    await handleWebhookPost(channelType, externalIdentifier, req, res, next);
  } catch (error) {
    log.error('Unhandled webhook error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    next(error);
  }
});

export default router;
