/**
 * Alert Notifier
 *
 * Delivers alert notifications to configured channels (webhook).
 * Non-blocking — failures are counted but never throw.
 */

import type {
  IAlertNotifier,
  AlertRule,
  AlertEvaluation,
  NotificationChannel,
} from './interfaces.js';

// =============================================================================
// TYPES
// =============================================================================

/** Function that delivers a webhook. Injected by runtime for testability. */
export type WebhookDeliveryFn = (params: {
  url: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  secret?: string;
}) => Promise<{ statusCode: number; success: boolean }>;

export interface AlertNotifierConfig {
  /** Function to deliver webhook requests */
  deliveryFn: WebhookDeliveryFn;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class AlertNotifier implements IAlertNotifier {
  private readonly deliveryFn: WebhookDeliveryFn;

  constructor(config: AlertNotifierConfig) {
    this.deliveryFn = config.deliveryFn;
  }

  async notify(
    rule: AlertRule,
    evaluation: AlertEvaluation,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    const payload = buildNotificationPayload(rule, evaluation);

    const results = await Promise.allSettled(
      rule.channels.map((channel) => this.deliverToChannel(channel, payload)),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        sent++;
      } else {
        failed++;
      }
    }

    return { sent, failed };
  }

  private async deliverToChannel(
    channel: NotificationChannel,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await this.deliveryFn({
        url: channel.url,
        payload,
        headers: channel.headers,
        secret: channel.secret,
      });
      return result.success;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// PAYLOAD CONSTRUCTION
// =============================================================================

function buildNotificationPayload(
  rule: AlertRule,
  evaluation: AlertEvaluation,
): Record<string, unknown> {
  return {
    alert_id: `alert-${rule.id}-${Date.now()}`,
    rule_id: rule.id,
    rule_name: rule.name,
    tenant_id: rule.tenantId,
    project_id: rule.projectId,
    severity: rule.severity,
    state: evaluation.state,
    previous_state: evaluation.previousState,
    metric: rule.metric,
    operator: rule.operator,
    threshold: rule.threshold,
    current_value: evaluation.metricValue,
    breached: evaluation.breached,
    agent_name: rule.agentName,
    description: rule.description,
    evaluated_at: evaluation.evaluatedAt.toISOString(),
    window: {
      value: rule.window.value,
      unit: rule.window.unit,
    },
  };
}
