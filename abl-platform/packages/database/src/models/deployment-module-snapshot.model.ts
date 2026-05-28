/**
 * Deployment Module Snapshot Model
 *
 * Stores a gzip-compressed snapshot of all module artifacts resolved
 * at deployment build time. One snapshot per deployment, ensuring
 * runtime can reconstruct the exact module state without live lookups.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ─────────────────────────────────────────────────

export interface IDeploymentModuleSnapshot {
  _id: string;
  tenantId: string;
  projectId: string;
  deploymentId: string;
  snapshotHash: string;
  moduleReleaseIds: string[];
  compressedPayload: Buffer;
  createdBy: string;
  createdAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const DeploymentModuleSnapshotSchema = new Schema<IDeploymentModuleSnapshot>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    deploymentId: { type: String, required: true },
    snapshotHash: { type: String, required: true },
    moduleReleaseIds: { type: [String], default: [] },
    compressedPayload: { type: Buffer, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'deployment_module_snapshots' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

DeploymentModuleSnapshotSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

DeploymentModuleSnapshotSchema.index({ tenantId: 1, deploymentId: 1 }, { unique: true });
DeploymentModuleSnapshotSchema.index({ tenantId: 1, projectId: 1 });
DeploymentModuleSnapshotSchema.index({ moduleReleaseIds: 1 });

// ─── Model ──────────────────────────────────────────────────────────────

export const DeploymentModuleSnapshot =
  (mongoose.models.DeploymentModuleSnapshot as any) ||
  model<IDeploymentModuleSnapshot>('DeploymentModuleSnapshot', DeploymentModuleSnapshotSchema);
