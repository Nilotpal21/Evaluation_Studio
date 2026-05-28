/**
 * SharePoint Webhook Manager
 *
 * Manages Microsoft Graph webhook subscriptions for real-time document change notifications.
 * Each drive requires a separate subscription. Subscriptions expire after 24 hours and must be renewed.
 *
 * Architecture:
 * - Subscribe to all drives during connector initialization
 * - Store subscription metadata in WebhookSubscriptionConnector model
 * - Background job renews subscriptions before expiry (within 24 hours)
 * - Notifications trigger delta sync for the affected drive
 */

import crypto from 'crypto';
import {
  WebhookSubscriptionConnector,
  type IWebhookSubscriptionConnector,
} from '@agent-platform/database';
import type { GraphClient } from '../client/graph-client.js';

// ─── Types ──────────────────────────────────────────────────────────────

interface GraphSubscriptionResponse {
  id: string;
  resource: string;
  changeType: string;
  clientState: string;
  notificationUrl: string;
  expirationDateTime: string;
  applicationId: string;
  creatorId: string;
}

interface SubscriptionConfig {
  connectorId: string;
  tenantId: string;
  notificationBaseUrl: string;
}

interface TenantEncryptor {
  encryptForTenant(plaintext: string, tenantId: string): Promise<string>;
  decryptForTenant(ciphertext: string, tenantId: string): Promise<string>;
}

// ─── Webhook Manager ────────────────────────────────────────────────────

export class SharePointWebhookManager {
  private graphClient: GraphClient;
  private encryptionService: TenantEncryptor;
  private config: SubscriptionConfig;

  constructor(
    graphClient: GraphClient,
    encryptionService: TenantEncryptor,
    config: SubscriptionConfig,
  ) {
    this.graphClient = graphClient;
    this.encryptionService = encryptionService;
    this.config = config;
  }

  /**
   * Subscribe to all drives for a connector.
   * Creates webhook subscriptions for real-time change notifications.
   *
   * @param driveIds - Array of SharePoint drive IDs to subscribe to
   * @returns Array of created subscription records
   */
  async subscribeToAllDrives(driveIds: string[]): Promise<IWebhookSubscriptionConnector[]> {
    const subscriptions: IWebhookSubscriptionConnector[] = [];

    for (const driveId of driveIds) {
      try {
        const subscription = await this.subscribeToDrive(driveId);
        subscriptions.push(subscription);
      } catch (error: any) {
        // Log error but continue with other drives
        console.error(`Failed to subscribe to drive ${driveId}:`, error.message);
      }
    }

    return subscriptions;
  }

  /**
   * Subscribe to a single drive for change notifications.
   *
   * @param driveId - SharePoint drive ID
   * @returns Created subscription record
   */
  private async subscribeToDrive(driveId: string): Promise<IWebhookSubscriptionConnector> {
    // Check if subscription already exists
    const existing = await WebhookSubscriptionConnector.findOne({
      tenantId: this.config.tenantId,
      connectorId: this.config.connectorId,
      driveId,
    });

    if (existing && existing.status === 'active') {
      // Subscription already active
      return existing;
    }

    // Generate unique client state secret for validation
    const clientState = crypto.randomBytes(32).toString('hex');
    const encryptedClientState = await this.encryptionService.encryptForTenant(
      clientState,
      this.config.tenantId,
    );

    // Construct notification URL
    const notificationUrl = `${this.config.notificationBaseUrl}/api/webhooks/connectors/${this.config.connectorId}/sharepoint`;

    // Create subscription via Microsoft Graph API
    const graphResponse: GraphSubscriptionResponse = await this.graphClient.subscribeToDriveChanges(
      driveId,
      notificationUrl,
      clientState,
    );

    // Store subscription in database
    const subscription = await WebhookSubscriptionConnector.create({
      tenantId: this.config.tenantId,
      connectorId: this.config.connectorId,
      driveId,
      subscriptionId: graphResponse.id,
      notificationUrl,
      encryptedClientState,
      expiresAt: new Date(graphResponse.expirationDateTime),
      status: 'active',
      lastRenewalAt: new Date(),
      renewalFailures: 0,
      lastRenewalError: null,
    });

    return subscription;
  }

  /**
   * Renew expiring subscriptions.
   * Called by background job to renew subscriptions before they expire.
   *
   * @param hoursBeforeExpiry - Renew subscriptions expiring within this many hours (default: 24)
   * @returns Number of successfully renewed subscriptions
   */
  async renewSubscriptions(hoursBeforeExpiry: number = 24): Promise<number> {
    const expiryThreshold = new Date();
    expiryThreshold.setHours(expiryThreshold.getHours() + hoursBeforeExpiry);

    // Find subscriptions expiring soon
    const subscriptions = await WebhookSubscriptionConnector.find({
      connectorId: this.config.connectorId,
      status: 'active',
      expiresAt: { $lte: expiryThreshold },
    });

    let renewedCount = 0;

    for (const subscription of subscriptions) {
      try {
        await this.renewSubscription(subscription);
        renewedCount++;
      } catch (error: any) {
        console.error(
          `Failed to renew subscription ${subscription.subscriptionId} for drive ${subscription.driveId}:`,
          error.message,
        );

        // Update failure count
        await WebhookSubscriptionConnector.updateOne(
          { _id: subscription._id },
          {
            $inc: { renewalFailures: 1 },
            $set: {
              lastRenewalError: error.message,
              status: subscription.renewalFailures >= 3 ? 'failed' : 'active',
            },
          },
        );
      }
    }

    return renewedCount;
  }

  /**
   * Renew a single subscription.
   *
   * @param subscription - Subscription to renew
   */
  private async renewSubscription(subscription: IWebhookSubscriptionConnector): Promise<void> {
    // Renew via Microsoft Graph API
    const graphResponse: GraphSubscriptionResponse = await this.graphClient.renewSubscription(
      subscription.subscriptionId,
    );

    // Update database record
    await WebhookSubscriptionConnector.updateOne(
      { _id: subscription._id },
      {
        $set: {
          expiresAt: new Date(graphResponse.expirationDateTime),
          lastRenewalAt: new Date(),
          renewalFailures: 0,
          lastRenewalError: null,
          status: 'active',
        },
      },
    );
  }

  /**
   * Unsubscribe from all drives for a connector.
   * Called when connector is deleted or disabled.
   *
   * @returns Number of successfully deleted subscriptions
   */
  async unsubscribeAll(): Promise<number> {
    const subscriptions = await WebhookSubscriptionConnector.find({
      connectorId: this.config.connectorId,
    });

    let deletedCount = 0;

    for (const subscription of subscriptions) {
      try {
        // Delete subscription via Microsoft Graph API
        await this.graphClient.deleteSubscription(subscription.subscriptionId);

        // Delete from database
        await WebhookSubscriptionConnector.deleteOne({ _id: subscription._id });

        deletedCount++;
      } catch (error: any) {
        // Log error but continue with other subscriptions
        console.error(
          `Failed to delete subscription ${subscription.subscriptionId} for drive ${subscription.driveId}:`,
          error.message,
        );
      }
    }

    return deletedCount;
  }

  /**
   * Validate webhook notification client state.
   * Verifies that the notification came from Microsoft Graph and is intended for this connector.
   *
   * @param encryptedClientState - Client state from notification
   * @param providedClientState - Client state provided in notification
   * @returns True if valid
   */
  async validateClientState(
    encryptedClientState: string,
    providedClientState: string,
  ): Promise<boolean> {
    try {
      const decryptedClientState = await this.encryptionService.decryptForTenant(
        encryptedClientState,
        this.config.tenantId,
      );
      return decryptedClientState === providedClientState;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all active subscriptions for the connector.
   *
   * @returns Array of active subscription records
   */
  async getActiveSubscriptions(): Promise<IWebhookSubscriptionConnector[]> {
    return WebhookSubscriptionConnector.find({
      connectorId: this.config.connectorId,
      status: 'active',
    });
  }

  /**
   * Get subscription status for a specific drive.
   *
   * @param driveId - Drive ID to check
   * @returns Subscription record or null if not found
   */
  async getSubscriptionForDrive(driveId: string): Promise<IWebhookSubscriptionConnector | null> {
    return WebhookSubscriptionConnector.findOne({
      tenantId: this.config.tenantId,
      connectorId: this.config.connectorId,
      driveId,
    });
  }
}
