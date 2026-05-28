/**
 * Deletion Request Model
 *
 * Tracks data deletion requests for compliance (e.g., GDPR right to erasure).
 * Manages request lifecycle from pending through completion with SLA tracking
 * and retry support.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDeletionRequest {
  _id: string;
  tenantId: string;
  requestedBy: string;
  subjectId: string;
  scope: string;
  status: string;
  slaDeadline: Date;
  escalatedAt: Date | null;
  retryCount: number;
  completedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const DeletionRequestSchema = new Schema<IDeletionRequest>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    requestedBy: { type: String, required: true },
    subjectId: { type: String, required: true },
    scope: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'in_progress', 'completed', 'failed'],
      default: 'pending',
    },
    slaDeadline: { type: Date, required: true },
    escalatedAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'deletion_requests' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

DeletionRequestSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

DeletionRequestSchema.index({ tenantId: 1 });
DeletionRequestSchema.index({ status: 1 });
DeletionRequestSchema.index({ subjectId: 1 });
DeletionRequestSchema.index({ slaDeadline: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const DeletionRequest =
  (mongoose.models.DeletionRequest as any) ||
  model<IDeletionRequest>('DeletionRequest', DeletionRequestSchema);
