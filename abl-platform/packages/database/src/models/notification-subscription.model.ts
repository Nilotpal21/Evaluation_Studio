/**
 * Notification Subscription Model
 *
 * Tracks per-user subscriptions to connector events. Each subscription
 * defines which event categories and delivery channels are active for
 * a specific connector.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface INotificationSubscription {
  _id: string;
  tenantId: string;
  userId: string;
  connectorId: string;
  eventCategories: Array<'auth' | 'config' | 'sync' | 'permission' | 'lifecycle'>;
  channels: Array<'in_app' | 'email' | 'webhook'>;
  webhookUrl: string | null;
  isActive: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const NotificationSubscriptionSchema = new Schema<INotificationSubscription>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    connectorId: { type: String, required: true },
    eventCategories: {
      type: [String],
      enum: ['auth', 'config', 'sync', 'permission', 'lifecycle'],
      default: [],
    },
    channels: {
      type: [String],
      enum: ['in_app', 'email', 'webhook'],
      default: ['in_app'],
    },
    webhookUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'notification_subscriptions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

NotificationSubscriptionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique subscription per user per connector per tenant
NotificationSubscriptionSchema.index({ tenantId: 1, userId: 1, connectorId: 1 }, { unique: true });

// Find active subscribers for a connector
NotificationSubscriptionSchema.index({ tenantId: 1, connectorId: 1, isActive: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

ModelRegistry.registerModelDefinition(
  'NotificationSubscription',
  NotificationSubscriptionSchema,
  'platform',
);

export const NotificationSubscription =
  (mongoose.models.NotificationSubscription as mongoose.Model<INotificationSubscription>) ||
  model<INotificationSubscription>('NotificationSubscription', NotificationSubscriptionSchema);
