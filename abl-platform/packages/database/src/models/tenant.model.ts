/**
 * Tenant Model
 *
 * Represents a workspace / tenant within the platform.
 * Each tenant belongs to an organization (optionally) and has
 * its own LLM policy, retention settings, and status lifecycle.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';
import type { TenantEvalRetentionConfig } from '../eval-retention.js';

// ─── Embedded Subdocument Interfaces ─────────────────────────────────────

interface ILlmPolicy {
  allowedProviders: string[];
  credentialPolicy: string;
  monthlyTokenBudget: number;
  dailyTokenBudget: number;
  defaultModel: string | null;
  defaultFastModel: string | null;
  maxRequestsPerMinute: number;
  allowProjectCredentials: boolean;
  platformDemoEnabled: boolean;
  updatedAt: Date;
}

/**
 * Tenant settings interface - extensible configuration
 * Add specific fields as they are discovered in usage
 */
export interface ITenantSettings {
  // Common settings fields (add more as discovered)
  defaultLLMProvider?: string;
  maxConcurrentSessions?: number;
  enableAuditLogging?: boolean;
  enableClickHouse?: boolean;
  allowedDomains?: string[];
  webhookUrl?: string | null;
  codeToolsEnabled?: boolean;
  evalRetention?: TenantEvalRetentionConfig;
  // Index signature for gradual migration and extensibility
  [key: string]: unknown;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITenant {
  _id: string;
  name: string;
  slug: string;
  organizationId: string | null;
  ownerId: string;
  retentionDays: number;
  settings: ITenantSettings | null; // ✅ TYPED (was: any)
  status: string;
  llmPolicy: ILlmPolicy | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const LlmPolicySchema = new Schema<ILlmPolicy>(
  {
    allowedProviders: { type: [String], default: [] },
    credentialPolicy: { type: String, required: true },
    monthlyTokenBudget: { type: Number, required: true },
    dailyTokenBudget: { type: Number, required: true },
    defaultModel: { type: String, default: null },
    defaultFastModel: { type: String, default: null },
    maxRequestsPerMinute: { type: Number, required: true },
    allowProjectCredentials: { type: Boolean, default: false },
    platformDemoEnabled: { type: Boolean, default: false },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const TenantSchema = new Schema<ITenant>(
  {
    _id: { type: String, default: uuidv7 },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    organizationId: { type: String, default: null },
    ownerId: { type: String, required: true },
    retentionDays: { type: Number, default: 7 },
    settings: { type: Schema.Types.Mixed, default: null },
    status: {
      type: String,
      required: true,
      enum: ['active', 'suspended', 'archived', 'transferring'],
      default: 'active',
    },
    llmPolicy: { type: LlmPolicySchema, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenants' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

TenantSchema.index({ slug: 1 }, { unique: true });
TenantSchema.index({ organizationId: 1 });
TenantSchema.index({ ownerId: 1 });
TenantSchema.index({ status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const Tenant =
  (mongoose.models.Tenant as mongoose.Model<ITenant>) || model<ITenant>('Tenant', TenantSchema);
