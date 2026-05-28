/**
 * Notification Rules CRUD Routes
 *
 * Notification rules are stored as subdocuments on the Workflow model.
 * Each rule defines: events to listen for, notification channel, and target.
 *
 * GET    /                   List notification rules for a workflow
 * POST   /                   Create a new notification rule
 * PUT    /:ruleId            Update a notification rule
 * DELETE /:ruleId            Delete a notification rule
 * POST   /:ruleId/test       Send a test notification
 */

import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler, requireTenantProject } from '../lib/route-helpers.js';
import type { MongooseModelLike } from '../persistence/execution-store.js';

export interface NotificationRule {
  _id: string;
  name: string;
  events: string[];
  channel: {
    type: 'slack' | 'msteams' | 'email' | 'webhook' | 'websocket';
    connectionId: string;
    target: string;
  };
  enabled: boolean;
}

/** Workflow document shape the notification-rule routes read. */
interface NotificationWorkflowDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  notificationRules?: NotificationRule[];
}

/** Mongoose-like Workflow model that stores notification rules as subdocuments */
export type NotificationWorkflowModel = Pick<
  MongooseModelLike<NotificationWorkflowDoc>,
  'findOne' | 'findOneAndUpdate'
>;

/** Sends test notifications */
export interface NotificationDispatcher {
  sendTest(rule: NotificationRule, tenantId: string): Promise<{ sent: boolean }>;
}

export interface NotificationRuleDeps {
  workflowModel: NotificationWorkflowModel;
  dispatcher: NotificationDispatcher;
}

const VALID_EVENTS = [
  'workflow.started',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
  'step.failed',
  'step.waiting_approval',
  'step.waiting_callback',
  'step.waiting_human_task',
];

const VALID_CHANNEL_TYPES = ['slack', 'msteams', 'email', 'webhook', 'websocket'];

/**
 * Channel types that dispatch via an external OAuth connector and therefore
 * must reference a persisted connection. `webhook` uses only the target URL,
 * `websocket` is in-app delivery, and `email` uses a shared SMTP profile —
 * none of those require a per-rule `connectionId`.
 */
const CONNECTION_REQUIRED_CHANNEL_TYPES = new Set(['slack', 'msteams']);

/**
 * Validate a channel payload. Returns `null` on success or an error message.
 */
function validateChannel(channel: unknown): string | null {
  if (!channel || typeof channel !== 'object') {
    return 'channel is required';
  }
  const c = channel as Record<string, unknown>;
  if (typeof c.type !== 'string' || !VALID_CHANNEL_TYPES.includes(c.type)) {
    return `channel.type must be one of: ${VALID_CHANNEL_TYPES.join(', ')}`;
  }
  if (typeof c.target !== 'string' || c.target.length === 0) {
    return 'channel.target is required';
  }
  if (CONNECTION_REQUIRED_CHANNEL_TYPES.has(c.type)) {
    if (typeof c.connectionId !== 'string' || c.connectionId.length === 0) {
      return `channel.connectionId is required for '${c.type}' channels`;
    }
  }
  return null;
}

export function createNotificationRuleRouter(deps: NotificationRuleDeps): Router {
  const router = Router({ mergeParams: true });

  /** GET / — List notification rules */
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['workflowId'] });
      if (!ctx) return;
      const { tenantId, projectId, workflowId } = ctx;

      const workflow = await deps.workflowModel.findOne({ _id: workflowId, tenantId, projectId });
      if (!workflow) {
        return res.status(404).json({ success: false, error: 'Workflow not found' });
      }

      const rules = (workflow.notificationRules ?? []).map((r) => ({ ...r, id: r._id }));
      return res.json({ success: true, data: rules });
    }),
  );

  /** POST / — Create a notification rule */
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['workflowId'] });
      if (!ctx) return;
      const { tenantId, projectId, workflowId } = ctx;
      const { name, events, channel, enabled } = req.body ?? {};

      // Validate
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ success: false, error: 'name is required' });
      }
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ success: false, error: 'events must be a non-empty array' });
      }
      const invalidEvents = events.filter((e: string) => !VALID_EVENTS.includes(e));
      if (invalidEvents.length > 0) {
        return res
          .status(400)
          .json({ success: false, error: `Invalid events: ${invalidEvents.join(', ')}` });
      }
      const channelError = validateChannel(channel);
      if (channelError) {
        return res.status(400).json({ success: false, error: channelError });
      }

      const ruleId = crypto.randomUUID();
      const rule: NotificationRule = {
        _id: ruleId,
        name,
        events,
        channel,
        enabled: enabled !== false,
      };

      const result = await deps.workflowModel.findOneAndUpdate(
        { _id: workflowId, tenantId, projectId },
        { $push: { notificationRules: rule } },
        { new: true },
      );

      if (!result) {
        return res.status(404).json({ success: false, error: 'Workflow not found' });
      }

      return res.status(201).json({ success: true, data: { ...rule, id: rule._id } });
    }),
  );

  /** PUT /:ruleId — Update a notification rule */
  router.put(
    '/:ruleId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['workflowId', 'ruleId'] });
      if (!ctx) return;
      const { tenantId, projectId, workflowId, ruleId } = ctx;
      const updates = req.body ?? {};

      if (updates.events) {
        const invalidEvents = updates.events.filter((e: string) => !VALID_EVENTS.includes(e));
        if (invalidEvents.length > 0) {
          return res
            .status(400)
            .json({ success: false, error: `Invalid events: ${invalidEvents.join(', ')}` });
        }
      }

      if (updates.channel !== undefined) {
        const channelError = validateChannel(updates.channel);
        if (channelError) {
          return res.status(400).json({ success: false, error: channelError });
        }
      }

      const setFields: Record<string, unknown> = {};
      if (updates.name !== undefined) setFields['notificationRules.$.name'] = updates.name;
      if (updates.events !== undefined) setFields['notificationRules.$.events'] = updates.events;
      if (updates.channel !== undefined) setFields['notificationRules.$.channel'] = updates.channel;
      if (updates.enabled !== undefined) setFields['notificationRules.$.enabled'] = updates.enabled;

      if (Object.keys(setFields).length === 0) {
        return res.status(400).json({ success: false, error: 'No update fields provided' });
      }

      const result = await deps.workflowModel.findOneAndUpdate(
        { _id: workflowId, tenantId, projectId, 'notificationRules._id': ruleId },
        { $set: setFields },
        { new: true },
      );

      if (!result) {
        return res.status(404).json({ success: false, error: 'Workflow or rule not found' });
      }

      return res.json({ success: true, data: result });
    }),
  );

  /** DELETE /:ruleId — Remove a notification rule */
  router.delete(
    '/:ruleId',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['workflowId', 'ruleId'] });
      if (!ctx) return;
      const { tenantId, projectId, workflowId, ruleId } = ctx;

      const result = await deps.workflowModel.findOneAndUpdate(
        { _id: workflowId, tenantId, projectId },
        { $pull: { notificationRules: { _id: ruleId } } },
        { new: true },
      );

      if (!result) {
        return res.status(404).json({ success: false, error: 'Workflow not found' });
      }

      return res.json({ success: true });
    }),
  );

  /** POST /:ruleId/test — Send a test notification */
  router.post(
    '/:ruleId/test',
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantProject(req, res, { requireParams: ['workflowId', 'ruleId'] });
      if (!ctx) return;
      const { tenantId, projectId, workflowId, ruleId } = ctx;

      const workflow = await deps.workflowModel.findOne({ _id: workflowId, tenantId, projectId });
      if (!workflow) {
        return res.status(404).json({ success: false, error: 'Workflow not found' });
      }

      const rule = workflow.notificationRules?.find((r) => r._id === ruleId);
      if (!rule) {
        return res.status(404).json({ success: false, error: 'Rule not found' });
      }

      try {
        const result = await deps.dispatcher.sendTest(rule, tenantId);
        return res.json({ success: true, sent: result.sent });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return res
          .status(502)
          .json({ success: false, error: `Notification delivery failed: ${message}` });
      }
    }),
  );

  return router;
}
