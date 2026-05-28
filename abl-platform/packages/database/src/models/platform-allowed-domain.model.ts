/**
 * Platform Allowed Domain Model
 *
 * Stores additional sign-in/sign-up email domains. Built-in domains are
 * provided by the auth-policy helper and are not persisted here.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

export type PlatformAllowedDomainStatus = 'active' | 'revoked';

export interface IPlatformAllowedDomain {
  _id: string;
  domain: string;
  status: PlatformAllowedDomainStatus;
  addedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformAllowedDomainSchema = new Schema<IPlatformAllowedDomain>(
  {
    _id: { type: String, default: uuidv7 },
    domain: { type: String, required: true, lowercase: true, trim: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', required: true },
    addedByUserId: { type: String, required: true },
  },
  { timestamps: true, collection: 'platform_allowed_domains' },
);

PlatformAllowedDomainSchema.plugin(auditTrailPlugin);

PlatformAllowedDomainSchema.index({ domain: 1 }, { unique: true });
PlatformAllowedDomainSchema.index({ status: 1, domain: 1 });

export const PlatformAllowedDomain =
  (mongoose.models.PlatformAllowedDomain as mongoose.Model<IPlatformAllowedDomain>) ||
  model<IPlatformAllowedDomain>('PlatformAllowedDomain', PlatformAllowedDomainSchema);
