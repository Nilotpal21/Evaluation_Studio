/**
 * Inbound Webhook Routes
 *
 * Receives webhook POSTs from external providers (GitHub, Slack, Stripe, …) for
 * connector-native triggers. Delegates to the framework-agnostic `handleWebhook`
 * processor in @agent-platform/connectors, which performs:
 *   - registration lookup (tenant-scoped)
 *   - HMAC signature verification (connector-specific or generic SHA-256)
 *   - replay protection + event-ID dedup
 *   - Restate workflow invocation
 *
 * This router is UNAUTHENTICATED (providers don't hold JWTs) and MUST be
 * mounted outside the auth middleware. Security is enforced per-request via
 * the signature verification inside `handleWebhook`.
 *
 * Mount point: `/api/v1/webhooks/connector`
 *   POST /:connectorName/:registrationId
 *   GET  /:connectorName/:registrationId    (handshake / URL verification)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { handleWebhook, type WebhookHandlerDeps } from '@agent-platform/connectors';
import { rejectBlockedWebhookSource } from './webhook-source-guard.js';

const log = createLogger('workflow-engine:webhooks');

export interface WebhookRouteDeps {
  webhookDeps: WebhookHandlerDeps;
}

export function createWebhookRouter(deps: WebhookRouteDeps): Router {
  const router = Router({ mergeParams: true });

  // GET — used by some providers (Slack URL verification, Stripe ping) to
  // validate the endpoint. We delegate to the same handler so a connector can
  // implement verify() for GET handshakes if needed, but most providers POST.
  router.get('/:connectorName/:registrationId', async (req: Request, res: Response) => {
    res.status(200).json({ ok: true });
    log.debug('Webhook GET handshake', {
      connectorName: req.params.connectorName,
      registrationId: req.params.registrationId,
    });
  });

  router.post('/:connectorName/:registrationId', async (req: Request, res: Response) => {
    if (rejectBlockedWebhookSource(req, res)) {
      return;
    }

    const { connectorName, registrationId } = req.params;
    try {
      const result = await handleWebhook(
        {
          params: { connectorName, registrationId },
          headers: req.headers,
          body: req.body,
          rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
        },
        deps.webhookDeps,
      );
      return res.status(result.status).json(result.body);
    } catch (err) {
      log.error('Webhook processing failed', {
        connectorName,
        registrationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Webhook processing failed' },
      });
    }
  });

  return router;
}
