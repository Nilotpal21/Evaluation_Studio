/**
 * Variable Namespace Membership Model (Join Collection)
 *
 * Many-to-many join between variables and namespaces.
 * Links environment variables and config variables to one or more namespaces.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IVariableNamespaceMembership {
  _id: string;
  tenantId: string;
  projectId: string;
  namespaceId: string;
  variableId: string;
  variableType: 'env' | 'config';
  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const VariableNamespaceMembershipSchema = new Schema<IVariableNamespaceMembership>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    namespaceId: { type: String, required: true },
    variableId: { type: String, required: true },
    variableType: {
      type: String,
      required: true,
      enum: ['env', 'config'],
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'variable_namespace_memberships',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

VariableNamespaceMembershipSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

VariableNamespaceMembershipSchema.index(
  { namespaceId: 1, variableId: 1, variableType: 1 },
  { unique: true },
);
VariableNamespaceMembershipSchema.index({ variableId: 1, variableType: 1 });
VariableNamespaceMembershipSchema.index({ tenantId: 1, projectId: 1, namespaceId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const VariableNamespaceMembership =
  (mongoose.models.VariableNamespaceMembership as any) ||
  model<IVariableNamespaceMembership>(
    'VariableNamespaceMembership',
    VariableNamespaceMembershipSchema,
  );
