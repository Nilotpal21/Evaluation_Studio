/**
 * Resource Group Model
 *
 * Groups related resources (agents, knowledge bases, etc.) for organizational
 * and access-control purposes. Each group is scoped to a tenant and contains
 * a list of member resources.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface IResourceGroupMember {
  id: string;
  resourceType: string;
  resourceId: string;
  addedBy: string;
  createdAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IResourceGroup {
  _id: string;
  tenantId: string;
  name: string;
  description: string | null;
  icon: string | null;
  metadata: any;
  members: IResourceGroupMember[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const ResourceGroupMemberSchema = new Schema<IResourceGroupMember>(
  {
    id: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    addedBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const ResourceGroupSchema = new Schema<IResourceGroup>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    icon: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    members: { type: [ResourceGroupMemberSchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'resource_groups' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ResourceGroupSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ResourceGroupSchema.index({ tenantId: 1, name: 1 }, { unique: true });
ResourceGroupSchema.index({ tenantId: 1 });
ResourceGroupSchema.index({ 'members.resourceType': 1, 'members.resourceId': 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ResourceGroup =
  (mongoose.models.ResourceGroup as any) ||
  model<IResourceGroup>('ResourceGroup', ResourceGroupSchema);
