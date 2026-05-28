import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Metric Registry ─────────────────────────────────────────────────────
// Raw ClickHouse column names used in breach detection WHERE clauses.

export const METRIC_REGISTRY: Record<string, string[]> = {
  quality_evaluation: ['overall_score', 'helpfulness', 'accuracy'],
  hallucination_detection: ['overall_score', 'faithfulness_score'],
  guardrail_analysis: ['overall_score', 'false_positive_score', 'false_negative_score'],
  drift_detection: ['drift_score'],
  context_preservation: ['overall_score', 'context_score'],
  knowledge_gap: ['overall_score', 'retrieval_precision', 'gap_detected'],
  friction_detection: ['friction_score'],
  anomaly_detection: ['z_score'],
  sentiment_analysis: ['avg_sentiment'],
  intent_classification: ['confidence'],
  llm_evaluate: ['overall_score'],
};

// Summary response field aliases (status endpoint reads these aliased columns).
export const METRIC_SUMMARY_ALIAS: Record<string, Record<string, string>> = {
  quality_evaluation: { overall_score: 'avg_overall_score' },
  hallucination_detection: { overall_score: 'avg_score', faithfulness_score: 'avg_faithfulness' },
  guardrail_analysis: {
    overall_score: 'avg_score',
    false_positive_score: 'avg_false_positive',
    false_negative_score: 'avg_false_negative',
  },
  drift_detection: { drift_score: 'avg_drift_score' },
  context_preservation: { overall_score: 'avg_score', context_score: 'avg_context_score' },
  knowledge_gap: {
    overall_score: 'avg_score',
    retrieval_precision: 'avg_retrieval_precision',
    gap_detected: 'gap_count',
  },
  friction_detection: { friction_score: 'avg_friction_score' },
  anomaly_detection: { z_score: 'avg_z_score' },
  sentiment_analysis: { avg_sentiment: 'avg_sentiment' },
  intent_classification: { confidence: 'avg_confidence' },
  llm_evaluate: { overall_score: 'avg_score' },
};

// ─── Interfaces ──────────────────────────────────────────────────────────

export interface IGovernancePolicyRule {
  pipelineType: string;
  metric: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  threshold: number;
  severity: 'critical' | 'warning' | 'info';
}

export interface IGovernancePolicy {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  version: number;
  rules: IGovernancePolicyRule[];
  status: 'enabled' | 'disabled';
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schema ─────────────────────────────────────────────────────

const GovernancePolicyRuleSchema = new Schema<IGovernancePolicyRule>(
  {
    pipelineType: { type: String, required: true },
    metric: { type: String, required: true },
    operator: { type: String, required: true, enum: ['gt', 'gte', 'lt', 'lte', 'eq'] },
    threshold: { type: Number, required: true },
    severity: { type: String, required: true, enum: ['critical', 'warning', 'info'] },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const GovernancePolicySchema = new Schema<IGovernancePolicy>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: undefined },
    version: { type: Number, required: true, default: 1, min: 1 },
    rules: { type: [GovernancePolicyRuleSchema], required: true },
    status: { type: String, required: true, enum: ['enabled', 'disabled'], default: 'enabled' },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'governance_policies' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

GovernancePolicySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

GovernancePolicySchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
GovernancePolicySchema.index({ tenantId: 1, projectId: 1, status: 1 });
GovernancePolicySchema.index({ tenantId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const GovernancePolicy =
  (mongoose.models.GovernancePolicy as mongoose.Model<IGovernancePolicy>) ||
  model<IGovernancePolicy>('GovernancePolicy', GovernancePolicySchema);
