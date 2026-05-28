/**
 * AlertRule Model
 *
 * Stores per-tenant, per-project alert rules that trigger notifications
 * when analytics metrics breach configured thresholds.
 */

import mongoose, { Schema, type Document } from 'mongoose';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAlertChannel {
  type: 'slack' | 'email' | 'webhook';
  config: Record<string, unknown>;
}

export interface IAlertRule extends Document {
  tenantId: string;
  projectId: string;
  name: string;
  enabled: boolean;
  metric: string;
  sourceTable: string;
  aggregation: 'avg' | 'sum' | 'count' | 'min' | 'max' | 'p95' | 'p99';
  windowMinutes: number;
  condition: 'gt' | 'lt' | 'gte' | 'lte';
  threshold: number;
  cooldownMinutes: number;
  channels: IAlertChannel[];
  lastEvaluatedAt?: Date;
  lastFiredAt?: Date;
  status: 'ok' | 'firing' | 'cooldown';
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AlertRuleSchema = new Schema<IAlertRule>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    metric: { type: String, required: true },
    sourceTable: { type: String, required: true },
    aggregation: {
      type: String,
      required: true,
      enum: ['avg', 'sum', 'count', 'min', 'max', 'p95', 'p99'],
    },
    windowMinutes: { type: Number, required: true, min: 1 },
    condition: {
      type: String,
      required: true,
      enum: ['gt', 'lt', 'gte', 'lte'],
    },
    threshold: { type: Number, required: true },
    cooldownMinutes: { type: Number, default: 60, min: 0 },
    channels: [
      {
        type: {
          type: String,
          required: true,
          enum: ['slack', 'email', 'webhook'],
        },
        config: { type: Schema.Types.Mixed, required: true },
      },
    ],
    lastEvaluatedAt: { type: Date },
    lastFiredAt: { type: Date },
    status: {
      type: String,
      enum: ['ok', 'firing', 'cooldown'],
      default: 'ok',
    },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'alert_rules' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

AlertRuleSchema.index({ tenantId: 1, projectId: 1, enabled: 1 });
AlertRuleSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const AlertRuleModel =
  mongoose.models['AlertRule'] ?? mongoose.model<IAlertRule>('AlertRule', AlertRuleSchema);
