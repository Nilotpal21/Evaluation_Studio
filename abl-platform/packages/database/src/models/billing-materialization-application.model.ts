/**
 * BillingMaterializationApplication Model
 *
 * Records the operator-controlled application boundary for a completed
 * billing materialization batch. This is intentionally separate from
 * legacy credit-ledger and billing-line-item writes so the platform can
 * adopt billing-unit materialization without guessing a priced projection.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { BillingMaterializationBasis } from './subscription.model.js';
import type {
  IBillingMaterializationScope,
  IBillingMaterializationSummary,
} from './billing-materialization-batch.model.js';

export type BillingMaterializationApplicationStatus = 'recorded' | 'projected';
export type BillingMaterializationApplicationTriggerSource = 'manual' | 'scheduled';
export type BillingMaterializationApplicationDealMatchType =
  | 'project_exact'
  | 'organization_scope'
  | 'organization_fallback';
export type BillingMaterializationProjectionStatus = 'deferred' | 'applied';

export interface IBillingMaterializationApplicationDealResolution {
  organizationId: string;
  dealId: string;
  dealScope: 'organization' | 'project';
  matchType: BillingMaterializationApplicationDealMatchType;
}

export interface IBillingMaterializationApplicationAccountingPeriod {
  billingCycle: string;
  billingStartDate: Date;
  referenceAt: Date;
  periodStart: Date;
  periodEnd: Date;
  periodLabel: string;
}

export interface IBillingMaterializationApplicationProjectionTarget {
  status: BillingMaterializationProjectionStatus;
  reason: string | null;
  targetId: string | null;
  targetIds: string[];
  appliedAt: Date | null;
}

export interface IBillingMaterializationApplicationProjection {
  usageReports: IBillingMaterializationApplicationProjectionTarget;
  creditLedger: IBillingMaterializationApplicationProjectionTarget;
  billingLineItems: IBillingMaterializationApplicationProjectionTarget;
}

export interface IBillingMaterializationApplication {
  _id: string;
  tenantId: string;
  batchId: string;
  projectId: string | null;
  subscriptionId: string;
  status: BillingMaterializationApplicationStatus;
  triggerSource: BillingMaterializationApplicationTriggerSource;
  triggeredBy: string;
  appliedBy: string;
  materializationBasis: BillingMaterializationBasis;
  materializationScope: IBillingMaterializationScope;
  summarySnapshot: IBillingMaterializationSummary;
  warnings: string[];
  dealResolution: IBillingMaterializationApplicationDealResolution;
  accountingPeriod: IBillingMaterializationApplicationAccountingPeriod;
  projection: IBillingMaterializationApplicationProjection;
  appliedAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectionTargetSchema = new Schema<IBillingMaterializationApplicationProjectionTarget>(
  {
    status: {
      type: String,
      enum: ['deferred', 'applied'],
      required: true,
    },
    reason: { type: String, default: null },
    targetId: { type: String, default: null },
    targetIds: { type: [String], default: [] },
    appliedAt: { type: Date, default: null },
  },
  { _id: false },
);

const BillingMaterializationApplicationSchema = new Schema<IBillingMaterializationApplication>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    batchId: { type: String, required: true },
    projectId: { type: String, default: null },
    subscriptionId: { type: String, required: true },
    status: {
      type: String,
      enum: ['recorded', 'projected'],
      default: 'recorded',
    },
    triggerSource: {
      type: String,
      enum: ['manual', 'scheduled'],
      required: true,
    },
    triggeredBy: { type: String, required: true },
    appliedBy: { type: String, required: true },
    materializationBasis: {
      type: String,
      enum: ['time_window', 'completed_sessions'],
      required: true,
    },
    materializationScope: { type: Schema.Types.Mixed, required: true },
    summarySnapshot: { type: Schema.Types.Mixed, required: true },
    warnings: { type: [String], default: [] },
    dealResolution: {
      type: {
        organizationId: { type: String, required: true },
        dealId: { type: String, required: true },
        dealScope: {
          type: String,
          enum: ['organization', 'project'],
          required: true,
        },
        matchType: {
          type: String,
          enum: ['project_exact', 'organization_scope', 'organization_fallback'],
          required: true,
        },
      },
      required: true,
    },
    accountingPeriod: {
      type: {
        billingCycle: { type: String, required: true },
        billingStartDate: { type: Date, required: true },
        referenceAt: { type: Date, required: true },
        periodStart: { type: Date, required: true },
        periodEnd: { type: Date, required: true },
        periodLabel: { type: String, required: true },
      },
      required: true,
    },
    projection: {
      type: {
        usageReports: {
          type: ProjectionTargetSchema,
          required: true,
        },
        creditLedger: {
          type: ProjectionTargetSchema,
          required: true,
        },
        billingLineItems: {
          type: ProjectionTargetSchema,
          required: true,
        },
      },
      required: true,
    },
    appliedAt: { type: Date, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'billing_materialization_applications' },
);

BillingMaterializationApplicationSchema.plugin(tenantIsolationPlugin);

BillingMaterializationApplicationSchema.index(
  { tenantId: 1, batchId: 1 },
  { unique: true, name: 'uniq_billing_materialization_application_batch' },
);
BillingMaterializationApplicationSchema.index({ tenantId: 1, createdAt: -1 });
BillingMaterializationApplicationSchema.index({ subscriptionId: 1, createdAt: -1 });
BillingMaterializationApplicationSchema.index(
  { 'dealResolution.dealId': 1, 'accountingPeriod.periodStart': -1 },
  { name: 'billing_materialization_application_deal_period' },
);

export const BillingMaterializationApplication =
  (mongoose.models
    .BillingMaterializationApplication as mongoose.Model<IBillingMaterializationApplication>) ||
  model<IBillingMaterializationApplication>(
    'BillingMaterializationApplication',
    BillingMaterializationApplicationSchema,
  );
