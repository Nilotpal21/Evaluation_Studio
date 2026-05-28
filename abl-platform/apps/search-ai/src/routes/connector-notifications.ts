/**
 * Connector Notification Routes
 *
 * GET/PUT notification preferences, POST webhook test.
 * Mounted under /api/indexes via server.ts
 */

import { Router } from 'express';
import type { Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { createLogger } from '@abl/compiler/platform';
import * as notificationService from '../services/connector-notification.service.js';
import { ConnectorError } from '../services/connector.service.js';
import { queueAuditEntry } from '../services/connector-audit.service.js';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-notification-routes');
const router: RouterType = Router();

router.use(authMiddleware);
router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Zod Validation Schemas ──────────────────────────────────────────────

const notificationParams = z.strictObject({
  indexId: z.string().min(1),
  connectorId: z.string().min(1),
});

const VALID_EVENTS = [
  'sync_failure',
  'token_expiry',
  'permission_crawl_fail',
  'sync_complete',
] as const;

const notificationBody = z.strictObject({
  emailAlertsEnabled: z.boolean().optional(),
  emailEvents: z.array(z.enum(VALID_EVENTS)).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookEvents: z.array(z.enum(VALID_EVENTS)).optional(),
});

const testWebhookBody = z.strictObject({
  url: z.string().url(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function handleError(res: Response, error: unknown, fallbackCode: string): void {
  if (error instanceof ConnectorError) {
    res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message },
    });
    return;
  }
  const msg = error instanceof Error ? error.message : String(error);
  logger.error(`${fallbackCode}: ${msg}`);
  res.status(500).json({
    success: false,
    error: { code: fallbackCode, message: 'Internal server error' },
  });
}

function queueConnectorNotificationAudit(params: {
  connectorId: string;
  tenantId: string;
  userId?: string;
  event: string;
  metadata?: Record<string, unknown>;
}): void {
  queueAuditEntry({
    connectorId: params.connectorId,
    tenantId: params.tenantId,
    actor: params.userId ?? 'system',
    actorType: params.userId ? 'user' : 'system',
    event: params.event,
    category: 'config',
    metadata: params.metadata,
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────

// GET /:indexId/connectors/:connectorId/notifications
router.get(
  '/:indexId/connectors/:connectorId/notifications',
  async (req: Request, res: Response) => {
    try {
      const parsed = notificationParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: parsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await notificationService.getNotificationConfig(
        parsed.data.connectorId,
        tenantId,
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'GET_NOTIFICATIONS_FAILED');
    }
  },
);

// PUT /:indexId/connectors/:connectorId/notifications
router.put(
  '/:indexId/connectors/:connectorId/notifications',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = notificationParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: paramsParsed.error.message },
        });
        return;
      }

      const bodyParsed = notificationBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: bodyParsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await notificationService.updateNotificationConfig(
        paramsParsed.data.connectorId,
        tenantId,
        bodyParsed.data,
      );

      queueConnectorNotificationAudit({
        connectorId: paramsParsed.data.connectorId,
        tenantId,
        userId: req.tenantContext?.userId,
        event: 'notification.updated',
        metadata: {
          indexId: paramsParsed.data.indexId,
          emailAlertsEnabled: data.emailAlertsEnabled,
          emailEvents: data.emailEvents,
          webhookEvents: data.webhookEvents,
          webhookUrlConfigured: typeof data.webhookUrl === 'string' && data.webhookUrl.length > 0,
        },
      });

      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'UPDATE_NOTIFICATIONS_FAILED');
    }
  },
);

// POST /:indexId/connectors/:connectorId/notifications/test-webhook
router.post(
  '/:indexId/connectors/:connectorId/notifications/test-webhook',
  async (req: Request, res: Response) => {
    try {
      const paramsParsed = notificationParams.safeParse(req.params);
      if (!paramsParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_PARAMS', message: paramsParsed.error.message },
        });
        return;
      }

      const bodyParsed = testWebhookBody.safeParse(req.body);
      if (!bodyParsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: bodyParsed.error.message },
        });
        return;
      }

      const tenantId = req.tenantContext!.tenantId;
      const data = await notificationService.testWebhook(
        bodyParsed.data.url,
        paramsParsed.data.connectorId,
        tenantId,
      );

      queueConnectorNotificationAudit({
        connectorId: paramsParsed.data.connectorId,
        tenantId,
        userId: req.tenantContext?.userId,
        event: 'notification.webhook_tested',
        metadata: {
          indexId: paramsParsed.data.indexId,
          url: bodyParsed.data.url,
          success: data.success,
          statusCode: data.statusCode ?? null,
          error: data.error ?? null,
        },
      });

      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'TEST_WEBHOOK_FAILED');
    }
  },
);

export default router;
