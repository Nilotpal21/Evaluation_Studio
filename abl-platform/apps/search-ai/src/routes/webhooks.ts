/**
 * Webhook Routes
 *
 * Handles Microsoft Graph webhook notifications for SharePoint connector real-time updates.
 *
 * Endpoints:
 * - POST /api/webhooks/connectors/:connectorId/sharepoint - Receive change notifications
 * - GET /api/webhooks/connectors/:connectorId/sharepoint - Validation endpoint (Graph requirement)
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { ConnectorConfig, WebhookSubscriptionConnector } from '@agent-platform/database';
import { decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { createLogger } from '@abl/compiler/platform';
import { createQueue } from '../workers/index.js';
import type { WebhookNotificationBatchJobData } from '../workers/index.js';

const router: RouterType = Router();
const logger = createLogger('webhooks-routes');

// ─── Types ──────────────────────────────────────────────────────────────

interface GraphNotification {
  subscriptionId: string;
  subscriptionExpirationDateTime: string;
  clientState: string;
  changeType: string;
  resource: string;
  resourceData?: {
    '@odata.type': string;
    '@odata.id': string;
    id: string;
  };
}

interface WebhookPayload {
  value: GraphNotification[];
  validationToken?: string;
}

// ─── Validation Endpoint (GET) ──────────────────────────────────────────

/**
 * Microsoft Graph validation endpoint.
 * During subscription creation, Graph sends a GET request with a validationToken
 * that must be echoed back in the response.
 */
router.get('/connectors/:connectorId/sharepoint', (req: Request, res: Response) => {
  const validationToken = req.query.validationToken as string;

  if (!validationToken) {
    return res.status(400).json({ error: 'Missing validationToken' });
  }

  // Echo the validation token back (plain text response required)
  res.status(200).type('text/plain').send(validationToken);
});

// ─── Notification Receiver (POST) ───────────────────────────────────────

/**
 * Webhook notification receiver.
 * Microsoft Graph sends POST requests when subscribed resources change.
 * Must respond within 30 seconds or Graph will retry.
 */
router.post('/connectors/:connectorId/sharepoint', async (req: Request, res: Response) => {
  const { connectorId } = req.params;
  const payload: WebhookPayload = req.body;

  try {
    // Validate connector exists
    const connector = await ConnectorConfig.findOne({ _id: connectorId });
    if (!connector) {
      return res.status(404).json({ error: 'Connector not found' });
    }

    // Validate notifications
    if (!payload.value || !Array.isArray(payload.value)) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Validate and collect notifications
    const validNotifications: Array<{
      subscriptionId: string;
      changeType: string;
      resource: string;
      driveId?: string;
    }> = [];

    for (const notification of payload.value) {
      // Validate clientState against stored subscription
      const subscription = await WebhookSubscriptionConnector.findOne({
        tenantId: connector.tenantId,
        connectorId,
        subscriptionId: notification.subscriptionId,
      });

      if (!subscription) {
        logger.warn('Received notification for unknown subscription', {
          connectorId,
          subscriptionId: notification.subscriptionId,
        });
        continue;
      }

      // Validate clientState (decrypt and compare)
      // This proves the notification is legitimate and from Microsoft Graph.
      try {
        const decryptedClientState = await decryptForTenantAuto(
          subscription.encryptedClientState,
          connector.tenantId,
        );

        if (notification.clientState !== decryptedClientState) {
          logger.warn('Invalid clientState for webhook notification', {
            connectorId,
            subscriptionId: notification.subscriptionId,
          });
          continue;
        }
      } catch (error) {
        logger.error('Failed to decrypt clientState for webhook notification', {
          connectorId,
          subscriptionId: notification.subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Extract driveId from resource (format: drives/{driveId}/root)
      const driveIdMatch = notification.resource.match(/drives\/([^/]+)/);
      const driveId = driveIdMatch?.[1];

      validNotifications.push({
        subscriptionId: notification.subscriptionId,
        changeType: notification.changeType,
        resource: notification.resource,
        driveId,
      });
    }

    // Queue batch if we have valid notifications
    if (validNotifications.length > 0) {
      const notificationQueue = createQueue('webhook-notification');
      const jobData: WebhookNotificationBatchJobData = {
        connectorId,
        tenantId: connector.tenantId,
        notifications: validNotifications,
      };

      await notificationQueue.add('process-batch', jobData);

      logger.info('Queued webhook notification batch for processing', {
        connectorId,
        batchSize: validNotifications.length,
        totalReceived: payload.value.length,
      });
    } else {
      // Invalid or non-actionable webhook receipts stay operational-only by design.
      logger.warn('No valid notifications in batch', {
        connectorId,
        totalReceived: payload.value.length,
      });
    }

    // Return 202 immediately (Graph requirement: must respond within 30s)
    res.status(202).json({
      success: true,
      received: payload.value.length,
      validated: validNotifications.length,
    });
  } catch (error) {
    logger.error('Error processing webhook', {
      connectorId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Still return 202 to prevent Graph from retrying immediately
    // Error will be logged and handled async
    res.status(202).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
