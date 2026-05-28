/**
 * Webhook Delivery Retention Policy
 *
 * Provides automated cleanup of expired WebhookDelivery documents.
 * Deletes deliveries older than the configurable retention period,
 * scoped by tenantId for tenant isolation.
 *
 * The database model also supports a MongoDB TTL index via the
 * `WEBHOOK_DELIVERY_RETENTION_DAYS` env var, but this function
 * provides an explicit, auditable cleanup mechanism that can be
 * scheduled independently.
 */

import { createLogger } from '../logger.js';
import { WEBHOOK_DELIVERY_RETENTION_DAYS } from './constants.js';

const log = createLogger('webhook-delivery-retention');

/** Mongoose-like model interface for WebhookDelivery cleanup */
export interface WebhookDeliveryModel {
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>;
}

export interface CleanupResult {
  success: boolean;
  deletedCount: number;
  tenantId?: string;
  error?: { code: string; message: string };
}

/**
 * Delete WebhookDelivery documents older than the retention period.
 *
 * @param model - The WebhookDelivery Mongoose model (injected for testability)
 * @param tenantId - Optional tenant scope. If provided, only deletes that tenant's records.
 *                   If omitted, deletes across all tenants (for global scheduled cleanup).
 * @param retentionDays - Override the default retention period (default: WEBHOOK_DELIVERY_RETENTION_DAYS)
 */
export async function cleanupExpiredWebhookDeliveries(
  model: WebhookDeliveryModel,
  tenantId?: string,
  retentionDays: number = WEBHOOK_DELIVERY_RETENTION_DAYS,
): Promise<CleanupResult> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const filter: Record<string, unknown> = {
    createdAt: { $lt: cutoffDate },
  };

  if (tenantId) {
    filter.tenantId = tenantId;
  }

  try {
    const result = await model.deleteMany(filter);
    const deletedCount = result.deletedCount ?? 0;

    log.info('Webhook delivery cleanup completed', {
      deletedCount,
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
      ...(tenantId ? { tenantId } : {}),
    });

    return { success: true, deletedCount, tenantId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Webhook delivery cleanup failed', {
      error: message,
      retentionDays,
      ...(tenantId ? { tenantId } : {}),
    });

    return {
      success: false,
      deletedCount: 0,
      tenantId,
      error: { code: 'CLEANUP_FAILED', message },
    };
  }
}
