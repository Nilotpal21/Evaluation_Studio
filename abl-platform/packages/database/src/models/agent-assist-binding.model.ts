/**
 * Agentic Compat Binding Model
 *
 * Persists the mapping between a Kore.ai appId + environment and an
 * ABL Platform project/deployment. Used by the Agent Assist V1
 * compatibility facade to resolve inbound widget requests.
 *
 * Unique constraint: (tenantId, appId, environment) — one binding per
 * app-environment pair per tenant.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Constants ──────────────────────────────────────────────────────────

const BINDING_STATUSES = ['active', 'disabled'] as const;

// ─── Document Interface ─────────────────────────────────────────────────

export interface IAgentAssistBinding {
  _id: string;
  tenantId: string;
  projectId: string;
  appId: string;
  environment: string;
  status: 'active' | 'disabled';
  deploymentId: string | null;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  displayName: string | null;
  createdBy: string;
  updatedBy: string | null;
  disabledAt: Date | null;
  runtimeBaseUrl: string | null;
  disabledBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const AgentAssistBindingSchema = new Schema<IAgentAssistBinding>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    appId: { type: String, required: true, trim: true },
    environment: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: BINDING_STATUSES,
      required: true,
      default: 'active',
    },
    deploymentId: { type: String, default: null },
    apiKeyId: { type: String, default: null },
    apiKeyPrefix: { type: String, default: null, maxlength: 16 },
    displayName: { type: String, default: null, trim: true, maxlength: 255 },
    runtimeBaseUrl: { type: String, default: null, trim: true, maxlength: 2048 },
    createdBy: { type: String, required: true, immutable: true },
    updatedBy: { type: String, default: null },
    disabledAt: { type: Date, default: null },
    disabledBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'agent_assist_bindings' },
);

// ─── Pre-validate: normalize environment to lowercase ───────────────────

AgentAssistBindingSchema.pre('validate', function normalizeEnvironment() {
  if (typeof this.environment === 'string') {
    this.environment = this.environment.toLowerCase();
  }
});

// ─── Plugins ────────────────────────────────────────────────────────────

AgentAssistBindingSchema.plugin(tenantIsolationPlugin);
AgentAssistBindingSchema.plugin(auditTrailPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

// Unique compound index: one binding per (tenant, appId, environment)
AgentAssistBindingSchema.index({ tenantId: 1, appId: 1, environment: 1 }, { unique: true });

// Query indexes
AgentAssistBindingSchema.index({ tenantId: 1, projectId: 1 });
AgentAssistBindingSchema.index({ tenantId: 1, status: 1 });

// ─── Model ──────────────────────────────────────────────────────────────

export const AgentAssistBinding =
  (mongoose.models.AgentAssistBinding as any) ||
  model<IAgentAssistBinding>('AgentAssistBinding', AgentAssistBindingSchema);
