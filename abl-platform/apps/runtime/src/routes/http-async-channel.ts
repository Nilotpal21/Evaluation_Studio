/**
 * HTTP Async Channel Routes
 *
 * Webhook subscription management and async message ingestion.
 * Mounted at /api/v1/channels/http-async
 *
 * POST   /subscribe          Register a callback URL
 * GET    /subscriptions      List subscriptions
 * GET    /subscriptions/:id  Get subscription details
 * PATCH  /subscriptions/:id  Update subscription
 * DELETE /subscriptions/:id  Deactivate subscription
 * POST   /message            Send a message to an agent (returns 202)
 * GET    /deliveries/:id     Check delivery status
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { requirePermission } from '@agent-platform/shared-auth';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { generateWebhookSecret } from '@agent-platform/shared-kernel/security';
import {
  assertAllowedCallbackUrl,
  CallbackUrlError,
} from '../channels/security/callback-url-policy.js';
import { findOrCreateHttpAsyncConnection } from '../channels/connection-resolver.js';
import { getInboundQueue } from '../services/queues/channel-queues.js';
import { createLogger } from '@abl/compiler/platform';
import { getCurrentTraceId, getObservabilityContext } from '@abl/compiler/platform/observability';
import { injectTrace } from '@agent-platform/shared-observability/tracing';
import {
  auditSubscriptionCreated,
  auditSubscriptionUpdated,
  auditSubscriptionDeleted,
} from '../services/audit-helpers.js';
import type { InboundJobPayload } from '../channels/types.js';

const log = createLogger('http-async-routes');

const router: RouterType = Router();
const VALID_HTTP_ASYNC_EVENTS = ['agent.response', 'agent.status'] as const;
const DEFAULT_HTTP_ASYNC_EVENTS = [...VALID_HTTP_ASYNC_EVENTS];

// Auth + rate limiting
router.use(authMiddleware);
router.use(tenantRateLimit('request'));

// =============================================================================
// SUBSCRIBE — Register a callback URL
// =============================================================================

router.post(
  '/subscribe',
  requirePermission('credential:write'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { callback_url, project_id, agent_id, deployment_id, events, description } = req.body;

      // Validate required fields
      if (!callback_url || typeof callback_url !== 'string') {
        res.status(400).json({ error: 'callback_url is required' });
        return;
      }
      if (!project_id || typeof project_id !== 'string') {
        res.status(400).json({ error: 'project_id is required' });
        return;
      }

      // Validate callback URL (SSRF protection)
      const isProduction = process.env.NODE_ENV === 'production';
      try {
        await assertAllowedCallbackUrl(callback_url, isProduction);
      } catch (err) {
        if (err instanceof CallbackUrlError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }

      // Validate events if provided
      const subscriptionEvents = events || DEFAULT_HTTP_ASYNC_EVENTS;
      if (
        !Array.isArray(subscriptionEvents) ||
        !subscriptionEvents.every((e: string) =>
          VALID_HTTP_ASYNC_EVENTS.includes(e as (typeof VALID_HTTP_ASYNC_EVENTS)[number]),
        )
      ) {
        res.status(400).json({
          error: `Invalid events. Must be array of: ${VALID_HTTP_ASYNC_EVENTS.join(', ')}`,
        });
        return;
      }

      // Verify project belongs to tenant
      const { Project } = await import('@agent-platform/database/models');
      const project = await Project.findOne({ _id: project_id, tenantId }).lean();
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Validate deployment_id if provided
      if (deployment_id) {
        const { Deployment } = await import('@agent-platform/database/models');
        const deployment = await Deployment.findOne({
          _id: deployment_id,
          projectId: project_id,
          tenantId,
        }).lean();
        if (!deployment) {
          res.status(404).json({ error: 'Deployment not found' });
          return;
        }
      }

      // Find or create HTTP Async connection
      const connection = await findOrCreateHttpAsyncConnection(
        tenantId,
        project_id,
        agent_id,
        deployment_id,
      );

      // Generate webhook secret
      const secret = generateWebhookSecret();

      // Plugin encrypts encryptedSecret transparently in pre-save hook
      const { WebhookSubscription } = await import('@agent-platform/database/models');
      const subscription = await WebhookSubscription.create({
        tenantId,
        channelConnectionId: connection.id,
        callbackUrl: callback_url,
        encryptedSecret: secret,
        events: JSON.stringify(subscriptionEvents),
        description: description || null,
        status: 'active',
      });

      log.info('Webhook subscription created', {
        subscriptionId: subscription._id,
        tenantId,
        userId: req.tenantContext?.userId,
        projectId: project_id,
      });

      auditSubscriptionCreated(
        {
          subscriptionId: subscription._id as string,
          callbackUrl: callback_url,
          projectId: project_id,
          events: subscriptionEvents,
        },
        req.tenantContext?.userId || 'system',
        tenantId,
      );

      // Return the secret ONCE — it cannot be retrieved again
      res.status(201).json({
        subscription_id: subscription._id,
        callback_url: subscription.callbackUrl,
        events: subscriptionEvents,
        deployment_id: connection.deploymentId || null,
        secret,
        status: 'active',
        created_at: subscription.createdAt,
        _note: 'Store the secret securely. It cannot be retrieved again.',
      });
    } catch (err) {
      log.error('Failed to create subscription', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to create subscription' });
    }
  },
);

// =============================================================================
// LIST SUBSCRIPTIONS
// =============================================================================

router.get(
  '/subscriptions',
  requirePermission('credential:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { WebhookSubscription, ChannelConnection } =
        await import('@agent-platform/database/models');
      const projectId = req.query.project_id as string | undefined;

      // Build filter with optional project_id
      const filter: Record<string, unknown> = { tenantId };
      if (projectId) {
        const connections = await ChannelConnection.find(
          { tenantId, projectId, channelType: 'http_async' },
          { _id: 1 },
        ).lean();
        const connectionIds = connections.map((c: any) => c._id);
        filter.channelConnectionId = { $in: connectionIds };
      }

      const subscriptions = await WebhookSubscription.find(filter)
        .sort({ createdAt: -1 })
        .select(
          'channelConnectionId callbackUrl events status description failureCount lastDeliveryAt createdAt updatedAt',
        )
        .lean();

      // Batch-load connections to include agentId and projectId
      const connectionIds = [...new Set(subscriptions.map((s: any) => s.channelConnectionId))];
      const connections =
        connectionIds.length > 0
          ? await ChannelConnection.find(
              { _id: { $in: connectionIds } },
              { agentId: 1, projectId: 1 },
            ).lean()
          : [];
      const connectionMap = new Map<
        string,
        { _id: string; agentId: string | null; projectId: string }
      >(connections.map((c: any) => [c._id, c]));

      res.json({
        subscriptions: subscriptions.map((s: any) => {
          const conn = connectionMap.get(s.channelConnectionId);
          return {
            id: s._id,
            channelConnectionId: s.channelConnectionId,
            callbackUrl: s.callbackUrl,
            events: JSON.parse(s.events),
            status: s.status,
            description: s.description,
            failureCount: s.failureCount,
            lastDeliveryAt: s.lastDeliveryAt,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            agentId: conn?.agentId || null,
            projectId: conn?.projectId || null,
          };
        }),
      });
    } catch (err) {
      log.error('Failed to list subscriptions', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to list subscriptions' });
    }
  },
);

// =============================================================================
// GET SUBSCRIPTION
// =============================================================================

router.get(
  '/subscriptions/:id',
  requirePermission('credential:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { WebhookSubscription } = await import('@agent-platform/database/models');
      const subscription = await WebhookSubscription.findOne(
        { _id: req.params.id, tenantId },
        'channelConnectionId callbackUrl events status description failureCount lastDeliveryAt createdAt updatedAt',
      ).lean();

      if (!subscription) {
        res.status(404).json({ error: 'Subscription not found' });
        return;
      }

      res.json({
        id: subscription._id,
        channelConnectionId: subscription.channelConnectionId,
        callbackUrl: subscription.callbackUrl,
        events: JSON.parse(subscription.events),
        status: subscription.status,
        description: subscription.description,
        failureCount: subscription.failureCount,
        lastDeliveryAt: subscription.lastDeliveryAt,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      });
    } catch (err) {
      log.error('Failed to get subscription', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get subscription' });
    }
  },
);

// =============================================================================
// UPDATE SUBSCRIPTION
// =============================================================================

router.patch(
  '/subscriptions/:id',
  requirePermission('credential:write'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { WebhookSubscription } = await import('@agent-platform/database/models');
      const subscription = await WebhookSubscription.findOne({
        _id: req.params.id,
        tenantId,
      }).lean();

      if (!subscription) {
        res.status(404).json({ error: 'Subscription not found' });
        return;
      }

      const updateFields: Record<string, unknown> = {};
      const { status, events, callback_url, regenerate_secret } = req.body;

      // Regenerate webhook secret — plugin encrypts in pre-save hook
      let newSecret: string | null = null;
      if (regenerate_secret === true) {
        newSecret = generateWebhookSecret();
        updateFields.encryptedSecret = newSecret;
      }

      if (status !== undefined) {
        if (!['active', 'paused', 'deactivated'].includes(status)) {
          res.status(400).json({ error: 'Invalid status. Must be: active, paused, deactivated' });
          return;
        }
        updateFields.status = status;
      }

      if (events !== undefined) {
        if (
          !Array.isArray(events) ||
          !events.every((e: string) =>
            VALID_HTTP_ASYNC_EVENTS.includes(e as (typeof VALID_HTTP_ASYNC_EVENTS)[number]),
          )
        ) {
          res.status(400).json({
            error: `Invalid events. Must be array of: ${VALID_HTTP_ASYNC_EVENTS.join(', ')}`,
          });
          return;
        }
        updateFields.events = JSON.stringify(events);
      }

      if (callback_url !== undefined) {
        const isProduction = process.env.NODE_ENV === 'production';
        try {
          await assertAllowedCallbackUrl(callback_url, isProduction);
        } catch (err) {
          if (err instanceof CallbackUrlError) {
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }
        updateFields.callbackUrl = callback_url;
      }

      // Use findOne + save() so the encryption plugin's pre-save hook fires
      const doc = await WebhookSubscription.findOne({
        _id: req.params.id,
        tenantId,
      });

      if (!doc) {
        res.status(404).json({ error: 'Subscription not found for update' });
        return;
      }

      for (const [key, value] of Object.entries(updateFields)) {
        doc.set(key, value);
      }
      await doc.save();

      log.info('Subscription updated', {
        subscriptionId: req.params.id,
        tenantId,
        userId: req.tenantContext?.userId,
        changes: Object.keys(updateFields),
      });

      auditSubscriptionUpdated(
        { subscriptionId: req.params.id, changes: updateFields },
        req.tenantContext?.userId || 'system',
        tenantId,
      );

      const response: Record<string, unknown> = {
        id: doc._id,
        callbackUrl: doc.callbackUrl,
        events: JSON.parse(doc.events),
        status: doc.status,
        description: doc.description,
        updatedAt: doc.updatedAt,
      };
      if (newSecret) {
        response.secret = newSecret;
        response._note = 'Store the new secret securely. It cannot be retrieved again.';
      }
      res.json(response);
    } catch (err) {
      log.error('Failed to update subscription', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to update subscription' });
    }
  },
);

// =============================================================================
// DELETE (DEACTIVATE) SUBSCRIPTION
// =============================================================================

router.delete(
  '/subscriptions/:id',
  requirePermission('credential:delete'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { WebhookSubscription } = await import('@agent-platform/database/models');
      const subscription = await WebhookSubscription.findOne({
        _id: req.params.id,
        tenantId,
      }).lean();

      if (!subscription) {
        res.status(404).json({ error: 'Subscription not found' });
        return;
      }

      await WebhookSubscription.updateOne(
        { _id: req.params.id },
        { $set: { status: 'deactivated' } },
      );

      log.info('Subscription deactivated', {
        subscriptionId: req.params.id,
        tenantId,
        userId: req.tenantContext?.userId,
      });

      auditSubscriptionDeleted(
        { subscriptionId: req.params.id },
        req.tenantContext?.userId || 'system',
        tenantId,
      );

      res.json({ success: true, message: 'Subscription deactivated' });
    } catch (err) {
      log.error('Failed to deactivate subscription', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to deactivate subscription' });
    }
  },
);

// =============================================================================
// SEND MESSAGE — Async ingestion (returns 202)
// =============================================================================

router.post('/message', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { subscription_id, message, session_key, idempotency_key, metadata } = req.body;

    // Validate required fields
    if (!subscription_id || typeof subscription_id !== 'string') {
      res.status(400).json({ error: 'subscription_id is required' });
      return;
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message is required and must be non-empty' });
      return;
    }

    const { WebhookSubscription, ChannelConnection } =
      await import('@agent-platform/database/models');

    // Verify subscription exists and is active
    const subscription = await WebhookSubscription.findOne({
      _id: subscription_id,
      tenantId,
      status: 'active',
    }).lean();
    if (!subscription) {
      res.status(404).json({ error: 'Active subscription not found' });
      return;
    }

    // Load connection to get project info
    const connection = await ChannelConnection.findOne({
      _id: subscription.channelConnectionId,
    }).lean();
    if (!connection) {
      res.status(404).json({ error: 'Channel connection not found' });
      return;
    }

    // Check queue availability
    const queue = getInboundQueue();
    if (!queue) {
      res.status(503).json({ error: 'Message queue not available. Ensure Redis is configured.' });
      return;
    }

    // Validate session_key format if provided.
    // We support two forms:
    // 1) canonical runtime key: http_async:<tenantId>:<subscriptionId>:<suffix>
    // 2) client token: <alphanumeric|_|-> (we namespace it below)
    let externalSessionKey: string;
    if (session_key !== undefined) {
      if (typeof session_key !== 'string' || session_key.length === 0 || session_key.length > 256) {
        res
          .status(400)
          .json({ error: 'session_key must be a string between 1 and 256 characters' });
        return;
      }

      if (session_key.startsWith('http_async:')) {
        const parts = session_key.split(':');
        if (parts.length < 4 || parts[1] !== tenantId || parts[2] !== subscription_id) {
          res.status(400).json({
            error: 'session_key does not belong to this tenant/subscription',
          });
          return;
        }
        externalSessionKey = session_key;
      } else {
        if (!/^[a-zA-Z0-9_-]+$/.test(session_key)) {
          res.status(400).json({
            error:
              'session_key token must contain only alphanumeric characters, hyphens, and underscores',
          });
          return;
        }
        externalSessionKey = `http_async:${tenantId}:${subscription_id}:${session_key}`;
      }
    } else {
      externalSessionKey = `http_async:${tenantId}:${subscription_id}:default`;
    }

    const messageId = uuidv4();
    const dedupKey = idempotency_key || messageId;

    const jobPayload: InboundJobPayload = {
      connectionId: connection._id,
      tenantId,
      projectId: connection.projectId,
      agentId: connection.agentId,
      deploymentId: connection.deploymentId ?? undefined,
      channelType: 'http_async',
      message: {
        externalMessageId: messageId,
        externalSessionKey,
        text: message.trim(),
        metadata: metadata || {},
        timestamp: new Date(),
      },
      subscriptionId: subscription_id,
      idempotencyKey: dedupKey,
      traceId: getCurrentTraceId(),
    };

    // Inject full span context for cross-boundary propagation
    const obsCtx = getObservabilityContext();
    if (obsCtx) {
      injectTrace(jobPayload as unknown as Record<string, unknown>, {
        traceId: obsCtx.traceId,
        spanId: obsCtx.spanId,
      });
    }

    await queue.add('inbound-message', jobPayload, {
      jobId: `inbound-${tenantId}-${subscription_id}-${dedupKey}`,
    });

    log.info('Message enqueued', {
      messageId,
      subscriptionId: subscription_id,
      tenantId,
      userId: req.tenantContext?.userId,
    });

    res.status(202).json({
      message_id: messageId,
      session_key: externalSessionKey,
      status: 'accepted',
      _note:
        'Message has been queued for processing. Response will be delivered to your callback URL.',
    });
  } catch (err) {
    // MongoDB duplicate key error (code 11000) replaces Prisma P2002
    if ((err as any)?.code === 11000) {
      res
        .status(409)
        .json({ error: 'Duplicate message. This idempotency key has already been used.' });
      return;
    }
    log.error('Failed to enqueue message', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// =============================================================================
// LIST DELIVERIES FOR SUBSCRIPTION
// =============================================================================

router.get(
  '/subscriptions/:id/deliveries',
  requirePermission('credential:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { WebhookSubscription, WebhookDelivery } =
        await import('@agent-platform/database/models');

      // Verify subscription belongs to tenant
      const subscription = await WebhookSubscription.findOne(
        { _id: req.params.id, tenantId },
        { _id: 1 },
      ).lean();

      if (!subscription) {
        res.status(404).json({ error: 'Subscription not found' });
        return;
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);

      const deliveries = await WebhookDelivery.find({ subscriptionId: req.params.id, tenantId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('eventType status httpStatus attempts lastAttemptAt deliveredAt createdAt')
        .lean();

      res.json({
        deliveries: deliveries.map((d: any) => ({
          id: d._id,
          eventType: d.eventType,
          status: d.status,
          httpStatus: d.httpStatus,
          attempts: d.attempts,
          lastAttemptAt: d.lastAttemptAt,
          deliveredAt: d.deliveredAt,
          createdAt: d.createdAt,
        })),
      });
    } catch (err) {
      log.error('Failed to list deliveries', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to list deliveries' });
    }
  },
);

// =============================================================================
// CHECK DELIVERY STATUS
// =============================================================================

router.get(
  '/deliveries/:id',
  requirePermission('credential:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext?.tenantId;
      if (!tenantId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { WebhookDelivery } = await import('@agent-platform/database/models');
      const delivery = await WebhookDelivery.findOne(
        { _id: req.params.id, tenantId },
        'subscriptionId eventType status httpStatus attempts lastAttemptAt deliveredAt createdAt',
      ).lean();

      if (!delivery) {
        res.status(404).json({ error: 'Delivery not found' });
        return;
      }

      res.json({
        id: delivery._id,
        subscriptionId: delivery.subscriptionId,
        eventType: delivery.eventType,
        status: delivery.status,
        httpStatus: delivery.httpStatus,
        attempts: delivery.attempts,
        lastAttemptAt: delivery.lastAttemptAt,
        deliveredAt: delivery.deliveredAt,
        createdAt: delivery.createdAt,
      });
    } catch (err) {
      log.error('Failed to get delivery', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Failed to get delivery status' });
    }
  },
);

export default router;
