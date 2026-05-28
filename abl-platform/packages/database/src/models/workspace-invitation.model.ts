/**
 * Workspace Invitation Model
 *
 * Tracks pending invitations for users to join a tenant workspace.
 * Invitations expire automatically via a TTL index on expiresAt.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IWorkspaceInvitation {
  _id: string;
  tenantId: string;
  email: string;
  role: string;
  invitedBy: string | null;
  token: string;
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const WorkspaceInvitationSchema = new Schema<IWorkspaceInvitation>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    email: { type: String, required: true },
    role: { type: String, required: true },
    invitedBy: { type: String, default: null },
    token: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'accepted', 'expired', 'revoked'],
      default: 'pending',
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'workspace_invitations' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

WorkspaceInvitationSchema.index({ token: 1 }, { unique: true });
WorkspaceInvitationSchema.index({ tenantId: 1, email: 1 }, { unique: true });
WorkspaceInvitationSchema.index({ email: 1 });
WorkspaceInvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Plugins ─────────────────────────────────────────────────────────────

WorkspaceInvitationSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const WorkspaceInvitation =
  (mongoose.models.WorkspaceInvitation as any) ||
  model<IWorkspaceInvitation>('WorkspaceInvitation', WorkspaceInvitationSchema);
