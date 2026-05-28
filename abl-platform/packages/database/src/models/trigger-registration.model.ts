/**
 * TriggerRegistration Model
 *
 * Stores active trigger registrations for workflows.
 * Supports three trigger strategies: webhook, polling, and cron.
 * Tracks health metrics (consecutive errors, last fired, auto-pause).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Mirrors REGISTRATION_TRIGGER_TYPES in @agent-platform/shared/types/workflow-schemas */
export const REGISTRATION_TRIGGER_TYPES = ['webhook', 'cron', 'event'] as const;
export type RegistrationTriggerType = (typeof REGISTRATION_TRIGGER_TYPES)[number];

/** Mirrors WEBHOOK_MODES in @agent-platform/shared/types/workflow-schemas */
const WEBHOOK_MODES = ['sync', 'async'] as const;
type WebhookMode = (typeof WEBHOOK_MODES)[number];

/** Mirrors WEBHOOK_DELIVERIES in @agent-platform/shared/types/workflow-schemas */
const WEBHOOK_DELIVERIES = ['poll', 'push'] as const;
type WebhookDelivery = (typeof WEBHOOK_DELIVERIES)[number];

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITriggerRegistration {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  connectorName?: string;
  triggerName: string;
  triggerType: RegistrationTriggerType;
  connectionId?: string;
  config: Record<string, unknown>;
  status: 'active' | 'paused' | 'error' | 'deleted' | 'inactive';
  deletedAt?: Date;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookMode?: WebhookMode;
  webhookDelivery?: WebhookDelivery;
  callbackUrl?: string;
  authProfileId: string | null;
  pollingIntervalMs?: number;
  bullmqJobId?: string;
  cronExpression?: string;
  missedFirePolicy?: 'fire_once' | 'fire_all' | 'skip';
  lastFiredAt?: Date;
  lastErrorAt?: Date;
  consecutiveErrors: number;
  environment?: string;
  /**
   * Last sample payload captured for this trigger — set by the design-time
   * `testSample` endpoint. Stored as an encrypted JSON string (DEK envelope).
   * Read and decrypted by `getLastFirePayload` server-side.
   */
  samplePayload?: string;
  /** Expiry for the stored sample payload — cleared on read after this date. */
  samplePayloadExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TriggerRegistrationSchema = new Schema<ITriggerRegistration>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    workflowId: { type: String, required: true },
    workflowVersionId: { type: String },
    workflowVersion: { type: String },
    connectorName: { type: String, required: false },
    triggerName: { type: String, required: true },
    triggerType: {
      type: String,
      enum: [...REGISTRATION_TRIGGER_TYPES],
      required: true,
    },
    connectionId: { type: String, required: false },
    config: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['active', 'paused', 'error', 'deleted', 'inactive'],
      default: 'active',
    },
    deletedAt: { type: Date },
    webhookUrl: { type: String },
    webhookSecret: { type: String },
    webhookMode: { type: String, enum: [...WEBHOOK_MODES] },
    webhookDelivery: { type: String, enum: [...WEBHOOK_DELIVERIES] },
    callbackUrl: { type: String },
    authProfileId: { type: String, default: null },
    pollingIntervalMs: { type: Number },
    bullmqJobId: { type: String },
    cronExpression: { type: String },
    missedFirePolicy: {
      type: String,
      enum: ['fire_once', 'fire_all', 'skip'],
    },
    lastFiredAt: { type: Date },
    lastErrorAt: { type: Date },
    consecutiveErrors: { type: Number, default: 0 },
    environment: { type: String, default: null },
    samplePayload: { type: String, default: null },
    samplePayloadExpiresAt: { type: Date },
  },
  { timestamps: true, collection: 'trigger_registrations' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TriggerRegistrationSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

TriggerRegistrationSchema.index({ tenantId: 1, workflowId: 1 });
TriggerRegistrationSchema.index({ tenantId: 1, connectorName: 1, status: 1 });
TriggerRegistrationSchema.index({ tenantId: 1, projectId: 1 });
TriggerRegistrationSchema.index({ tenantId: 1, workflowVersionId: 1, status: 1 });
// TTL index — MongoDB auto-removes expired sample payloads. expireAfterSeconds:0
// means MongoDB checks the date stored in the field itself (7-day window set on write).
TriggerRegistrationSchema.index(
  { samplePayloadExpiresAt: 1 },
  { expireAfterSeconds: 0, sparse: true },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const TriggerRegistration =
  (mongoose.models.TriggerRegistration as any) ||
  model<ITriggerRegistration>('TriggerRegistration', TriggerRegistrationSchema);
