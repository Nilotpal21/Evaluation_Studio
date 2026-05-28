/**
 * BillingMaterializationSessionResult Model
 *
 * Stores per-session artifacts for a persisted billing materialization batch.
 * This is the durable audit surface for manual and scheduled materializations.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { BillingMaterializationBasis } from './subscription.model.js';

export type BillingMaterializationSessionMetricsSource = 'clickhouse' | 'message_fallback';
export type BillingMaterializationTriggerSource = 'manual' | 'scheduled';

export interface IBillingMaterializationSessionResult {
  _id: string;
  tenantId: string;
  subscriptionId: string;
  projectId: string;
  batchId: string;
  sequence: number;
  sessionId: string;
  triggerSource: BillingMaterializationTriggerSource;
  materializationBasis: BillingMaterializationBasis;
  channel: string;
  status: string;
  disposition: string | null;
  sessionType: string | null;
  startedAt: Date;
  endedAt: Date;
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

const BillingMaterializationSessionResultSchema = new Schema<IBillingMaterializationSessionResult>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    subscriptionId: { type: String, required: true },
    projectId: { type: String, required: true },
    batchId: { type: String, required: true },
    sequence: { type: Number, required: true },
    sessionId: { type: String, required: true },
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
  { timestamps: true, collection: 'billing_materialization_session_results' },
);

BillingMaterializationSessionResultSchema.plugin(tenantIsolationPlugin);

BillingMaterializationSessionResultSchema.index({ tenantId: 1, batchId: 1, sequence: 1 });
BillingMaterializationSessionResultSchema.index(
  { tenantId: 1, batchId: 1, sessionId: 1 },
  { unique: true },
);
BillingMaterializationSessionResultSchema.index({ tenantId: 1, sessionId: 1, createdAt: -1 });
BillingMaterializationSessionResultSchema.index({ subscriptionId: 1, createdAt: -1 });

export const BillingMaterializationSessionResult =
  (mongoose.models
    .BillingMaterializationSessionResult as mongoose.Model<IBillingMaterializationSessionResult>) ||
  model<IBillingMaterializationSessionResult>(
    'BillingMaterializationSessionResult',
    BillingMaterializationSessionResultSchema,
  );
