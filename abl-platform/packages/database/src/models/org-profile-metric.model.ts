/**
 * Org Profile Metric Model
 *
 * Records telemetry for LLM-assisted organization profile generation.
 * Tracks mode used, success/failure, cost, duration, and profile quality metrics.
 * Scoped to tenant for usage analytics and optimization insights.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IOrgProfileMetric {
  _id: string;
  tenantId: string;
  indexId: string;
  mode: 'url' | 'name-industry' | 'paragraph';
  status:
    | 'success'
    | 'validation_failure'
    | 'ssrf_blocked'
    | 'circuit_breaker'
    | 'timeout'
    | 'llm_error'
    | 'unknown_error';
  durationMs: number;
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';

  // Input details (sanitized)
  inputType?: string; // e.g., 'url', 'domain', 'custom'
  inputLength?: number; // Character count for paragraph mode

  // Output quality metrics (only on success)
  organizationName?: string;
  industry?: string;
  keyTermsCount?: number;
  acronymsCount?: number;
  departmentBoundariesCount?: number;
  productSpecificNamesCount?: number;

  // Error details (only on failure)
  errorType?: string;
  errorMessage?: string;
  suggestedAction?: string;

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const OrgProfileMetricSchema = new Schema<IOrgProfileMetric>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    mode: { type: String, required: true, enum: ['url', 'name-industry', 'paragraph'] },
    status: {
      type: String,
      required: true,
      enum: [
        'success',
        'validation_failure',
        'ssrf_blocked',
        'circuit_breaker',
        'timeout',
        'llm_error',
        'unknown_error',
      ],
    },
    durationMs: { type: Number, required: true },
    estimatedCost: { type: Number, required: true },
    inputTokens: { type: Number, required: true },
    outputTokens: { type: Number, required: true },
    circuitBreakerState: { type: String, required: true, enum: ['CLOSED', 'OPEN', 'HALF_OPEN'] },

    inputType: { type: String },
    inputLength: { type: Number },

    organizationName: { type: String },
    industry: { type: String },
    keyTermsCount: { type: Number },
    acronymsCount: { type: Number },
    departmentBoundariesCount: { type: Number },
    productSpecificNamesCount: { type: Number },

    errorType: { type: String },
    errorMessage: { type: String },
    suggestedAction: { type: String },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'org_profile_metrics' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

OrgProfileMetricSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Query by tenant and time range
OrgProfileMetricSchema.index({ tenantId: 1, createdAt: -1 });

// Query by index and time range
OrgProfileMetricSchema.index({ tenantId: 1, indexId: 1, createdAt: -1 });

// Aggregate by mode
OrgProfileMetricSchema.index({ tenantId: 1, mode: 1 });

// Filter by status
OrgProfileMetricSchema.index({ tenantId: 1, status: 1 });

// Circuit breaker monitoring
OrgProfileMetricSchema.index({ circuitBreakerState: 1, createdAt: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition(
  'OrgProfileMetric',
  OrgProfileMetricSchema,
  'searchaicontent',
);

export const OrgProfileMetric =
  (mongoose.models.OrgProfileMetric as any) ||
  model<IOrgProfileMetric>('OrgProfileMetric', OrgProfileMetricSchema);
