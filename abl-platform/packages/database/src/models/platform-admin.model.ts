/**
 * Platform Admin Model
 *
 * Stores DB-managed platform administrators. SUPER_ADMIN_USER_IDS remains the
 * bootstrap path; this collection lets existing platform admins grant access
 * without a deployment.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

export type PlatformAdminStatus = 'active' | 'revoked';

export interface IPlatformAdmin {
  _id: string;
  email: string;
  userId: string | null;
  status: PlatformAdminStatus;
  addedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformAdminSchema = new Schema<IPlatformAdmin>(
  {
    _id: { type: String, default: uuidv7 },
    email: { type: String, required: true, lowercase: true, trim: true },
    userId: { type: String, default: null },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', required: true },
    addedByUserId: { type: String, required: true },
  },
  { timestamps: true, collection: 'platform_admins' },
);

PlatformAdminSchema.plugin(auditTrailPlugin);

PlatformAdminSchema.index({ email: 1 }, { unique: true });
PlatformAdminSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'string' } } },
);
PlatformAdminSchema.index({ status: 1, email: 1 });

export const PlatformAdmin =
  (mongoose.models.PlatformAdmin as mongoose.Model<IPlatformAdmin>) ||
  model<IPlatformAdmin>('PlatformAdmin', PlatformAdminSchema);
