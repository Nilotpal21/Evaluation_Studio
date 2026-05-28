import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Interface ───────────────────────────────────────────────────────────

export interface IGovernanceOverride {
  _id: string;
  tenantId: string;
  projectId: string;
  eventRef: string;
  reviewedBy: string;
  justification: string;
  originalSeverity: 'critical' | 'warning' | 'info';
  policyVersion: number;
  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const GovernanceOverrideSchema = new Schema<IGovernanceOverride>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    eventRef: { type: String, required: true },
    reviewedBy: { type: String, required: true },
    justification: { type: String, required: true },
    originalSeverity: { type: String, required: true, enum: ['critical', 'warning', 'info'] },
    policyVersion: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'governance_overrides' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

GovernanceOverrideSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

GovernanceOverrideSchema.index({ tenantId: 1, projectId: 1, eventRef: 1 }, { unique: true });
GovernanceOverrideSchema.index({ tenantId: 1, projectId: 1, createdAt: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const GovernanceOverride =
  (mongoose.models.GovernanceOverride as mongoose.Model<IGovernanceOverride>) ||
  model<IGovernanceOverride>('GovernanceOverride', GovernanceOverrideSchema);
