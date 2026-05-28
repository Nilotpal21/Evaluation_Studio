/**
 * Tenant Member Model
 *
 * Maps users to tenants (workspaces) with a role assignment.
 * Supports both built-in roles and custom roles via customRoleId.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

const TENANT_MEMBER_STATUS_VALUES = ['active', 'suspended', 'locked', 'deactivated'] as const;

export type TenantMemberStatus = (typeof TENANT_MEMBER_STATUS_VALUES)[number];

export interface ITenantMember {
  _id: string;
  tenantId: string;
  userId: string;
  role: string;
  customRoleId: string | null;
  status: TenantMemberStatus;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TenantMemberSchema = new Schema<ITenantMember>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    role: { type: String, required: true },
    customRoleId: { type: String, default: null },
    status: {
      type: String,
      enum: TENANT_MEMBER_STATUS_VALUES,
      default: 'active',
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_members' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

TenantMemberSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
TenantMemberSchema.index({ userId: 1 });
TenantMemberSchema.index({ userId: 1, status: 1, createdAt: 1 });
TenantMemberSchema.index({ customRoleId: 1 });
TenantMemberSchema.index({ tenantId: 1, status: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantMemberSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const TenantMember =
  (mongoose.models.TenantMember as any) || model<ITenantMember>('TenantMember', TenantMemberSchema);
