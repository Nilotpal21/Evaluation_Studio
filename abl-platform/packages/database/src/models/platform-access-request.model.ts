/**
 * Platform Access Request Model
 *
 * Stores blocked sign-in/sign-up access requests so requesters can be
 * notified when a platform admin later allowlists their email domain.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

export type PlatformAccessRequestStatus = 'pending' | 'notified' | 'dismissed';

export interface IPlatformAccessRequest {
  _id: string;
  email: string;
  domain: string;
  name: string | null;
  message: string | null;
  status: PlatformAccessRequestStatus;
  requestCount: number;
  lastRequestedAt: Date;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PlatformAccessRequestSchema = new Schema<IPlatformAccessRequest>(
  {
    _id: { type: String, default: uuidv7 },
    email: { type: String, required: true, lowercase: true, trim: true },
    domain: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: null, trim: true },
    message: { type: String, default: null, trim: true },
    status: {
      type: String,
      enum: ['pending', 'notified', 'dismissed'],
      default: 'pending',
      required: true,
    },
    requestCount: { type: Number, default: 1, min: 1 },
    lastRequestedAt: { type: Date, default: Date.now, required: true },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'platform_access_requests' },
);

PlatformAccessRequestSchema.plugin(auditTrailPlugin);

PlatformAccessRequestSchema.index({ email: 1 }, { unique: true });
PlatformAccessRequestSchema.index({ domain: 1, status: 1, lastRequestedAt: -1 });
// Expire notified/dismissed records 90 days after notification to limit PII retention.
// Pending records (notifiedAt: null) are excluded by the sparse partial expression.
PlatformAccessRequestSchema.index(
  { notifiedAt: 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60,
    partialFilterExpression: { notifiedAt: { $type: 'date' } },
  },
);

export const PlatformAccessRequest =
  (mongoose.models.PlatformAccessRequest as mongoose.Model<IPlatformAccessRequest>) ||
  model<IPlatformAccessRequest>('PlatformAccessRequest', PlatformAccessRequestSchema);
