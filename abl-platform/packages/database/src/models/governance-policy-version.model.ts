import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { IGovernancePolicyRule } from './governance-policy.model.js';

// ─── Interface ───────────────────────────────────────────────────────────

export interface IGovernancePolicyVersion {
  _id: string;
  tenantId: string;
  projectId: string;
  policyId: string;
  version: number;
  rules: IGovernancePolicyRule[];
  createdAt: Date;
}

// ─── Embedded Schema ─────────────────────────────────────────────────────

const GovernancePolicyRuleSnapshotSchema = new Schema(
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

const GovernancePolicyVersionSchema = new Schema<IGovernancePolicyVersion>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    policyId: { type: String, required: true },
    version: { type: Number, required: true },
    rules: { type: [GovernancePolicyRuleSnapshotSchema], required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'governance_policy_versions',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

GovernancePolicyVersionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

GovernancePolicyVersionSchema.index({ tenantId: 1, policyId: 1, version: 1 }, { unique: true });
GovernancePolicyVersionSchema.index({ tenantId: 1, policyId: 1, createdAt: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const GovernancePolicyVersion =
  (mongoose.models.GovernancePolicyVersion as mongoose.Model<IGovernancePolicyVersion>) ||
  model<IGovernancePolicyVersion>('GovernancePolicyVersion', GovernancePolicyVersionSchema);
