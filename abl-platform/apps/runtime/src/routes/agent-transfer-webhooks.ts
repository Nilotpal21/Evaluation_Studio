/**
 * Agent Transfer Webhook Routes
 *
 * POST /api/v1/agent-transfer/webhooks/:provider
 *
 * Receives inbound events from agent desktop providers (SmartAssist, etc.).
 * Looks up the transfer session, validates tenant isolation, and routes
 * the event to the adapter for processing.
 */

import { Router, type Request, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import type { XOEvent } from '@agent-platform/agent-transfer';
import {
  KoreEventHandler,
  KoreAdapter,
  Five9EventHandler,
  verifyWebhookSignature,
  createRedisNonceStore,
} from '@agent-platform/agent-transfer';
import { z } from 'zod';
import {
  getTransferSessionStore,
  getAdapterRegistry,
  isAgentTransferInitialized,
  getAgentTransferConfig,
} from '../services/agent-transfer/index.js';
import { getRedisClient } from '../services/redis/redis-client.js';

const router: RouterType = Router();
const log = createLogger('agent-transfer-webhooks');

/** Extended request type for raw body capture middleware */
interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

/**
 * POST /api/v1/agent-transfer/webhooks/:provider
 *
 * Receive an event from an agent desktop provider.
 * The provider sends events like agent:message, agent:connected,
 * agent:disconnected, etc.
 */
router.post('/:provider', async (req, res) => {
  const { provider } = req.params;

  try {
    // 1. Check that agent transfer is initialized
    if (!isAgentTransferInitialized()) {
      log.warn('Agent transfer webhook received but subsystem not initialized', { provider });
      return res.status(503).json({
        success: false,
        error: { code: 'NOT_INITIALIZED', message: 'Agent transfer subsystem not initialized' },
      });
    }

    const registry = getAdapterRegistry();
    const sessionStore = getTransferSessionStore();

    if (!registry || !sessionStore) {
      return res.status(503).json({
        success: false,
        error: { code: 'NOT_INITIALIZED', message: 'Agent transfer subsystem not available' },
      });
    }

    // 2. Validate the provider is registered
    const adapter = registry.get(provider);
    if (!adapter) {
      log.warn('Webhook received for unknown provider', { provider });
      return res.status(404).json({
        success: false,
        error: { code: 'UNKNOWN_PROVIDER', message: 'Provider is not registered' },
      });
    }

    // 3. Parse the event
    const rawBody = req.body as Record<string, unknown> | undefined;
    const rawPayload =
      rawBody && typeof rawBody.payload === 'object' && rawBody.payload !== null
        ? (rawBody.payload as Record<string, unknown>)
        : undefined;
    const transcriptCandidate =
      typeof rawBody?.speech === 'string'
        ? rawBody.speech
        : typeof rawBody?.transcript === 'string'
          ? rawBody.transcript
          : typeof rawPayload?.value === 'string'
            ? rawPayload.value
            : undefined;
    const transcriptPreview =
      typeof transcriptCandidate === 'string' && transcriptCandidate.length > 0
        ? transcriptCandidate.slice(0, 120)
        : undefined;

    log.info('Webhook received', {
      provider,
      bodyKeys: rawBody ? Object.keys(rawBody).slice(0, 25) : [],
      hasType: typeof rawBody?.type === 'string',
      hasEventName: typeof rawBody?.eventName === 'string',
      hasConversationId: typeof rawBody?.conversationId === 'string',
      hasPayloadConversationId: typeof rawPayload?.conversationId === 'string',
      hasSpeech: typeof rawBody?.speech === 'string' || typeof rawBody?.transcript === 'string',
      hasDigits: typeof rawBody?.digits === 'string',
      hasDialStatus:
        typeof rawBody?.dial_call_status === 'string' ||
        typeof rawBody?.dial_sip_status === 'number',
      transcriptPreview,
    });

    const event = req.body as XOEvent;

    // SmartAssist XO webhooks send eventName instead of type — normalize
    if (!event.type && event.eventName) {
      event.type = event.eventName;
    }

    // SmartAssist wraps event data in a payload field — extract to data/message
    if (event.payload && !event.data) {
      event.data = event.payload;
      if (typeof event.payload.value === 'string' && !event.message) {
        event.message = event.payload.value;
      }
      if (!event.conversationId && typeof event.payload.conversationId === 'string') {
        event.conversationId = event.payload.conversationId;
      }
      if (!event.orgId && typeof event.payload.orgId === 'string') {
        event.orgId = event.payload.orgId;
      }
      if (!event.botId && typeof event.payload.botId === 'string') {
        event.botId = event.payload.botId;
      }
      if (!event.agentInfo && event.payload.agentInfo) {
        event.agentInfo = event.payload.agentInfo as Record<string, unknown>;
      }
    }

    if (!event || !event.type || !event.conversationId) {
      log.warn('Malformed webhook event', {
        provider,
        hasType: !!event?.type,
        hasEventName: !!(event as XOEvent)?.eventName,
        hasConversationId: !!event?.conversationId,
        body: JSON.stringify(req.body).slice(0, 500),
      });
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_EVENT',
          message: 'Event must include type/eventName and conversationId',
        },
      });
    }

    // 3a. Verify webhook signature (if secret configured)
    const atConfig = getAgentTransferConfig();
    const webhookSecret = atConfig?.smartassist?.webhookSecret;
    if (webhookSecret) {
      const rawBody = (req as WebhookRequest).rawBody;
      if (!rawBody) {
        log.error('Webhook signature verification requires raw body but middleware is not wired', {
          provider,
        });
        return res.status(500).json({
          success: false,
          error: {
            code: 'SERVER_CONFIGURATION',
            message: 'Webhook verification not available',
          },
        });
      } else {
        const redis = getRedisClient();
        const verification = await verifyWebhookSignature(
          {
            secret: webhookSecret,
            signatureHeader: provider === 'kore' ? 'x-kore-signature' : 'x-webhook-signature',
            timestampHeader: provider === 'kore' ? 'x-kore-timestamp' : 'x-webhook-timestamp',
            ...(redis ? { nonceStore: createRedisNonceStore(redis as any) } : {}),
          },
          req.headers as Record<string, string | string[] | undefined>,
          rawBody,
        );
        if (!verification.valid) {
          log.warn('Webhook signature verification failed', {
            provider,
            error: verification.error,
          });
          return res.status(401).json({
            success: false,
            error: {
              code: 'INVALID_SIGNATURE',
              message: 'Webhook signature verification failed',
            },
          });
        }
      }
    }

    // 3b-five9. Five9 webhooks carry the tenant ID as a query parameter (?tid=)
    if (provider === 'five9') {
      const tidResult = z.string().min(1).safeParse(req.query.tid);
      if (!tidResult.success) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_TENANT',
            message: 'Five9 webhook requires ?tid= query parameter',
          },
        });
      }
      event.orgId = tidResult.data;
    }

    // 3c. Resolve orgId — SmartAssist may omit orgId from some event types.
    //     Fall back to the adapter's resolved orgId (fetched lazily via getAccountIdByBotId).
    if (!event.orgId && provider === 'smartassist' && adapter instanceof KoreAdapter) {
      const fallbackOrgId = adapter.getOrgId();
      if (fallbackOrgId) {
        log.info('Resolved missing orgId from adapter config', {
          provider,
          conversationId: event.conversationId,
          orgId: fallbackOrgId,
        });
        event.orgId = fallbackOrgId;
      }
    }

    if (!event.orgId) {
      log.warn('Webhook event missing orgId (tenantId)', {
        provider,
        conversationId: event.conversationId,
      });
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_TENANT', message: 'Event must include orgId for tenant isolation' },
      });
    }

    // 3d. Normalize XO event type to ABL format before processing
    const normalizedType =
      provider === 'five9'
        ? Five9EventHandler.mapEventType(event.type)
        : KoreEventHandler.mapEventType(event.type);
    if (normalizedType) {
      log.info('Normalized event type', {
        provider,
        originalType: event.type,
        normalizedType,
      });
    }

    // 4. Look up the transfer session by provider + tenant + session ID
    const session = await sessionStore.getByProvider(provider, event.orgId, event.conversationId);
    if (!session) {
      log.warn('Webhook for unknown session', {
        provider,
        conversationId: event.conversationId,
      });
      return res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'No active transfer session found' },
      });
    }

    // 5. Validate tenant isolation — orgId from the event must match either:
    //    (a) the ABL tenantId, or
    //    (b) the provider's orgId stored in providerData (e.g. Kore orgId).
    //    The session was found via getByProvider which uses tenant-scoped index
    //    keys, so a match on the provider orgId is legitimate.
    if (event.orgId && event.orgId !== session.tenantId) {
      let providerOrgId: string | undefined;
      const providerDataRaw = session.providerData;
      if (providerDataRaw && typeof providerDataRaw === 'object') {
        providerOrgId = (providerDataRaw as Record<string, unknown>).orgId as string | undefined;
      } else if (typeof providerDataRaw === 'string') {
        try {
          const pd = JSON.parse(providerDataRaw);
          providerOrgId = pd?.orgId;
        } catch {
          // providerData not parseable
        }
      }

      if (!providerOrgId || event.orgId !== providerOrgId) {
        log.warn('Tenant mismatch in webhook event', {
          provider,
          eventOrgId: event.orgId,
          sessionTenantId: session.tenantId,
        });
        // Return 404 to avoid leaking session existence (per platform invariant)
        return res.status(404).json({
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'No active transfer session found' },
        });
      }
    }

    // 6. Pass event to adapter for processing.
    //    The adapter's handleInboundEvent() normalizes the event type,
    //    extends session TTL, and fires onAgentMessage callbacks which
    //    route through the message bridge. No direct bridge call or
    //    duplicate TTL extension needed here.
    await adapter.handleInboundEvent(event, session.tenantId);

    log.info('Webhook event processed', {
      provider,
      eventType: event.type,
      normalizedType: normalizedType ?? 'unknown',
      conversationId: event.conversationId,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    log.error('Failed to process webhook event', {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'PROCESSING_ERROR', message: 'Failed to process event' },
    });
  }
});

export default router;
