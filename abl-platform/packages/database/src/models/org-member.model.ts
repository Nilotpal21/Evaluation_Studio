/**
 * Organization Member Model
 *
 * Maps users to organizations with a specific role.
 * Roles: ORG_OWNER, ORG_ADMIN, ORG_MEMBER, ORG_BILLING.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IOrgMember {
  _id: string;
  organizationId: string;
  userId: string;
  role: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const OrgMemberSchema = new Schema<IOrgMember>(
  {
    _id: { type: String, default: uuidv7 },
    organizationId: { type: String, required: true },
    userId: { type: String, required: true },
    role: {
      type: String,
      required: true,
      enum: ['ORG_OWNER', 'ORG_ADMIN', 'ORG_MEMBER', 'ORG_BILLING'],
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'org_members' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

OrgMemberSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
OrgMemberSchema.index({ userId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const OrgMember =
  (mongoose.models.OrgMember as any) || model<IOrgMember>('OrgMember', OrgMemberSchema);
