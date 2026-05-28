/**
 * Suspension Model
 *
 * Persists SuspendedExecution records for async operations (remote A2A handoffs,
 * async tools, fan-out branches, human approvals). Survives pod restarts and
 * enables cross-pod resumption via callback-to-suspension lookup.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

const SUSPENSION_STATUSES = [
  'suspended',
  'resuming',
  'completed',
  'failed',
  'expired',
  'cancelled',
] as const;

// ─── Document Interface ──────────────────────────────────────────────────

export interface ISuspension {
  _id: string;
  tenantId: string;
  executionId: string;
  sessionId: string;
  projectId: string | null;
  reason: any;
  continuation: any;
  channelBinding: any;
  callbackId: string;
  callbackSecret: string;
  barrierId: string | null;
  status: string;
  suspendedAt: Date;
  expiresAt: Date;
  resumedAt: Date | null;
  completedAt: Date | null;
  resumeAttempts: number;
  error: any;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SuspensionSchema = new Schema<ISuspension>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    executionId: { type: String, required: true },
    sessionId: { type: String, required: true },
    projectId: { type: String, default: null },
    reason: { type: Schema.Types.Mixed, required: true },
    continuation: { type: Schema.Types.Mixed, required: true },
    channelBinding: { type: Schema.Types.Mixed, required: true },
    callbackId: { type: String, required: true },
    callbackSecret: { type: String, required: true },
    barrierId: { type: String, default: null },
    status: { type: String, enum: SUSPENSION_STATUSES, default: 'suspended', required: true },
    suspendedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    resumedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    resumeAttempts: { type: Number, default: 0 },
    error: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'suspensions' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SuspensionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Callback lookup (unique — each callback maps to exactly one suspension)
SuspensionSchema.index({ callbackId: 1 }, { unique: true });

// Timeout worker: find expired suspensions by status + expiresAt
SuspensionSchema.index({ status: 1, expiresAt: 1 });

// Session cleanup: find all suspensions for a session
SuspensionSchema.index({ sessionId: 1 });

// Fan-out barrier: find all branches for a barrier
SuspensionSchema.index(
  { barrierId: 1 },
  { partialFilterExpression: { barrierId: { $type: 'string' } } },
);

// Tenant-scoped listing
SuspensionSchema.index({ tenantId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const Suspension =
  (mongoose.models.Suspension as any) || model<ISuspension>('Suspension', SuspensionSchema);
