/**
 * Deployment Variable Snapshot Model
 *
 * Immutable point-in-time capture of all variable values at deployment creation.
 * One snapshot per deployment. Runtime reads frozen values from here.
 *
 * IMPORTANT: Does NOT use encryptionPlugin. Stores raw ciphertext copied from
 * EnvironmentVariable records. Decryption happens at runtime via decryptForTenant.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Sub-Document Interfaces ─────────────────────────────────────────────

export interface ISnapshotEnvVar {
  key: string;
  encryptedValue: string; // raw AES-256-GCM ciphertext, NOT decrypted
  isSecret: boolean;
  description: string | null;
  sourceId: string;
  namespaces: string[];
}

export interface ISnapshotConfigVar {
  key: string;
  value: string; // plaintext (config vars are never encrypted)
  description: string | null;
  sourceId: string;
  namespaces: string[];
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDeploymentVariableSnapshot {
  _id: string;
  tenantId: string;
  projectId: string;
  deploymentId: string;
  environment: string;
  snapshotVersion: number;
  snapshotHash: string;
  envVars: ISnapshotEnvVar[];
  configVars: ISnapshotConfigVar[];
  createdBy: string;
  createdAt: Date;
}

// ─── Sub-Document Schemas ────────────────────────────────────────────────

const SnapshotEnvVarSchema = new Schema<ISnapshotEnvVar>(
  {
    key: { type: String, required: true },
    encryptedValue: { type: String, required: true },
    isSecret: { type: Boolean, required: true },
    description: { type: String, default: null },
    sourceId: { type: String, required: true },
    namespaces: { type: [String], default: [] },
  },
  { _id: false },
);

const SnapshotConfigVarSchema = new Schema<ISnapshotConfigVar>(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    description: { type: String, default: null },
    sourceId: { type: String, required: true },
    namespaces: { type: [String], default: [] },
  },
  { _id: false },
);

// ─── Main Schema ─────────────────────────────────────────────────────────

const DeploymentVariableSnapshotSchema = new Schema<IDeploymentVariableSnapshot>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    deploymentId: { type: String, required: true },
    environment: { type: String, required: true, enum: ['dev', 'staging', 'production'] },
    snapshotVersion: { type: Number, required: true, default: 1 },
    snapshotHash: { type: String, required: true },
    envVars: { type: [SnapshotEnvVarSchema], default: [] },
    configVars: { type: [SnapshotConfigVarSchema], default: [] },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'deployment_variable_snapshots',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

DeploymentVariableSnapshotSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

DeploymentVariableSnapshotSchema.index({ deploymentId: 1 }, { unique: true });
DeploymentVariableSnapshotSchema.index({ tenantId: 1, projectId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const DeploymentVariableSnapshot =
  (mongoose.models.DeploymentVariableSnapshot as any) ||
  model<IDeploymentVariableSnapshot>(
    'DeploymentVariableSnapshot',
    DeploymentVariableSnapshotSchema,
  );
