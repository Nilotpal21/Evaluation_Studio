/**
 * BillingReplaySessionResult Model
 *
 * Stores per-session compare-only replay artifacts for a BillingReplayRun.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

export type BillingReplayMetricsSource = 'clickhouse' | 'message_fallback';

export interface IBillingReplaySessionResult {
  _id: string;
  tenantId: string;
  projectId: string;
  runId: string;
  sessionId: string;
  sequence: number;
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
  metricsSource: BillingReplayMetricsSource;
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

const BillingReplaySessionResultSchema = new Schema<IBillingReplaySessionResult>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    runId: { type: String, required: true },
    sessionId: { type: String, required: true },
    sequence: { type: Number, required: true },
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
  { timestamps: true, collection: 'billing_replay_session_results' },
);

BillingReplaySessionResultSchema.plugin(tenantIsolationPlugin);

BillingReplaySessionResultSchema.index({ tenantId: 1, runId: 1, sequence: 1 });
BillingReplaySessionResultSchema.index({ tenantId: 1, runId: 1, sessionId: 1 }, { unique: true });
BillingReplaySessionResultSchema.index({ tenantId: 1, sessionId: 1, createdAt: -1 });

export const BillingReplaySessionResult =
  (mongoose.models.BillingReplaySessionResult as mongoose.Model<IBillingReplaySessionResult>) ||
  model<IBillingReplaySessionResult>(
    'BillingReplaySessionResult',
    BillingReplaySessionResultSchema,
  );
