/**
 * Agent Lock Model
 *
 * Advisory locks with TTL for optimistic concurrency control.
 * Prevents two developers from editing the same agent simultaneously.
 * Expired locks are auto-cleaned by MongoDB TTL index.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAgentLock {
  _id: string;
  tenantId: string;
  projectId: string;
  agentId: string;
  agentName: string;
  lockedBy: string;
  lockedAt: Date;
  expiresAt: Date;
  lockType: 'edit' | 'deploy';
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AgentLockSchema = new Schema<IAgentLock>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    agentId: { type: String, required: true },
    agentName: { type: String, required: true },
    lockedBy: { type: String, required: true },
    lockedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    lockType: { type: String, enum: ['edit', 'deploy'], required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'agent_locks' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AgentLockSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

AgentLockSchema.index({ tenantId: 1, projectId: 1, agentId: 1, lockType: 1 }, { unique: true });
AgentLockSchema.index({ tenantId: 1, projectId: 1, agentId: 1 });
AgentLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────

export const AgentLock =
  (mongoose.models.AgentLock as any) || model<IAgentLock>('AgentLock', AgentLockSchema);
