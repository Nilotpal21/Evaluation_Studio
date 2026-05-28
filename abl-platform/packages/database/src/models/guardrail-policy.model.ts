/**
 * Guardrail Policy Model
 *
 * Represents a guardrail policy scoped to a tenant, project, or agent.
 * Policies define provider overrides, evaluation rules, constitution principles,
 * streaming settings, caching, and budget controls for guardrail enforcement.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Embedded Interfaces ─────────────────────────────────────────────────

export interface IGuardrailPolicyScope {
  type: 'tenant' | 'project' | 'agent';
  projectId?: string;
  agentDefId?: string;
}

export interface IGuardrailProviderOverride {
  providerName: string;
  endpoint?: string;
  apiKeyCredentialId?: string;
  /** Auth profile ID for credential resolution. Reserved — not yet wired to a runtime consumer. */
  authProfileId?: string;
  defaultCategory?: string;
  defaultThreshold?: number;
  circuitBreaker?: Record<string, unknown>;
  retry?: Record<string, unknown>;
  costPerEvalUsd?: number;
  isActive?: boolean;
}

export interface IGuardrailRule {
  guardrailName: string;
  override: 'disable' | 'threshold' | 'action' | 'severity_actions' | 'define';
  threshold?: number;
  action?: Record<string, unknown>;
  severityActions?: Record<string, unknown>;
  kind?: 'input' | 'output' | 'tool_input' | 'tool_output' | 'handoff';
  tier?: 'local' | 'model' | 'llm';
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  description?: string;
  priority?: number;
  message?: string;
  // ─── Sensitive Data Block additions (ABLP-723) ───────────────────────
  /** Restricts builtin-pii recognizer set; absent ⇒ all enabled entities. */
  entities?: string[];
  /** Per-rule enable flag; absent ⇒ enabled (resolver/gate uses `enabled !== false`). */
  enabled?: boolean;
  /** Identifies the preset that produced this rule (e.g. `sensitive_data_block`). */
  presetKey?: string;
  /** User-visible block message (top-level, distinct from legacy `action.message`). */
  actionMessage?: string;
}

export interface IConstitutionPrinciple {
  principle: string;
  weight: number;
  examples?: string[];
}

export interface IGuardrailStreamingSettings {
  enabled: boolean;
  defaultInterval: 'token' | 'sentence' | 'chunk_size';
  chunkSize: number;
  maxLatencyMs: number;
  earlyTermination: boolean;
}

export interface IGuardrailSettings {
  failMode: 'open' | 'closed';
  timeouts: { local: number; model: number; llm: number };
  webhookUrl?: string;
  encryptedWebhookSecret?: string;
  streaming: IGuardrailStreamingSettings;
}

export interface IGuardrailCaching {
  enabled: boolean;
  exactMatch: boolean;
  semanticMatch: boolean;
  semanticThreshold: number;
  defaultTtlSeconds: number;
}

export interface IGuardrailBudget {
  monthlyLimitUsd: number;
  currentSpendUsd: number;
  overspendAction: 'downgrade' | 'disable_model_checks' | 'alert_only';
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IGuardrailPolicy {
  _id: string;
  tenantId: string;
  name: string;
  description?: string;
  scope: IGuardrailPolicyScope;
  providerOverrides: IGuardrailProviderOverride[];
  rules: IGuardrailRule[];
  constitution: IConstitutionPrinciple[];
  settings: IGuardrailSettings;
  caching: IGuardrailCaching;
  budget: IGuardrailBudget;
  version: number;
  previousVersionId?: string;
  changelog?: string;
  status: 'draft' | 'active' | 'archived';
  isActive: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const GuardrailPolicyScopeSchema = new Schema<IGuardrailPolicyScope>(
  {
    type: { type: String, required: true, enum: ['tenant', 'project', 'agent'], default: 'tenant' },
    projectId: { type: String, default: undefined },
    agentDefId: { type: String, default: undefined },
  },
  { _id: false },
);

const GuardrailProviderOverrideSchema = new Schema<IGuardrailProviderOverride>(
  {
    providerName: { type: String, required: true },
    endpoint: { type: String, default: undefined },
    apiKeyCredentialId: { type: String, default: undefined },
    authProfileId: { type: String, default: null },
    defaultCategory: { type: String, default: undefined },
    defaultThreshold: { type: Number, default: undefined },
    circuitBreaker: { type: Schema.Types.Mixed, default: undefined },
    retry: { type: Schema.Types.Mixed, default: undefined },
    costPerEvalUsd: { type: Number, default: undefined },
    isActive: { type: Boolean, default: undefined },
  },
  { _id: false },
);

const GuardrailRuleSchema = new Schema<IGuardrailRule>(
  {
    guardrailName: { type: String, required: true },
    override: {
      type: String,
      required: true,
      enum: ['disable', 'threshold', 'action', 'severity_actions', 'define'],
    },
    threshold: { type: Number, default: undefined },
    action: { type: Schema.Types.Mixed, default: undefined },
    severityActions: { type: Schema.Types.Mixed, default: undefined },
    kind: {
      type: String,
      default: undefined,
      enum: ['input', 'output', 'tool_input', 'tool_output', 'handoff'],
    },
    tier: { type: String, default: undefined, enum: ['local', 'model', 'llm'] },
    provider: { type: String, default: undefined },
    category: { type: String, default: undefined },
    check: { type: String, default: undefined },
    llmCheck: { type: String, default: undefined },
    description: { type: String, default: undefined },
    priority: { type: Number, default: undefined },
    message: { type: String, default: undefined },
    entities: { type: [String], default: undefined },
    enabled: {
      type: Boolean,
      default: undefined,
      validate: {
        validator: (v: unknown) => v === undefined || typeof v === 'boolean',
        message: 'enabled must be boolean if present',
      },
    },
    presetKey: { type: String, default: undefined },
    actionMessage: { type: String, default: undefined },
  },
  { _id: false },
);

const ConstitutionPrincipleSchema = new Schema<IConstitutionPrinciple>(
  {
    principle: { type: String, required: true },
    weight: { type: Number, required: true },
    examples: { type: [String], default: undefined },
  },
  { _id: false },
);

const GuardrailStreamingSettingsSchema = new Schema<IGuardrailStreamingSettings>(
  {
    enabled: { type: Boolean, required: true, default: false },
    defaultInterval: {
      type: String,
      required: true,
      enum: ['token', 'sentence', 'chunk_size'],
      default: 'sentence',
    },
    chunkSize: { type: Number, required: true, default: 256, min: 1 },
    maxLatencyMs: { type: Number, required: true, default: 500, min: 1 },
    earlyTermination: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

const GuardrailSettingsSchema = new Schema<IGuardrailSettings>(
  {
    failMode: { type: String, required: true, enum: ['open', 'closed'], default: 'open' },
    timeouts: {
      type: new Schema(
        {
          local: { type: Number, required: true, default: 100, min: 1 },
          model: { type: Number, required: true, default: 5000, min: 1 },
          llm: { type: Number, required: true, default: 15000, min: 1 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },
    webhookUrl: { type: String, default: undefined },
    encryptedWebhookSecret: { type: String, default: undefined },
    streaming: { type: GuardrailStreamingSettingsSchema, required: true, default: () => ({}) },
  },
  { _id: false },
);

const GuardrailCachingSchema = new Schema<IGuardrailCaching>(
  {
    enabled: { type: Boolean, required: true, default: false },
    exactMatch: { type: Boolean, required: true, default: true },
    semanticMatch: { type: Boolean, required: true, default: false },
    semanticThreshold: { type: Number, required: true, default: 0.95 },
    defaultTtlSeconds: { type: Number, required: true, default: 3600 },
  },
  { _id: false },
);

const GuardrailBudgetSchema = new Schema<IGuardrailBudget>(
  {
    monthlyLimitUsd: { type: Number, required: true, default: 100, min: Number.MIN_VALUE },
    currentSpendUsd: { type: Number, required: true, default: 0, min: 0 },
    overspendAction: {
      type: String,
      required: true,
      enum: ['downgrade', 'disable_model_checks', 'alert_only'],
      default: 'alert_only',
    },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const GuardrailPolicySchema = new Schema<IGuardrailPolicy>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: undefined },
    scope: { type: GuardrailPolicyScopeSchema, required: true, default: () => ({}) },
    providerOverrides: { type: [GuardrailProviderOverrideSchema], default: [] },
    rules: { type: [GuardrailRuleSchema], default: [] },
    constitution: { type: [ConstitutionPrincipleSchema], default: [] },
    settings: { type: GuardrailSettingsSchema, required: true, default: () => ({}) },
    caching: { type: GuardrailCachingSchema, required: true, default: () => ({}) },
    budget: { type: GuardrailBudgetSchema, required: true, default: () => ({}) },
    version: { type: Number, default: 1 },
    previousVersionId: { type: String, default: undefined },
    changelog: { type: String, default: undefined },
    status: { type: String, default: 'draft', enum: ['draft', 'active', 'archived'] },
    isActive: { type: Boolean, default: false },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'guardrail_policies' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

GuardrailPolicySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

GuardrailPolicySchema.index(
  {
    tenantId: 1,
    name: 1,
    'scope.type': 1,
    'scope.projectId': 1,
    'scope.agentDefId': 1,
  },
  { unique: true },
);
GuardrailPolicySchema.index({ tenantId: 1, 'scope.projectId': 1, status: 1 });
GuardrailPolicySchema.index({ tenantId: 1, 'scope.agentDefId': 1 });
GuardrailPolicySchema.index({ tenantId: 1, isActive: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const GuardrailPolicy =
  (mongoose.models.GuardrailPolicy as any) ||
  model<IGuardrailPolicy>('GuardrailPolicy', GuardrailPolicySchema);
