/**
 * Resource Permission Model
 *
 * Grants specific operations on a resource to a user within a tenant.
 * Supports optional expiration for time-limited access grants.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IResourcePermission {
  _id: string;
  tenantId: string;
  userId: string;
  resourceType: string;
  resourceId: string;
  operations: string[];
  grantedBy: string;
  expiresAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ResourcePermissionSchema = new Schema<IResourcePermission>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    operations: { type: [String], default: [] },
    grantedBy: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'resource_permissions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ResourcePermissionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ResourcePermissionSchema.index(
  { tenantId: 1, userId: 1, resourceType: 1, resourceId: 1 },
  { unique: true },
);
ResourcePermissionSchema.index({ tenantId: 1, userId: 1 });
ResourcePermissionSchema.index({ tenantId: 1, resourceType: 1, resourceId: 1 });
ResourcePermissionSchema.index({ userId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ResourcePermission =
  (mongoose.models.ResourcePermission as any) ||
  model<IResourcePermission>('ResourcePermission', ResourcePermissionSchema);
