/**
 * Credit Ledger Model
 *
 * Tracks credit consumption and top-ups for a deal within a billing period.
 * Each ledger entry records individual credit transactions including usage,
 * top-ups, adjustments, and rollovers.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface ICreditEntry {
  timestamp: Date;
  feature: string;
  units: number;
  credits: number;
  source: 'usage' | 'topup' | 'adjustment' | 'rollover';
  projectId?: string;
  sessionId?: string;
  description?: string;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ICreditLedger {
  _id: string;
  dealId: string;
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
  totalAllocated: number;
  totalConsumed: number;
  featureUsage: Record<string, number>;
  sharedPoolConsumed: number;
  entries: ICreditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const CreditEntrySchema = new Schema<ICreditEntry>(
  {
    timestamp: { type: Date, required: true },
    feature: { type: String, required: true },
    units: { type: Number, required: true },
    credits: { type: Number, required: true },
    source: {
      type: String,
      enum: ['usage', 'topup', 'adjustment', 'rollover'],
      required: true,
    },
    projectId: { type: String, default: undefined },
    sessionId: { type: String, default: undefined },
    description: { type: String, default: undefined },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const CreditLedgerSchema = new Schema<ICreditLedger>(
  {
    _id: { type: String, default: uuidv7 },
    dealId: { type: String, required: true },
    organizationId: { type: String, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    totalAllocated: { type: Number, default: 0 },
    totalConsumed: { type: Number, default: 0 },
    featureUsage: { type: Schema.Types.Mixed, default: {} },
    sharedPoolConsumed: { type: Number, default: 0 },
    entries: { type: [CreditEntrySchema], default: [] },
  },
  { timestamps: true, collection: 'credit_ledgers' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

CreditLedgerSchema.index({ dealId: 1, periodStart: 1 }, { unique: true });
CreditLedgerSchema.index({ organizationId: 1, periodStart: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const CreditLedger =
  (mongoose.models.CreditLedger as any) || model<ICreditLedger>('CreditLedger', CreditLedgerSchema);
