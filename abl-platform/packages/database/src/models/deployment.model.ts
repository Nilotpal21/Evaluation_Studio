/**
 * Deployment Model
 *
 * Tracks deployments of agent configurations to environments.
 * Each deployment pins specific agent versions and routes traffic
 * via an endpoint slug.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDeployment {
  _id: string;
  projectId: string;
  tenantId: string;
  environment: string;
  label: string | null;
  description: string | null;
  agentVersionManifest: any;
  workflowVersionManifest: any;
  entryAgentName: string;
  compilationHash: string | null;
  modelOverrides: any;
  voiceConfig: any;
  status: string;
  endpointSlug: string;
  previousDeploymentId: string | null;
  promotedFromDeploymentId: string | null;
  createdBy: string;
  retiredAt: Date | null;
  settingsVersionId: string | null;
  variableSnapshotId: string | null;
  drainingStartedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const DeploymentSchema = new Schema<IDeployment>(
  {
    _id: { type: String, default: uuidv7 },
    projectId: { type: String, required: true },
    tenantId: { type: String, required: true },
    environment: {
      type: String,
      required: true,
      enum: ['dev', 'staging', 'production'],
    },
    label: { type: String, default: null },
    description: { type: String, default: null },
    agentVersionManifest: { type: Schema.Types.Mixed, default: {} },
    workflowVersionManifest: { type: Schema.Types.Mixed, default: {} },
    entryAgentName: { type: String, required: true },
    compilationHash: { type: String, default: null },
    modelOverrides: { type: Schema.Types.Mixed, default: null },
    voiceConfig: { type: Schema.Types.Mixed, default: null },
    status: {
      type: String,
      required: true,
      enum: ['active', 'draining', 'retired'],
      default: 'active',
    },
    endpointSlug: { type: String, required: true },
    previousDeploymentId: { type: String, default: null },
    promotedFromDeploymentId: { type: String, default: null },
    createdBy: { type: String, required: true },
    retiredAt: { type: Date, default: null },
    settingsVersionId: { type: String, default: null },
    variableSnapshotId: { type: String, default: null },
    drainingStartedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'deployments' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

DeploymentSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

DeploymentSchema.index({ endpointSlug: 1 }, { unique: true });
DeploymentSchema.index({ projectId: 1, tenantId: 1, status: 1, createdAt: -1 }); // findActiveDeployment + listDeployments
DeploymentSchema.index({ projectId: 1, environment: 1, createdAt: -1 });
DeploymentSchema.index({ projectId: 1, environment: 1, status: 1 });
DeploymentSchema.index({ tenantId: 1 });
DeploymentSchema.index({ status: 1 });
DeploymentSchema.index(
  { projectId: 1, environment: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const Deployment =
  (mongoose.models.Deployment as any) || model<IDeployment>('Deployment', DeploymentSchema);
