/**
 * Subscription Model
 *
 * Tracks billing subscriptions for organizations and tenants.
 * Includes plan tiers, entitlements, and hierarchical quota allocations
 * down to the project level.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface IProjectQuota {
  id: string;
  projectId: string;
  allocatedLimits: any;
  overageBehavior: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ITenantQuota {
  id: string;
  tenantId: string;
  allocatedLimits: any;
  burstAllowed: boolean;
  projectQuotas: IProjectQuota[];
  createdAt: Date;
  updatedAt: Date;
}

export type BillingMaterializationBasis = 'time_window' | 'completed_sessions';
export type BillingAddonMode = 'off' | 'per_call' | 'bucketed';

export interface IBillingInteractionThreshold {
  minUserMessages: number;
  minInteractiveTurns: number;
  minEngagedSeconds: number;
}

export interface IBillingAddonPolicy {
  mode: BillingAddonMode;
  bucketSize: number | null;
}

export interface IBillingMaterializationPolicy {
  basis: BillingMaterializationBasis;
  timeWindowMinutes: number | null;
  completedSessionsCount: number | null;
}

export interface IBillingUnitPolicy {
  intervalMinutes: number;
  excludedChannels: string[];
  excludedSessionTypes: string[];
  excludeProactiveWithoutUserInteraction: boolean;
  interactionThreshold: IBillingInteractionThreshold;
  addons: {
    llm: IBillingAddonPolicy;
    tool: IBillingAddonPolicy;
  };
  materialization: IBillingMaterializationPolicy;
}

export interface IBillingUnitPolicyOverrides {
  intervalMinutes?: number;
  excludedChannels?: string[];
  excludedSessionTypes?: string[];
  excludeProactiveWithoutUserInteraction?: boolean;
  interactionThreshold?: Partial<IBillingInteractionThreshold>;
  addons?: {
    llm?: Partial<IBillingAddonPolicy>;
    tool?: Partial<IBillingAddonPolicy>;
  };
  materialization?: Partial<IBillingMaterializationPolicy>;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ISubscription {
  _id: string;
  organizationId: string | null;
  tenantId: string;
  planTier: string;
  billingCycle: string;
  billingStartDate: Date;
  billingEndDate: Date | null;
  status: string;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
  externalBillingId: string | null;
  externalCustomerId: string | null;
  orgLimits: any;
  entitlements: string[];
  tenantQuotas: ITenantQuota[];
  billingUnitPolicyOverrides: IBillingUnitPolicyOverrides | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const ProjectQuotaSchema = new Schema<IProjectQuota>(
  {
    id: { type: String, required: true },
    projectId: { type: String, required: true },
    allocatedLimits: { type: Schema.Types.Mixed, default: null },
    overageBehavior: { type: String, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const TenantQuotaSchema = new Schema<ITenantQuota>(
  {
    id: { type: String, required: true },
    tenantId: { type: String, required: true },
    allocatedLimits: { type: Schema.Types.Mixed, default: null },
    burstAllowed: { type: Boolean, default: false },
    projectQuotas: { type: [ProjectQuotaSchema], default: [] },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const SubscriptionSchema = new Schema<ISubscription>(
  {
    _id: { type: String, default: uuidv7 },
    organizationId: { type: String, default: null },
    tenantId: { type: String, required: true },
    planTier: { type: String, required: true },
    billingCycle: { type: String, required: true },
    billingStartDate: { type: Date, required: true },
    billingEndDate: { type: Date, default: null },
    status: { type: String, required: true },
    trialEndsAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    externalBillingId: { type: String, default: null },
    externalCustomerId: { type: String, default: null },
    orgLimits: { type: Schema.Types.Mixed, default: null },
    entitlements: { type: [String], default: [] },
    tenantQuotas: { type: [TenantQuotaSchema], default: [] },
    billingUnitPolicyOverrides: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'subscriptions' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

SubscriptionSchema.index({ organizationId: 1 });
SubscriptionSchema.index({ tenantId: 1 });
SubscriptionSchema.index({ status: 1 });
SubscriptionSchema.index({ planTier: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

SubscriptionSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const Subscription =
  (mongoose.models.Subscription as any) || model<ISubscription>('Subscription', SubscriptionSchema);
