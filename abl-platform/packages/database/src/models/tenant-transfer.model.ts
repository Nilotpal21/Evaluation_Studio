/**
 * Tenant Transfer Model
 *
 * Tracks the lifecycle of transferring a tenant from one
 * organization to another. Requires approval from both sides
 * and logs all actions performed during the transfer.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface ITransferLog {
  id: string;
  action: string;
  performedBy: string;
  details: any;
  createdAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITenantTransfer {
  _id: string;
  tenantId: string;
  sourceOrgId: string;
  targetOrgId: string;
  status: string;
  initiatedBy: string;
  sourceApprovedBy: string | null;
  sourceApprovedAt: Date | null;
  targetApprovedBy: string | null;
  targetApprovedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  assetInventory: any;
  transferOptions: any;
  executionStartedAt: Date | null;
  executionCompletedAt: Date | null;
  executionError: string | null;
  expiresAt: Date;
  logs: ITransferLog[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const TransferLogSchema = new Schema<ITransferLog>(
  {
    id: { type: String, required: true },
    action: { type: String, required: true },
    performedBy: { type: String, required: true },
    details: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const TenantTransferSchema = new Schema<ITenantTransfer>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    sourceOrgId: { type: String, required: true },
    targetOrgId: { type: String, required: true },
    status: { type: String, required: true },
    initiatedBy: { type: String, required: true },
    sourceApprovedBy: { type: String, default: null },
    sourceApprovedAt: { type: Date, default: null },
    targetApprovedBy: { type: String, default: null },
    targetApprovedAt: { type: Date, default: null },
    rejectedBy: { type: String, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    cancelledBy: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    assetInventory: { type: Schema.Types.Mixed, default: null },
    transferOptions: { type: Schema.Types.Mixed, default: null },
    executionStartedAt: { type: Date, default: null },
    executionCompletedAt: { type: Date, default: null },
    executionError: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    logs: { type: [TransferLogSchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_transfers' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantTransferSchema.plugin(auditTrailPlugin);
TenantTransferSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

TenantTransferSchema.index({ tenantId: 1 });
TenantTransferSchema.index({ sourceOrgId: 1 });
TenantTransferSchema.index({ targetOrgId: 1 });
TenantTransferSchema.index({ status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const TenantTransfer =
  (mongoose.models.TenantTransfer as any) ||
  model<ITenantTransfer>('TenantTransfer', TenantTransferSchema);
