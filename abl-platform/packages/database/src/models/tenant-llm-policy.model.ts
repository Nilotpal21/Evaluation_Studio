/**
 * Tenant LLM Policy Model
 *
 * Defines tenant-level policies governing LLM usage.
 * Controls allowed providers, token budgets, rate limits,
 * and default model selections for a tenant.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITenantLLMPolicy {
  _id: string;
  tenantId: string;
  allowedProviders: string[];
  credentialPolicy: string;
  monthlyTokenBudget: number;
  dailyTokenBudget: number;
  defaultModel: string | null;
  defaultFastModel: string | null;
  defaultVoiceModel: string | null;
  maxRequestsPerMinute: number;
  allowProjectCredentials: boolean;
  platformDemoEnabled: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TenantLLMPolicySchema = new Schema<ITenantLLMPolicy>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    allowedProviders: { type: [String], default: [] },
    credentialPolicy: { type: String, required: true },
    monthlyTokenBudget: { type: Number, required: true },
    dailyTokenBudget: { type: Number, required: true },
    defaultModel: { type: String, default: null },
    defaultFastModel: { type: String, default: null },
    defaultVoiceModel: { type: String, default: null },
    maxRequestsPerMinute: { type: Number, required: true },
    allowProjectCredentials: { type: Boolean, required: true },
    platformDemoEnabled: { type: Boolean, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_llm_policies' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantLLMPolicySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

TenantLLMPolicySchema.index({ tenantId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const TenantLLMPolicy =
  (mongoose.models.TenantLLMPolicy as any) ||
  model<ITenantLLMPolicy>('TenantLLMPolicy', TenantLLMPolicySchema);
