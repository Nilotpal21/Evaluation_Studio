/**
 * BillingMaterializationBatch Model
 *
 * Stores aggregate billing-unit materialization runs that are safe to expose to
 * analytics consumers and operator tooling. Session-level results for each
 * batch are persisted alongside the batch in billing_materialization_session_results.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { BillingMaterializationBasis, IBillingUnitPolicy } from './subscription.model.js';

export interface IBillingMaterializationRequest {
  projectId?: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  endedBefore?: Date | null;
}

export interface IBillingMaterializationScope {
  basis: BillingMaterializationBasis;
  windowStart: Date | null;
  windowEnd: Date | null;
  endedBefore: Date | null;
  completedSessionsCount: number | null;
  periodLabel: string | null;
}

export interface IBillingMaterializationProjectBreakdown {
  projectId: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface IBillingMaterializationChannelBreakdown {
  channel: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface IBillingMaterializationSummary {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  exclusionCounts: Record<string, number>;
  metricsSourceCounts: Record<string, number>;
  projectBreakdown: IBillingMaterializationProjectBreakdown[];
  channelBreakdown: IBillingMaterializationChannelBreakdown[];
}

export interface IBillingMaterializationBatch {
  _id: string;
  tenantId: string;
  projectId: string | null;
  subscriptionId: string;
  status: 'running' | 'completed' | 'failed';
  triggerSource: 'manual' | 'scheduled';
  triggeredBy: string;
  request: IBillingMaterializationRequest;
  planTier: string;
  policySnapshot: IBillingUnitPolicy;
  scope: IBillingMaterializationScope;
  summary: IBillingMaterializationSummary | null;
  warnings: string[];
  resultCount: number;
  eventId: string | null;
  eventDispatchAttempted: boolean;
  failureReason: string | null;
  startedAt: Date;
  completedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const BillingMaterializationBatchSchema = new Schema<IBillingMaterializationBatch>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    subscriptionId: { type: String, required: true },
    status: {
      type: String,
      enum: ['running', 'completed', 'failed'],
      default: 'running',
    },
    triggerSource: {
      type: String,
      enum: ['manual', 'scheduled'],
      default: 'manual',
    },
    triggeredBy: { type: String, required: true },
    request: { type: Schema.Types.Mixed, required: true },
    planTier: { type: String, required: true },
    policySnapshot: { type: Schema.Types.Mixed, required: true },
    scope: { type: Schema.Types.Mixed, required: true },
    summary: { type: Schema.Types.Mixed, default: null },
    warnings: { type: [String], default: [] },
    resultCount: { type: Number, default: 0 },
    eventId: { type: String, default: null },
    eventDispatchAttempted: { type: Boolean, default: false },
    failureReason: { type: String, default: null },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'billing_materialization_batches' },
);

BillingMaterializationBatchSchema.plugin(tenantIsolationPlugin);

BillingMaterializationBatchSchema.index({ tenantId: 1, createdAt: -1 });
BillingMaterializationBatchSchema.index({ tenantId: 1, projectId: 1, createdAt: -1 });
BillingMaterializationBatchSchema.index({ subscriptionId: 1, createdAt: -1 });
BillingMaterializationBatchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const BillingMaterializationBatch =
  (mongoose.models.BillingMaterializationBatch as mongoose.Model<IBillingMaterializationBatch>) ||
  model<IBillingMaterializationBatch>(
    'BillingMaterializationBatch',
    BillingMaterializationBatchSchema,
  );
