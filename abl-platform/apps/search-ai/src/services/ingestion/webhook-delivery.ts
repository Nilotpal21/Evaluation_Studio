/**
 * Webhook Delivery Service
 *
 * Delivers webhook notifications when documents reach terminal states (indexed/error).
 * Called from the embedding worker after a document completes processing.
 *
 * Security:
 *   - HMAC-SHA256 signature in X-Webhook-Signature header (if secret configured)
 *   - Delivery timeout: 10s
 *   - Single attempt (no retry — caller can re-poll via status endpoint)
 */

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('webhook-delivery');

interface WebhookConfig {
  url: string;
  secret: string | null;
  createdAt: string;
}

interface WebhookPayload {
  event: 'document.indexed' | 'document.error';
  documentId: string;
  indexId: string;
  tenantId: string;
  status: string;
  pageCount?: number;
  chunkCount?: number;
  error?: string;
  completedAt: string;
}

/**
 * Check if a webhook is configured for a document and deliver the notification.
 * Reads the webhook config from Redis (stored during upload) and sends the payload.
 *
 * @param documentId - The document ID to check for webhook config
 * @param payload - The event payload to deliver
 */
export async function deliverDocumentWebhook(
  documentId: string,
  payload: WebhookPayload,
): Promise<void> {
  try {
    const { getSharedRedisClient } = await import('../../workers/shared.js');
    const redis = getSharedRedisClient();
    if (!redis) return;

    const configStr = await redis.get(`webhook:doc:${documentId}`);
    if (!configStr) return; // No webhook configured

    let config: WebhookConfig;
    try {
      config = JSON.parse(configStr);
    } catch (parseErr) {
      logger.warn('Invalid webhook config in Redis', {
        documentId,
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      return;
    }

    const body = JSON.stringify(payload);

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ABL-Platform-Webhook/1.0',
      'X-Webhook-Event': payload.event,
      'X-Document-Id': documentId,
    };

    // Sign with HMAC-SHA256 if secret is configured
    if (config.secret) {
      const signature = crypto.createHmac('sha256', config.secret).update(body).digest('hex');
      headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    // Deliver with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      logger.info('Webhook delivered', {
        documentId,
        url: config.url,
        status: response.status,
        event: payload.event,
      });
    } finally {
      clearTimeout(timeout);
    }

    // Clean up webhook config from Redis after delivery
    await redis.del(`webhook:doc:${documentId}`);
  } catch (error) {
    logger.error('Webhook delivery failed', {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw — webhook failure should not affect the main pipeline
  }
}
