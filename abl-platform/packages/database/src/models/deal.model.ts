/**
 * Deal Model
 *
 * Tracks commercial deals for organizations including phased resource limits,
 * credit allotments, and overage policies. Supports HubSpot integration
 * via optional hubspotDealId.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface ILimitSet {
  maxConcurrentSessions: number;
  maxTokensPerMinute: number;
  maxRequestsPerMinute: number;
  maxStorageGB: number;
}

interface IDealPhase {
  name: string;
  startDate: Date;
  endDate: Date;
  environments: {
    dev: ILimitSet;
    staging: ILimitSet;
    production: ILimitSet;
  };
}

interface ICreditAllotment {
  totalCredits: number;
  sharedPoolCredits: number;
  featureCredits: Record<string, number>;
  rolloverPolicy: 'none' | 'partial' | 'full';
  rolloverPercentage?: number;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDeal {
  _id: string;
  organizationId: string;
  hubspotDealId?: string;
  name: string;
  status: 'active' | 'paused' | 'expired' | 'canceled';
  scope: 'organization' | 'project';
  projectId?: string;
  aggregationMode: 'additive' | 'max_wins' | 'dedicated';
  phases: IDealPhase[];
  overagePolicy: 'hard_stop' | 'soft_cap' | 'auto_upgrade';
  overageAlertThresholds: number[];
  creditAllotment: ICreditAllotment;
  features: string[];
  renewalDate?: Date;
  contractEndDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const LimitSetSchema = new Schema<ILimitSet>(
  {
    maxConcurrentSessions: { type: Number, required: true },
    maxTokensPerMinute: { type: Number, required: true },
    maxRequestsPerMinute: { type: Number, required: true },
    maxStorageGB: { type: Number, required: true },
  },
  { _id: false },
);

const DealPhaseSchema = new Schema<IDealPhase>(
  {
    name: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    environments: {
      type: new Schema(
        {
          dev: { type: LimitSetSchema, required: true },
          staging: { type: LimitSetSchema, required: true },
          production: { type: LimitSetSchema, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
  },
  { _id: false },
);

const CreditAllotmentSchema = new Schema<ICreditAllotment>(
  {
    totalCredits: { type: Number, required: true },
    sharedPoolCredits: { type: Number, required: true },
    featureCredits: { type: Schema.Types.Mixed, default: {} },
    rolloverPolicy: {
      type: String,
      enum: ['none', 'partial', 'full'],
      required: true,
    },
    rolloverPercentage: { type: Number, default: undefined },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const DealSchema = new Schema<IDeal>(
  {
    _id: { type: String, default: uuidv7 },
    organizationId: { type: String, required: true },
    hubspotDealId: { type: String, default: undefined },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ['active', 'paused', 'expired', 'canceled'],
      required: true,
    },
    scope: {
      type: String,
      enum: ['organization', 'project'],
      required: true,
    },
    projectId: { type: String, default: undefined },
    aggregationMode: {
      type: String,
      enum: ['additive', 'max_wins', 'dedicated'],
      required: true,
    },
    phases: { type: [DealPhaseSchema], default: [] },
    overagePolicy: {
      type: String,
      enum: ['hard_stop', 'soft_cap', 'auto_upgrade'],
      required: true,
    },
    overageAlertThresholds: { type: [Number], default: [] },
    creditAllotment: { type: CreditAllotmentSchema, required: true },
    features: { type: [String], default: [] },
    renewalDate: { type: Date, default: undefined },
    contractEndDate: { type: Date, default: undefined },
  },
  { timestamps: true, collection: 'deals' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

DealSchema.index({ organizationId: 1, status: 1 });
DealSchema.index({ hubspotDealId: 1 }, { sparse: true, unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const Deal = (mongoose.models.Deal as any) || model<IDeal>('Deal', DealSchema);
