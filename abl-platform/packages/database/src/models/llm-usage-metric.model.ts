/**
 * LLM Usage Metric Model
 *
 * Records per-call metrics for LLM invocations including token counts,
 * latency, estimated cost, and error tracking. Scoped to a tenant
 * for multi-tenant usage analytics and billing.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ILLMUsageMetric {
  _id: string;
  tenantId: string;
  sessionId: string;
  agentName: string;
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  estimatedCost: number;
  status: string;
  errorMessage: string | null;
  metadata: any;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const LLMUsageMetricSchema = new Schema<ILLMUsageMetric>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    sessionId: { type: String, required: true },
    agentName: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    operation: { type: String, required: true },
    inputTokens: { type: Number, required: true },
    outputTokens: { type: Number, required: true },
    totalTokens: { type: Number, required: true },
    latencyMs: { type: Number, required: true },
    estimatedCost: { type: Number, required: true },
    status: { type: String, required: true },
    errorMessage: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'llm_usage_metrics' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

LLMUsageMetricSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

LLMUsageMetricSchema.index({ tenantId: 1, createdAt: -1 });
LLMUsageMetricSchema.index({ sessionId: 1 });
LLMUsageMetricSchema.index({ tenantId: 1, provider: 1, model: 1 });
LLMUsageMetricSchema.index({ tenantId: 1, agentName: 1 });
LLMUsageMetricSchema.index({ status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const LLMUsageMetric =
  (mongoose.models.LLMUsageMetric as any) ||
  model<ILLMUsageMetric>('LLMUsageMetric', LLMUsageMetricSchema);
