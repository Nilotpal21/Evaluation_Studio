/**
 * Platform Allowed Email Model
 *
 * Stores individually allowlisted email addresses (e.g. free-provider emails
 * like gmail.com) that are permitted to sign in/sign up.  Mirrors the
 * PlatformAllowedDomain model but operates on exact email addresses rather
 * than domain suffixes.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

export type PlatformAllowedEmailStatus = 'active' | 'revoked';

export interface IPlatformAllowedEmail {
  _id: string;
  email: string;
  status: PlatformAllowedEmailStatus;
  addedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformAllowedEmailSchema = new Schema<IPlatformAllowedEmail>(
  {
    _id: { type: String, default: uuidv7 },
    email: { type: String, required: true, lowercase: true, trim: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', required: true },
    addedByUserId: { type: String, required: true },
  },
  { timestamps: true, collection: 'platform_allowed_emails' },
);

PlatformAllowedEmailSchema.plugin(auditTrailPlugin);

PlatformAllowedEmailSchema.index({ email: 1 }, { unique: true });
PlatformAllowedEmailSchema.index({ status: 1, email: 1 });

export const PlatformAllowedEmail =
  (mongoose.models.PlatformAllowedEmail as mongoose.Model<IPlatformAllowedEmail>) ||
  model<IPlatformAllowedEmail>('PlatformAllowedEmail', PlatformAllowedEmailSchema);
