/**
 * Tenant Guardrail Provider Config Model
 *
 * Represents a guardrail provider configuration scoped to a tenant.
 * Stores connection details, adapter type, supported categories,
 * circuit breaker settings, retry policies, and health check state
 * for external guardrail evaluation services.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

import {
  GUARDRAIL_ADAPTER_TYPES,
  type GuardrailAdapterType,
} from '../constants/guardrail-adapters.js';

// Re-export so barrel consumers can still reach these from the model path
export {
  GUARDRAIL_ADAPTER_TYPES,
  IMPLEMENTED_GUARDRAIL_ADAPTER_TYPES,
  type GuardrailAdapterType,
  type ImplementedGuardrailAdapterType,
} from '../constants/guardrail-adapters.js';

// ─── Embedded Interfaces ─────────────────────────────────────────────────

export interface ISelfHostedConfig {
  runtime: string;
  gpuType?: string;
  quantization?: string;
  maxBatchSize?: number;
  maxConcurrency?: number;
}

export interface ICustomMapping {
  requestTemplate: string;
  responseScorePath: string;
  responseLabelPath?: string;
  responseExplanationPath?: string;
}

export interface ICircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  failMode: 'open' | 'closed';
}

export interface IRetryConfig {
  maxRetries: number;
  backoffBaseMs: number;
}

export interface ILastHealthCheck {
  status: string;
  latencyMs: number;
  checkedAt: Date;
  error?: string;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITenantGuardrailProviderConfig {
  _id: string;
  tenantId: string;
  name: string;
  displayName: string;
  adapterType: GuardrailAdapterType;
  endpoint: string;
  apiKeyCredentialId?: string;
  authProfileId?: string;
  model: string;
  hosting: 'self_hosted' | 'cloud_api' | 'managed_service';
  selfHostedConfig?: ISelfHostedConfig;
  defaultCategory: string;
  defaultThreshold: number;
  supportedCategories: string[];
  customMapping?: ICustomMapping;
  circuitBreaker: ICircuitBreakerConfig;
  retry: IRetryConfig;
  costPerEvalUsd: number;
  isActive: boolean;
  lastHealthCheck?: ILastHealthCheck;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Embedded Schemas ────────────────────────────────────────────────────

const SelfHostedConfigSchema = new Schema<ISelfHostedConfig>(
  {
    runtime: { type: String, required: true, enum: ['vllm', 'tgi', 'ollama', 'triton', 'other'] },
    gpuType: { type: String, default: undefined },
    quantization: {
      type: String,
      default: undefined,
      enum: ['none', 'gptq', 'awq', 'gguf', 'fp8'],
    },
    maxBatchSize: { type: Number, default: undefined },
    maxConcurrency: { type: Number, default: undefined },
  },
  { _id: false },
);

const CustomMappingSchema = new Schema<ICustomMapping>(
  {
    requestTemplate: { type: String, required: true },
    responseScorePath: { type: String, required: true },
    responseLabelPath: { type: String, default: undefined },
    responseExplanationPath: { type: String, default: undefined },
  },
  { _id: false },
);

const CircuitBreakerConfigSchema = new Schema<ICircuitBreakerConfig>(
  {
    failureThreshold: { type: Number, required: true, default: 5, min: 1 },
    resetTimeoutMs: { type: Number, required: true, default: 30000, min: 1 },
    failMode: { type: String, required: true, enum: ['open', 'closed'], default: 'open' },
  },
  { _id: false },
);

const RetryConfigSchema = new Schema<IRetryConfig>(
  {
    maxRetries: { type: Number, required: true, default: 3, min: 0 },
    backoffBaseMs: { type: Number, required: true, default: 1000, min: 0 },
  },
  { _id: false },
);

const LastHealthCheckSchema = new Schema<ILastHealthCheck>(
  {
    status: { type: String, required: true, enum: ['healthy', 'unhealthy', 'unknown'] },
    latencyMs: { type: Number, required: true },
    checkedAt: { type: Date, required: true },
    error: { type: String, default: undefined },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const TenantGuardrailProviderConfigSchema = new Schema<ITenantGuardrailProviderConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    adapterType: {
      type: String,
      required: true,
      enum: [...GUARDRAIL_ADAPTER_TYPES],
    },
    endpoint: { type: String, required: true },
    apiKeyCredentialId: { type: String, default: undefined },
    authProfileId: { type: String, default: null },
    model: { type: String, required: true },
    hosting: {
      type: String,
      required: true,
      enum: ['self_hosted', 'cloud_api', 'managed_service'],
    },
    selfHostedConfig: { type: SelfHostedConfigSchema, default: undefined },
    defaultCategory: { type: String, required: true },
    defaultThreshold: { type: Number, required: true, min: 0, max: 1 },
    supportedCategories: { type: [String], default: [] },
    customMapping: { type: CustomMappingSchema, default: undefined },
    circuitBreaker: { type: CircuitBreakerConfigSchema, required: true, default: () => ({}) },
    retry: { type: RetryConfigSchema, required: true, default: () => ({}) },
    costPerEvalUsd: { type: Number, required: true, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    lastHealthCheck: { type: LastHealthCheckSchema, default: undefined },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_guardrail_provider_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantGuardrailProviderConfigSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

TenantGuardrailProviderConfigSchema.index({ tenantId: 1, name: 1 }, { unique: true });
TenantGuardrailProviderConfigSchema.index({ tenantId: 1, isActive: 1 });
TenantGuardrailProviderConfigSchema.index({ tenantId: 1, adapterType: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const TenantGuardrailProviderConfig =
  (mongoose.models.TenantGuardrailProviderConfig as any) ||
  model<ITenantGuardrailProviderConfig>(
    'TenantGuardrailProviderConfig',
    TenantGuardrailProviderConfigSchema,
  );
