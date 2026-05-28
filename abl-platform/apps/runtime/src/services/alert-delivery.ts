/**
 * Alert Delivery Service
 *
 * Evaluates tenant alert configurations against current metric values
 * and delivers notifications via configured channels (webhook, email).
 * Respects cooldown periods to prevent alert storms.
 *
 * Webhook deliveries include an HMAC-SHA256 signature header for verification.
 * All deliveries are logged in the audit trail.
 */

import { createHmac } from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { writeAuditLog } from '../repos/auth-repo.js';
import { assertAllowedCallbackUrl } from '../channels/security/callback-url-policy.js';

const log = createLogger('alert-delivery');

// ─── Types ───────────────────────────────────────────────────────────────

interface AlertEvaluation {
  tenantId: string;
  alertType: string;
  currentValue: number;
}

interface DeliveryResult {
  alertId: string;
  delivered: boolean;
  channel: string;
  reason?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

/** Default timeout for webhook delivery in milliseconds */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** Environment variable for HMAC signing secret. If unset, webhooks are sent unsigned. */
const WEBHOOK_SIGNING_SECRET = process.env.ALERT_WEBHOOK_SIGNING_SECRET ?? null;

if (!WEBHOOK_SIGNING_SECRET) {
  log.warn(
    'ALERT_WEBHOOK_SIGNING_SECRET not set — webhook deliveries will be sent without HMAC signatures.',
  );
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Evaluate alert conditions for a tenant and deliver notifications
 * for any triggered configs that are not in cooldown.
 *
 * Returns an array of delivery results for each evaluated config.
 */
export async function evaluateAndDeliver(params: AlertEvaluation): Promise<DeliveryResult[]> {
  const { AlertConfig } = await import('@agent-platform/database/models');

  const configs = await AlertConfig.find({
    tenantId: params.tenantId,
    type: params.alertType,
    enabled: true,
  })
    .lean()
    .exec();

  const results: DeliveryResult[] = [];

  for (const config of configs) {
    const doc = config as Record<string, unknown>;
    const threshold = doc.threshold as number;
    const cooldownMinutes = (doc.cooldownMinutes as number) || 60;
    const channel = doc.channel as string;
    const target = doc.target as string;
    const configId = String(doc._id);

    // Check threshold
    if (params.currentValue < threshold) {
      results.push({ alertId: configId, delivered: false, channel, reason: 'below_threshold' });
      continue;
    }

    // Check cooldown
    const lastTriggered = doc.lastTriggeredAt as Date | undefined;
    if (lastTriggered) {
      const cooldownMs = cooldownMinutes * 60 * 1000;
      if (Date.now() - new Date(lastTriggered).getTime() < cooldownMs) {
        results.push({ alertId: configId, delivered: false, channel, reason: 'in_cooldown' });
        continue;
      }
    }

    // Deliver
    try {
      if (channel === 'webhook') {
        await deliverWebhook(target, {
          type: params.alertType,
          tenantId: params.tenantId,
          value: params.currentValue,
          threshold,
          timestamp: new Date().toISOString(),
        });
      } else if (channel === 'email') {
        await deliverEmail(target, {
          type: params.alertType,
          tenantId: params.tenantId,
          value: params.currentValue,
          threshold,
        });
      }

      // Update lastTriggeredAt
      await AlertConfig.findOneAndUpdate(
        { _id: configId, tenantId: params.tenantId },
        { lastTriggeredAt: new Date() },
      ).exec();

      // Audit trail
      writeAuditLog({
        action: 'alert.delivered',
        tenantId: params.tenantId,
        metadata: {
          alertConfigId: configId,
          alertType: params.alertType,
          channel,
          target,
          currentValue: params.currentValue,
          threshold,
        },
      });

      log.info('Alert delivered', {
        alertId: configId,
        type: params.alertType,
        channel,
      });

      results.push({ alertId: configId, delivered: true, channel });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Alert delivery failed', { alertId: configId, error: message });

      // Audit failed delivery
      writeAuditLog({
        action: 'alert.delivery_failed',
        tenantId: params.tenantId,
        metadata: {
          alertConfigId: configId,
          alertType: params.alertType,
          channel,
          error: message,
        },
      });

      results.push({
        alertId: configId,
        delivered: false,
        channel,
        reason: `delivery_error: ${message}`,
      });
    }
  }

  return results;
}

// ─── Internal Helpers ────────────────────────────────────────────────────

/**
 * Deliver an alert via webhook with HMAC-SHA256 signature.
 *
 * The signature is computed over the JSON body and sent in the
 * `X-Alert-Signature` header for the receiver to verify authenticity.
 */
async function deliverWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  // Defense-in-depth: validate URL at delivery time (in case old URLs are already stored)
  const isProduction = process.env.NODE_ENV === 'production';
  await assertAllowedCallbackUrl(url, isProduction);

  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Compute HMAC-SHA256 signature if signing secret is configured
  if (WEBHOOK_SIGNING_SECRET) {
    const signature = createHmac('sha256', WEBHOOK_SIGNING_SECRET).update(body).digest('hex');
    headers['X-Alert-Signature'] = `sha256=${signature}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
  }
}

/**
 * Deliver an alert via email (placeholder SMTP implementation).
 *
 * In production this would connect to an SMTP service or
 * transactional email provider (SendGrid, SES, etc.).
 */
async function deliverEmail(
  target: string,
  payload: { type: string; tenantId: string; value: number; threshold: number },
): Promise<void> {
  // Placeholder: log the email that would be sent
  log.info('Email alert delivery (placeholder)', {
    to: target,
    subject: `Alert: ${payload.type} threshold exceeded`,
    body: `Your ${payload.type} metric has reached ${payload.value}% (threshold: ${payload.threshold}%).`,
    tenantId: payload.tenantId,
  });

  // TODO: Integrate with SMTP service or transactional email provider
  // Example: await smtpTransport.sendMail({ to: target, subject, html });
}
