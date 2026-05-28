/**
 * NotificationDispatcher
 *
 * Loads matching notification rules for an event, resolves templates
 * using the workflow context, and dispatches to channel adapters.
 *
 * Notifications are best-effort: adapter failures are logged but never
 * block or fail the workflow execution.
 */

import { createLogger } from '@abl/compiler/platform';
import { resolveExpression } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';

const log = createLogger('workflow-engine:notification-dispatcher');

/** Events that can trigger notifications */
export type NotificationEvent =
  | 'workflow.started'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.cancelled'
  | 'step.completed'
  | 'step.failed'
  | 'step.waiting_approval'
  | 'step.waiting_callback'
  | 'step.waiting_human_task'
  | 'approval.requested'
  | 'approval.resolved';

/**
 * A notification rule as persisted on the Workflow document. This shape
 * matches the CRUD route contract (`routes/notification-rules.ts`) and the
 * Mongoose subdocument — the dispatcher must consume rules as stored.
 */
export interface WorkflowNotificationRule {
  /** Subdocument identifier (present on stored rules) */
  _id?: string;
  /** Human-readable rule name */
  name?: string;
  /** Events that trigger this notification */
  events: string[];
  /** Whether this rule is active. `undefined` is treated as enabled. */
  enabled?: boolean;
  /** Structured channel configuration */
  channel: {
    type: 'slack' | 'msteams' | 'email' | 'webhook' | 'websocket';
    connectionId?: string;
    target: string;
  };
  /** Template string for the notification title. Supports {{expression}} placeholders. */
  template?: string;
  /** Template string for the notification body. Supports {{expression}} placeholders. */
  body?: string;
  /** Additional metadata to include in the notification */
  metadata?: Record<string, unknown>;
}

/** Resolved notification ready to send */
export interface ResolvedNotification {
  /** Channel type used to pick the adapter (e.g. 'slack', 'email') */
  channel: string;
  /** Destination within the channel (Slack channel id, email address, URL, etc.) */
  target: string;
  /** Optional connection that carries OAuth credentials for this channel */
  connectionId?: string;
  event: NotificationEvent;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

/** Channel adapter interface -- implementations send to Slack, email, etc. */
export interface NotificationChannelAdapter {
  send(notification: ResolvedNotification): Promise<void>;
}

/**
 * NotificationDispatcher
 *
 * Loads matching notification rules for an event, resolves templates
 * using the workflow context, and dispatches to channel adapters.
 */
export class NotificationDispatcher {
  private adapters: Map<string, NotificationChannelAdapter>;

  constructor(adapters?: Map<string, NotificationChannelAdapter>) {
    this.adapters = adapters ?? new Map();
  }

  /** Register a channel adapter */
  registerAdapter(channel: string, adapter: NotificationChannelAdapter): void {
    this.adapters.set(channel, adapter);
  }

  /**
   * Dispatch notifications for an event.
   *
   * @param event - The notification event type
   * @param rules - Notification rules from the workflow definition
   * @param ctx - Workflow context data for template resolution
   * @returns Array of resolved notifications that were dispatched
   */
  async dispatch(
    event: NotificationEvent,
    rules: WorkflowNotificationRule[],
    ctx: WorkflowContextData,
  ): Promise<ResolvedNotification[]> {
    // Filter rules: skip disabled rules, then match by event membership.
    // `enabled === undefined` is treated as enabled to preserve backward
    // compatibility with rules persisted before the flag was introduced.
    const matchingRules = rules.filter(
      (rule) => rule.enabled !== false && Array.isArray(rule.events) && rule.events.includes(event),
    );
    if (matchingRules.length === 0) return [];

    const resolved: ResolvedNotification[] = [];

    for (const rule of matchingRules) {
      // Resolve template expressions like {{trigger.payload.orderId}}
      const title =
        typeof rule.template === 'string'
          ? this.resolveTemplate(rule.template, ctx)
          : `Workflow notification: ${event}`;

      const body = typeof rule.body === 'string' ? this.resolveTemplate(rule.body, ctx) : '';

      const notification: ResolvedNotification = {
        channel: rule.channel.type,
        target: rule.channel.target,
        connectionId: rule.channel.connectionId,
        event,
        title,
        body,
        metadata: {
          workflowId: ctx.workflow.id,
          executionId: ctx.workflow.executionId,
          tenantId: ctx.tenant.tenantId,
          projectId: ctx.tenant.projectId,
          ruleId: rule._id,
          ruleName: rule.name,
          ...(rule.metadata ?? {}),
        },
      };

      resolved.push(notification);

      // Dispatch to adapter if available
      const adapter = this.adapters.get(rule.channel.type);
      if (adapter) {
        try {
          await adapter.send(notification);
        } catch (error) {
          // Log but do not fail the workflow -- notifications are best-effort
          log.error('Failed to send notification', {
            event,
            channel: rule.channel.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return resolved;
  }

  /** Resolve {{expression}} placeholders in a template string */
  private resolveTemplate(template: string, ctx: WorkflowContextData): string {
    // resolveExpression from the expression-resolver already handles
    // {{path}} replacement, but it replaces missing values with "undefined".
    // We wrap it to return empty string for undefined values instead.
    return template.replace(/\{\{(.+?)\}\}/g, (_match, expr: string) => {
      try {
        const singleTemplate = `{{${expr}}}`;
        const result = resolveExpression(singleTemplate, ctx);
        // resolveExpression returns "undefined" (the string) when path is missing
        return result === 'undefined' ? '' : result;
      } catch {
        return '';
      }
    });
  }
}
