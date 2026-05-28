/**
 * Webhook Subscription Model
 *
 * HTTP Async channel callback registrations. Each subscription defines
 * a callback URL that receives agent responses via signed webhook POST.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

const WEBHOOK_EVENTS = ['agent.response', 'agent.status'] as const;
const WEBHOOK_SUBSCRIPTION_STATUSES = ['active', 'paused', 'deactivated'] as const;

// ─── Document Interface ──────────────────────────────────────────────────

export interface IWebhookSubscription {
  _id: string;
  tenantId: string;
  channelConnectionId: string;
  callbackUrl: string;
  encryptedSecret: string;
  /** Auth profile ID for credential resolution. Reserved — not yet wired to a runtime consumer. */
  authProfileId: string | null;
  events: string;
  status: string;
  description: string | null;
  lastDeliveryAt: Date | null;
  failureCount: number;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const WebhookSubscriptionSchema = new Schema<IWebhookSubscription>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    channelConnectionId: { type: String, required: true },
    callbackUrl: { type: String, required: true, maxlength: 2048 },
    encryptedSecret: { type: String, required: true },
    authProfileId: { type: String, default: null },
    events: {
      type: String,
      default: JSON.stringify(WEBHOOK_EVENTS),
      validate: {
        validator(value: string) {
          try {
            const parsed = JSON.parse(value) as string[];
            return (
              Array.isArray(parsed) &&
              parsed.length > 0 &&
              parsed.every((eventName) =>
                WEBHOOK_EVENTS.includes(eventName as (typeof WEBHOOK_EVENTS)[number]),
              )
            );
          } catch {
            return false;
          }
        },
        message: 'events must be a JSON array of allowed webhook events',
      },
    },
    status: { type: String, enum: WEBHOOK_SUBSCRIPTION_STATUSES, default: 'active' },
    description: { type: String, default: null },
    lastDeliveryAt: { type: Date, default: null },
    failureCount: { type: Number, default: 0, min: 0 },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'webhook_subscriptions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

WebhookSubscriptionSchema.plugin(tenantIsolationPlugin);
WebhookSubscriptionSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedSecret'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

WebhookSubscriptionSchema.index({ tenantId: 1, status: 1 });
WebhookSubscriptionSchema.index({ channelConnectionId: 1 });
WebhookSubscriptionSchema.index({ tenantId: 1, createdAt: -1 });
WebhookSubscriptionSchema.index({ tenantId: 1, channelConnectionId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const WebhookSubscription =
  (mongoose.models.WebhookSubscription as any) ||
  model<IWebhookSubscription>('WebhookSubscription', WebhookSubscriptionSchema);
