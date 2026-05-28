/**
 * BillingUsagePublishedSession Model
 *
 * Stores the authoritative session-level billing usage projection that is
 * published after a materialization batch is applied. Reporting surfaces read
 * from this collection so overlapping replay/materialization batches do not
 * double-count sessions.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { BillingMaterializationBasis } from './subscription.model.js';
import type {
  BillingMaterializationSessionMetricsSource,
  BillingMaterializationTriggerSource,
} from './billing-materialization-session-result.model.js';

export interface IBillingUsagePublishedSession {
  _id: string;
  tenantId: string;
  projectId: string;
  subscriptionId: string;
  sessionId: string;
  batchId: string;
  applicationId: string;
  batchCreatedAt: Date;
  triggerSource: BillingMaterializationTriggerSource;
  materializationBasis: BillingMaterializationBasis;
  channel: string;
  status: string;
  disposition: string | null;
  sessionType: string | null;
  startedAt: Date;
  endedAt: Date;
  publishedAt: Date;
  durationSeconds: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolMessageCount: number;
  interactiveTurnCount: number;
  engagedSeconds: number;
  llmCallCount: number;
  toolCallCount: number;
  metricsSource: BillingMaterializationSessionMetricsSource;
  included: boolean;
  exclusionReasons: string[];
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const BillingUsagePublishedSessionSchema = new Schema<IBillingUsagePublishedSession>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    subscriptionId: { type: String, required: true },
    sessionId: { type: String, required: true },
    batchId: { type: String, required: true },
    applicationId: { type: String, required: true },
    batchCreatedAt: { type: Date, required: true },
    triggerSource: {
      type: String,
      enum: ['manual', 'scheduled'],
      required: true,
    },
    materializationBasis: {
      type: String,
      enum: ['time_window', 'completed_sessions'],
      required: true,
    },
    channel: { type: String, required: true },
    status: { type: String, required: true },
    disposition: { type: String, default: null },
    sessionType: { type: String, default: null },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    publishedAt: { type: Date, required: true },
    durationSeconds: { type: Number, required: true },
    userMessageCount: { type: Number, required: true },
    assistantMessageCount: { type: Number, required: true },
    toolMessageCount: { type: Number, required: true },
    interactiveTurnCount: { type: Number, required: true },
    engagedSeconds: { type: Number, required: true },
    llmCallCount: { type: Number, required: true },
    toolCallCount: { type: Number, required: true },
    metricsSource: {
      type: String,
      enum: ['clickhouse', 'message_fallback'],
      required: true,
    },
    included: { type: Boolean, required: true },
    exclusionReasons: { type: [String], default: [] },
    baseUnits: { type: Number, required: true },
    llmAddonUnits: { type: Number, required: true },
    toolAddonUnits: { type: Number, required: true },
    totalUnits: { type: Number, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'billing_usage_published_sessions' },
);

BillingUsagePublishedSessionSchema.plugin(tenantIsolationPlugin);

BillingUsagePublishedSessionSchema.index(
  { tenantId: 1, sessionId: 1 },
  { unique: true, name: 'uniq_billing_usage_published_session' },
);
BillingUsagePublishedSessionSchema.index({ endedAt: -1 });
BillingUsagePublishedSessionSchema.index({ tenantId: 1, endedAt: -1 });
BillingUsagePublishedSessionSchema.index({ tenantId: 1, projectId: 1, endedAt: -1 });
BillingUsagePublishedSessionSchema.index({ tenantId: 1, channel: 1, endedAt: -1 });
BillingUsagePublishedSessionSchema.index({ batchId: 1, createdAt: -1 });
BillingUsagePublishedSessionSchema.index({ applicationId: 1, createdAt: -1 });

export const BillingUsagePublishedSession =
  (mongoose.models.BillingUsagePublishedSession as mongoose.Model<IBillingUsagePublishedSession>) ||
  model<IBillingUsagePublishedSession>(
    'BillingUsagePublishedSession',
    BillingUsagePublishedSessionSchema,
  );
