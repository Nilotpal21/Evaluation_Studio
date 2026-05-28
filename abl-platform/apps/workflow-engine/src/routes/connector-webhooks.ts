/**
 * Connector Webhook Routes
 *
 * POST /api/v1/webhooks/:connectorName/:registrationId
 *
 * Inbound webhook receiver for connector-backed triggers that use the webhook
 * delivery strategy (e.g. Slack events, GitHub webhooks, Jira webhooks).
 *
 * Unauthenticated by design — same model as Stripe/GitHub: the URL carries a
 * non-guessable registrationId, and the HMAC signature (connector-specific or
 * generic SHA-256) is the security gate. Tenant is resolved from the loaded
 * TriggerRegistration document, not the caller.
 *
 * Mounted BEFORE the authenticated /api/v1 router so no auth middleware runs.
 * Relies on the app-level `captureRawBody` verify hook on express.json() to
 * preserve req.rawBody for signature verification.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '@abl/compiler/platform';
import {
  handleWebhook,
  type WebhookRequest,
  type WebhookHandlerDeps,
} from '@agent-platform/connectors';
import { rejectBlockedWebhookSource } from './webhook-source-guard.js';

const log = createLogger('workflow-engine:connector-webhooks');

export type ConnectorWebhookRouteDeps = WebhookHandlerDeps;

export function createConnectorWebhookRouter(deps: ConnectorWebhookRouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.post('/:connectorName/:registrationId', async (req: Request, res: Response) => {
    if (rejectBlockedWebhookSource(req, res)) {
      return;
    }

    const { connectorName, registrationId } = req.params;

    const webhookReq: WebhookRequest = {
      params: { connectorName, registrationId },
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
      rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
    };

    try {
      const result = await handleWebhook(webhookReq, deps);
      return res.status(result.status).json(result.body);
    } catch (err) {
      // handleWebhook catches its own errors and returns a structured result;
      // reaching here means something escaped — log and return 500 rather than
      // leaking a stack trace to the external sender.
      log.error('Connector webhook handler threw unexpectedly', {
        connectorName,
        registrationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Internal error' },
      });
    }
  });

  return router;
}
