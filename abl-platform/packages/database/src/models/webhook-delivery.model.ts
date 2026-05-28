/**
 * Webhook Delivery Model
 *
 * Tracks individual webhook delivery attempts with retry status,
 * HTTP response codes, and idempotency keys for exactly-once semantics.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
const WEBHOOK_DELIVERY_EVENTS = ['agent.response', 'agent.status'] as const;
const WEBHOOK_DELIVERY_RETENTION_DAYS = Number.parseInt(
  process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || '0',
  10,
);

// ─── Document Interface ──────────────────────────────────────────────────

export interface IWebhookDelivery {
  _id: string;
  tenantId: string;
  subscriptionId: string;
  idempotencyKey: string;
  eventType: string;
  payload: string;
  status: string;
  httpStatus: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const WebhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    subscriptionId: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    eventType: { type: String, required: true, enum: WEBHOOK_DELIVERY_EVENTS },
    payload: { type: String, required: true },
    status: { type: String, enum: WEBHOOK_DELIVERY_STATUSES, default: 'pending' },
    httpStatus: { type: Number, default: null },
    responseBody: { type: String, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'webhook_deliveries' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

WebhookDeliverySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

WebhookDeliverySchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
WebhookDeliverySchema.index({ subscriptionId: 1, status: 1 });
WebhookDeliverySchema.index({ tenantId: 1, createdAt: -1 });
WebhookDeliverySchema.index({ tenantId: 1, subscriptionId: 1, createdAt: -1 });

if (Number.isFinite(WEBHOOK_DELIVERY_RETENTION_DAYS) && WEBHOOK_DELIVERY_RETENTION_DAYS > 0) {
  WebhookDeliverySchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 },
  );
}

// ─── Model ───────────────────────────────────────────────────────────────

export const WebhookDelivery =
  (mongoose.models.WebhookDelivery as any) ||
  model<IWebhookDelivery>('WebhookDelivery', WebhookDeliverySchema);
