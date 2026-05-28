/**
 * Role Definition Model
 *
 * Defines RBAC roles within a tenant. Roles hold a set of permission
 * strings and can optionally inherit from a parent role.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IRoleDefinition {
  _id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  parentRoleId: string | null;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const RoleDefinitionSchema = new Schema<IRoleDefinition>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    isSystem: { type: Boolean, default: false },
    permissions: { type: [String], default: [] },
    parentRoleId: { type: String, default: null },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'role_definitions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

RoleDefinitionSchema.plugin(tenantIsolationPlugin);
RoleDefinitionSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

RoleDefinitionSchema.index({ tenantId: 1, name: 1 }, { unique: true });
RoleDefinitionSchema.index({ tenantId: 1 });
RoleDefinitionSchema.index({ tenantId: 1, isSystem: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const RoleDefinition =
  (mongoose.models.RoleDefinition as any) ||
  model<IRoleDefinition>('RoleDefinition', RoleDefinitionSchema);
