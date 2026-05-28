/**
 * Alert Config Model
 *
 * Stores per-tenant alert configuration rules that trigger notifications
 * when usage thresholds, credit levels, health conditions, or feature
 * limits are breached. Supports webhook and email delivery channels
 * with configurable cooldown periods.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAlertConfig {
  _id: string;
  tenantId: string;
  type: 'usage_threshold' | 'credit_low' | 'health_degraded' | 'feature_limit';
  threshold: number;
  channel: 'webhook' | 'email';
  target: string;
  enabled: boolean;
  cooldownMinutes: number;
  lastTriggeredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AlertConfigSchema = new Schema<IAlertConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    type: {
      type: String,
      enum: ['usage_threshold', 'credit_low', 'health_degraded', 'feature_limit'],
      required: true,
    },
    threshold: { type: Number, required: true },
    channel: {
      type: String,
      enum: ['webhook', 'email'],
      required: true,
    },
    target: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    cooldownMinutes: { type: Number, default: 60 },
    lastTriggeredAt: { type: Date, default: undefined },
  },
  { timestamps: true, collection: 'alert_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AlertConfigSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

AlertConfigSchema.index({ tenantId: 1, type: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const AlertConfig =
  (mongoose.models.AlertConfig as any) || model<IAlertConfig>('AlertConfig', AlertConfigSchema);
