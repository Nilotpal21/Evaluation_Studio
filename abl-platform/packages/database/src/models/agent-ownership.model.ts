/**
 * Agent Ownership Model
 *
 * Tracks per-agent ownership and fine-grained permissions within a project.
 * Supports individual user ownership, team ownership, and explicit permission grants.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IPermissionGrant {
  principalType: 'user' | 'team';
  principalId: string;
  operations: Array<'view' | 'edit' | 'deploy' | 'delete'>;
  grantedBy: string;
  expiresAt: Date | null;
}

export interface IAgentOwnership {
  _id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  ownerId: string | null;
  ownerTeamId: string | null;
  permissions: IPermissionGrant[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PermissionGrantSchema = new Schema<IPermissionGrant>(
  {
    principalType: { type: String, enum: ['user', 'team'], required: true },
    principalId: { type: String, required: true },
    operations: [{ type: String, enum: ['view', 'edit', 'deploy', 'delete'] }],
    grantedBy: { type: String, required: true },
    expiresAt: { type: Date, default: null },
  },
  { _id: false },
);

const AgentOwnershipSchema = new Schema<IAgentOwnership>(
  {
    _id: { type: String, default: uuidv7 },
    projectId: { type: String, required: true },
    agentId: { type: String, required: true },
    agentName: { type: String, required: true },
    ownerId: { type: String, default: null },
    ownerTeamId: { type: String, default: null },
    permissions: { type: [PermissionGrantSchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'agent_ownerships' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

AgentOwnershipSchema.index({ projectId: 1, agentId: 1 }, { unique: true });
AgentOwnershipSchema.index({ projectId: 1, ownerId: 1 });
AgentOwnershipSchema.index({ projectId: 1, ownerTeamId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const AgentOwnership =
  (mongoose.models.AgentOwnership as any) ||
  model<IAgentOwnership>('AgentOwnership', AgentOwnershipSchema);
