/**
 * BillingReplayRun Model
 *
 * Tracks compare-only replay/backfill runs over ended conversation sessions.
 * Session-level replay artifacts live in billing_replay_session_results.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { BillingMaterializationBasis, IBillingUnitPolicy } from './subscription.model.js';

export interface IBillingReplayRequest {
  projectId?: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  endedBefore?: Date | null;
}

export interface IBillingReplayScope {
  basis: BillingMaterializationBasis;
  windowStart: Date | null;
  windowEnd: Date | null;
  endedBefore: Date | null;
  completedSessionsCount: number | null;
  periodLabel: string | null;
}

export interface IBillingReplayProjectBreakdown {
  projectId: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface IBillingReplayChannelBreakdown {
  channel: string;
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
}

export interface IBillingReplaySummary {
  examinedSessionCount: number;
  includedSessionCount: number;
  excludedSessionCount: number;
  baseUnits: number;
  llmAddonUnits: number;
  toolAddonUnits: number;
  totalUnits: number;
  exclusionCounts: Record<string, number>;
  metricsSourceCounts: Record<string, number>;
  projectBreakdown: IBillingReplayProjectBreakdown[];
  channelBreakdown: IBillingReplayChannelBreakdown[];
}

export interface IBillingReplayRun {
  _id: string;
  tenantId: string;
  projectId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  mode: 'compare_only';
  triggerSource: 'manual';
  triggeredBy: string;
  request: IBillingReplayRequest;
  planTier: string;
  policySnapshot: IBillingUnitPolicy;
  scope: IBillingReplayScope;
  summary: IBillingReplaySummary | null;
  warnings: string[];
  resultCount: number;
  failureReason: string | null;
  startedAt: Date;
  completedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const BillingReplayRunSchema = new Schema<IBillingReplayRun>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    mode: {
      type: String,
      enum: ['compare_only'],
      default: 'compare_only',
    },
    triggerSource: {
      type: String,
      enum: ['manual'],
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
    failureReason: { type: String, default: null },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'billing_replay_runs' },
);

BillingReplayRunSchema.plugin(tenantIsolationPlugin);

BillingReplayRunSchema.index({ tenantId: 1, createdAt: -1 });
BillingReplayRunSchema.index({ tenantId: 1, projectId: 1, createdAt: -1 });
BillingReplayRunSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const BillingReplayRun =
  (mongoose.models.BillingReplayRun as mongoose.Model<IBillingReplayRun>) ||
  model<IBillingReplayRun>('BillingReplayRun', BillingReplayRunSchema);
