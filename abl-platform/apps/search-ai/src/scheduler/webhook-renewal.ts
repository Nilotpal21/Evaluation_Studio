/**
 * Webhook Subscription Renewal Scheduler
 *
 * Background job that runs every 12 hours to renew expiring webhook subscriptions.
 * Microsoft Graph subscriptions expire after 24 hours and must be renewed.
 *
 * Schedule: Runs every 12 hours
 * Processing: Finds subscriptions expiring within 24 hours and renews them
 */

import { WebhookSubscriptionConnector, ConnectorConfig } from '@agent-platform/database';
import { encryptForTenantAuto, decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { SharePointWebhookManager } from '@agent-platform/connector-sharepoint/webhooks/webhook-manager';
import { GraphClient } from '@agent-platform/connector-sharepoint/client/graph-client';

/**
 * Renew expiring webhook subscriptions for all active connectors.
 * Called by scheduled job every 12 hours.
 */
export async function renewExpiringWebhookSubscriptions(): Promise<{
  processed: number;
  renewed: number;
  failed: number;
}> {
  console.log('[webhook-renewal] Starting subscription renewal job');

  const expiryThreshold = new Date();
  expiryThreshold.setHours(expiryThreshold.getHours() + 24); // Renew if expiring within 24 hours

  // Find all subscriptions expiring soon
  const expiringSubscriptions = await WebhookSubscriptionConnector.find({
    status: 'active',
    expiresAt: { $lte: expiryThreshold },
  });

  console.log(`[webhook-renewal] Found ${expiringSubscriptions.length} expiring subscriptions`);

  let renewedCount = 0;
  let failedCount = 0;

  // Group by connector
  const subscriptionsByConnector = new Map<string, typeof expiringSubscriptions>();
  for (const subscription of expiringSubscriptions) {
    const existing = subscriptionsByConnector.get(subscription.connectorId) || [];
    existing.push(subscription);
    subscriptionsByConnector.set(subscription.connectorId, existing);
  }

  // Process each connector
  for (const [connectorId, subscriptions] of subscriptionsByConnector.entries()) {
    try {
      // Load connector config
      const connector = await ConnectorConfig.findOne({ _id: connectorId });
      if (!connector) {
        console.warn(`[webhook-renewal] Connector ${connectorId} not found, skipping`);
        failedCount += subscriptions.length;
        continue;
      }

      if (connector.errorState.isPaused) {
        console.log(`[webhook-renewal] Connector ${connectorId} is paused, skipping`);
        continue;
      }

      // Initialize webhook manager
      // TODO: Load OAuth token from EndUserOAuthToken model
      const graphClient = new GraphClient({
        accessToken: 'mock-token',
        baseUrl: connector.connectionConfig.tenantUrl || undefined,
      });

      const webhookManager = new SharePointWebhookManager(
        graphClient,
        {
          encryptForTenant: (plaintext, tenantId) =>
            encryptForTenantAuto(plaintext, tenantId, '_tenant', '_tenant'),
          decryptForTenant: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
        },
        {
          connectorId: connector._id,
          tenantId: connector.tenantId,
          notificationBaseUrl: process.env.WEBHOOK_BASE_URL || 'http://localhost:4001',
        },
      );

      // Renew subscriptions for this connector
      const renewed = await webhookManager.renewSubscriptions(24);
      renewedCount += renewed;

      console.log(
        `[webhook-renewal] Renewed ${renewed}/${subscriptions.length} subscriptions for connector ${connectorId}`,
      );
    } catch (error: any) {
      console.error(
        `[webhook-renewal] Failed to renew subscriptions for connector ${connectorId}:`,
        error.message,
      );
      failedCount += subscriptions.length;
    }
  }

  const result = {
    processed: expiringSubscriptions.length,
    renewed: renewedCount,
    failed: failedCount,
  };

  console.log('[webhook-renewal] Renewal job completed:', result);
  return result;
}

/**
 * Cleanup expired and failed subscriptions.
 * Removes subscriptions that have been expired for more than 7 days.
 *
 * Called by scheduled job daily.
 */
export async function cleanupExpiredWebhookSubscriptions(): Promise<{
  deleted: number;
}> {
  console.log('[webhook-cleanup] Starting subscription cleanup job');

  const expiryThreshold = new Date();
  expiryThreshold.setDate(expiryThreshold.getDate() - 7); // 7 days old

  // Find expired subscriptions
  const expiredSubscriptions = await WebhookSubscriptionConnector.find({
    $or: [
      { status: 'expired', updatedAt: { $lte: expiryThreshold } },
      { status: 'failed', renewalFailures: { $gte: 3 }, updatedAt: { $lte: expiryThreshold } },
    ],
  });

  console.log(
    `[webhook-cleanup] Found ${expiredSubscriptions.length} expired subscriptions to delete`,
  );

  let deletedCount = 0;

  for (const subscription of expiredSubscriptions) {
    try {
      // Load connector config
      const connector = await ConnectorConfig.findOne({ _id: subscription.connectorId });
      if (!connector) {
        // Connector deleted, just remove subscription record
        await WebhookSubscriptionConnector.deleteOne({ _id: subscription._id });
        deletedCount++;
        continue;
      }

      // Try to delete subscription from Microsoft Graph
      try {
        // TODO: Load OAuth token from EndUserOAuthToken model
        const graphClient = new GraphClient({
          accessToken: 'mock-token',
          baseUrl: connector.connectionConfig.tenantUrl || undefined,
        });

        await graphClient.deleteSubscription(subscription.subscriptionId);
      } catch (graphError: any) {
        // Subscription might already be deleted by Microsoft, that's OK
        console.warn(
          `[webhook-cleanup] Failed to delete Graph subscription ${subscription.subscriptionId}:`,
          graphError.message,
        );
      }

      // Delete from database
      await WebhookSubscriptionConnector.deleteOne({ _id: subscription._id });
      deletedCount++;
    } catch (error: any) {
      console.error(
        `[webhook-cleanup] Failed to cleanup subscription ${subscription._id}:`,
        error.message,
      );
    }
  }

  const result = { deleted: deletedCount };
  console.log('[webhook-cleanup] Cleanup job completed:', result);
  return result;
}
