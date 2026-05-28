/**
 * Webhook Subscription Connector Model
 *
 * Tracks Microsoft Graph webhook subscriptions for SharePoint connector drives.
 * Each subscription monitors a specific drive for change notifications.
 * Subscriptions expire after 24 hours and must be renewed.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

const WEBHOOK_SUBSCRIPTION_STATUSES = ['active', 'expired', 'failed'] as const;

// ─── Document Interface ──────────────────────────────────────────────────

export interface IWebhookSubscriptionConnector {
  _id: string;
  tenantId: string;
  /** References ConnectorConfig._id */
  connectorId: string;
  /** SharePoint drive ID being monitored */
  driveId: string;
  /** Microsoft Graph subscription ID */
  subscriptionId: string;
  /** Webhook receiver endpoint URL */
  notificationUrl: string;
  /** Validation secret (encrypted) for verifying webhook authenticity */
  encryptedClientState: string;
  /** Auth profile ID for credential resolution. Reserved — not yet wired to a runtime consumer. */
  authProfileId: string | null;
  /** When the subscription expires (Graph limit: 24 hours) */
  expiresAt: Date;
  /** Subscription status */
  status: 'active' | 'expired' | 'failed';
  /** When the subscription was last renewed */
  lastRenewalAt: Date | null;
  /** Consecutive renewal failure count */
  renewalFailures: number;
  /** Last renewal error message */
  lastRenewalError: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const WebhookSubscriptionConnectorSchema = new Schema<IWebhookSubscriptionConnector>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectorId: { type: String, required: true },
    driveId: { type: String, required: true },
    subscriptionId: { type: String, required: true },
    notificationUrl: { type: String, required: true, maxlength: 2048 },
    encryptedClientState: { type: String, required: true },
    authProfileId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: WEBHOOK_SUBSCRIPTION_STATUSES, default: 'active' },
    lastRenewalAt: { type: Date, default: null },
    renewalFailures: { type: Number, default: 0, min: 0 },
    lastRenewalError: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'webhook_subscription_connectors' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

WebhookSubscriptionConnectorSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary lookup: subscription for a specific drive
WebhookSubscriptionConnectorSchema.index(
  { tenantId: 1, connectorId: 1, driveId: 1 },
  { unique: true },
);

// Renewal job: find subscriptions expiring soon
WebhookSubscriptionConnectorSchema.index({ expiresAt: 1, status: 1 });

// Cleanup job: find expired/failed subscriptions
WebhookSubscriptionConnectorSchema.index({ status: 1, updatedAt: 1 });

// Lookup by connector: find all subscriptions for a connector
WebhookSubscriptionConnectorSchema.index({ connectorId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const WebhookSubscriptionConnector =
  (mongoose.models.WebhookSubscriptionConnector as mongoose.Model<IWebhookSubscriptionConnector>) ||
  model<IWebhookSubscriptionConnector>(
    'WebhookSubscriptionConnector',
    WebhookSubscriptionConnectorSchema,
  );
