/**
 * Project Runtime Config Model
 *
 * Stores project-level runtime configuration for entity extraction,
 * multi-intent handling, inference settings, currency conversion, and
 * lookup tables. One document per project. Falls back to platform
 * defaults when absent.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// =============================================================================
// EMBEDDED SUBDOCUMENT INTERFACES
// =============================================================================

export interface IExtractionConfig {
  strategy: string;
  correction_detection: string;
  sidecar_timeout_ms: number;
  sidecar_circuit_breaker_threshold: number;
  nlu_provider: string;
  advanced_sidecar_url?: string;
  advanced_sidecar_timeout_ms: number;
  advanced_sidecar_circuit_breaker_threshold: number;
}

export interface IMultiIntentConfig {
  enabled: boolean;
  strategy: string;
  max_intents: number;
  confidence_threshold: number;
  queue_max_age_ms: number;
}

export interface IInferenceConfig {
  confidence: number;
  confirm: boolean;
  model_tier: string;
  max_fields_per_pass: number;
}

export interface IConversionConfig {
  currency_mode: string;
  currency_api_url?: string;
}

export interface IPIIRedactionConfig {
  enabled: boolean;
  redact_input: boolean;
  redact_output: boolean;
  /** Detection tier — drives in-process pack pipeline + (future) cloud tier. */
  tier?: 'basic' | 'standard' | 'advanced' | 'maximum';
  /** Per-detection latency budget for the async path. */
  latency_budget_ms?: number;
  /** Confidence floor — detections below this are dropped at the runtime layer. */
  confidence_threshold?: number;
  /** Recognizer pack allowlist; defaults to ['core'] via mapProjectPIIRedactionConfig. */
  enabled_recognizer_packs?: Array<
    'core' | 'us' | 'eu' | 'apac' | 'financial' | 'medical' | 'network' | 'international-phone'
  >;
}

export interface ICompactionConfig {
  model?: string;
  tool_results?: {
    strategy?: string;
    max_chars?: number;
    structured_threshold?: number;
    keep_recent?: number;
    max_description_length?: number;
    summarize_prompt?: string;
  };
  prior_turns?: {
    strategy?: string;
    assistant_preview_chars?: number;
  };
}

export interface ILookupTableEntry {
  name: string;
  source: 'inline' | 'collection' | 'api';
  values?: string[];
  table_name?: string;
  endpoint?: string;
  field?: string;
  timeout_ms?: number;
  case_sensitive: boolean;
  fuzzy_match: boolean;
  fuzzy_threshold: number;
}

export interface IIntentBridgeConfig {
  enabled: boolean;
  programmaticThreshold: number;
  guidedThreshold: number;
  outOfScopeDecline: boolean;
  multiIntentSignal: boolean;
}

export type RuntimeModelSource = 'system' | 'project' | 'tenant' | 'default';

export interface IPromptOverrideRef {
  promptId: string;
  versionId: string;
  promptName?: string;
  versionNumber?: number;
}

export interface IPipelineConfig {
  enabled: boolean;
  mode: string;
  /** @deprecated Use modelSource + tenantModelId */
  model?: string;
  modelSource: 'default' | 'tenant';
  tenantModelId?: string;
  shortCircuit: { enabled: boolean; confidenceThreshold: number };
  toolFilter: { enabled: boolean; maxTools: number };
  keywordVeto: { enabled: boolean; keywords: string[] };
  intentBridge: IIntentBridgeConfig;
}

export interface IRuntimeFillerConfig {
  enabled: boolean;
  chatEnabled: boolean;
  voiceEnabled: boolean;
  chatDelayMs: number;
  voiceDelayMs?: number;
  cooldownMs: number;
  maxPerTurn: number;
  piggybackEnabled: boolean;
  pipelineGenerationEnabled: boolean;
  modelSource: RuntimeModelSource;
  modelId?: string;
  tenantModelId?: string;
  promptRef?: IPromptOverrideRef;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProjectRuntimeConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  /** Compatibility mirror for the explicit operation routing map. */
  operationTierOverrides: Map<string, string> | Record<string, string>;
  extraction: IExtractionConfig;
  multi_intent: IMultiIntentConfig;
  inference: IInferenceConfig;
  conversion: IConversionConfig;
  pii_redaction: IPIIRedactionConfig;
  lookup_tables: ILookupTableEntry[];
  compaction?: ICompactionConfig;
  pipeline?: IPipelineConfig;
  filler?: IRuntimeFillerConfig;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// EMBEDDED SCHEMAS
// =============================================================================

const ExtractionConfigSchema = new Schema<IExtractionConfig>(
  {
    strategy: { type: String, default: 'auto' },
    correction_detection: { type: String, default: 'ml' },
    sidecar_timeout_ms: { type: Number, default: 500 },
    sidecar_circuit_breaker_threshold: { type: Number, default: 5 },
    nlu_provider: { type: String, default: 'standard', enum: ['standard', 'advanced'] },
    advanced_sidecar_url: { type: String },
    advanced_sidecar_timeout_ms: { type: Number, default: 3000 },
    advanced_sidecar_circuit_breaker_threshold: { type: Number, default: 5 },
  },
  { _id: false },
);

const MultiIntentConfigSchema = new Schema<IMultiIntentConfig>(
  {
    enabled: { type: Boolean, default: true },
    strategy: { type: String, default: 'primary_queue' },
    max_intents: { type: Number, default: 3 },
    confidence_threshold: { type: Number, default: 0.6 },
    queue_max_age_ms: { type: Number, default: 600_000 },
  },
  { _id: false },
);

const InferenceConfigSchema = new Schema<IInferenceConfig>(
  {
    confidence: { type: Number, default: 0.8 },
    confirm: { type: Boolean, default: true },
    model_tier: { type: String, default: 'fast' },
    max_fields_per_pass: { type: Number, default: 3 },
  },
  { _id: false },
);

const ConversionConfigSchema = new Schema<IConversionConfig>(
  {
    currency_mode: { type: String, default: 'static' },
    currency_api_url: { type: String, default: undefined },
  },
  { _id: false },
);

const PIIRedactionConfigSchema = new Schema<IPIIRedactionConfig>(
  {
    enabled: { type: Boolean, default: true },
    redact_input: { type: Boolean, default: true },
    redact_output: { type: Boolean, default: false },
    tier: { type: String, default: undefined },
    latency_budget_ms: { type: Number, default: undefined },
    confidence_threshold: { type: Number, default: undefined },
    enabled_recognizer_packs: { type: [String], default: undefined },
  },
  { _id: false },
);

const LookupTableEntrySchema = new Schema<ILookupTableEntry>(
  {
    name: { type: String, required: true },
    source: { type: String, required: true, enum: ['inline', 'collection', 'api'] },
    values: { type: [String], default: undefined },
    table_name: { type: String, default: undefined },
    endpoint: { type: String, default: undefined },
    field: { type: String, default: undefined },
    timeout_ms: { type: Number, default: undefined },
    case_sensitive: { type: Boolean, default: false },
    fuzzy_match: { type: Boolean, default: false },
    fuzzy_threshold: { type: Number, default: 0.8 },
  },
  { _id: false },
);

const CompactionToolResultsSchema = new Schema(
  {
    strategy: { type: String, enum: ['none', 'truncate', 'structured', 'summarize'] },
    max_chars: { type: Number },
    structured_threshold: { type: Number },
    keep_recent: { type: Number },
    max_description_length: { type: Number },
    summarize_prompt: { type: String },
  },
  { _id: false },
);

const CompactionPriorTurnsSchema = new Schema(
  {
    strategy: { type: String, enum: ['none', 'placeholder', 'compact', 'summarize'] },
    assistant_preview_chars: { type: Number },
  },
  { _id: false },
);

const CompactionConfigSchema = new Schema<ICompactionConfig>(
  {
    model: { type: String },
    tool_results: { type: CompactionToolResultsSchema },
    prior_turns: { type: CompactionPriorTurnsSchema },
  },
  { _id: false },
);

const IntentBridgeConfigSchema = new Schema<IIntentBridgeConfig>(
  {
    enabled: { type: Boolean, default: true },
    programmaticThreshold: { type: Number, default: 0.85, min: 0, max: 1 },
    guidedThreshold: { type: Number, default: 0.5, min: 0, max: 1 },
    outOfScopeDecline: { type: Boolean, default: true },
    multiIntentSignal: { type: Boolean, default: true },
  },
  { _id: false },
);

const PipelineShortCircuitSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    confidenceThreshold: { type: Number, default: 0.85, min: 0, max: 1 },
  },
  { _id: false },
);

const PipelineToolFilterSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    maxTools: { type: Number, default: 6, min: 1, max: 100 },
  },
  { _id: false },
);

const PipelineKeywordVetoSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    keywords: { type: [String], default: [] },
  },
  { _id: false },
);

const PromptOverrideRefSchema = new Schema<IPromptOverrideRef>(
  {
    promptId: { type: String, required: true },
    versionId: { type: String, required: true },
    promptName: { type: String, default: undefined },
    versionNumber: { type: Number, default: undefined },
  },
  { _id: false },
);

const PipelineConfigSchema = new Schema<IPipelineConfig>(
  {
    enabled: { type: Boolean, default: false },
    mode: { type: String, default: 'parallel', enum: ['parallel', 'sequential'] },
    model: { type: String, default: 'qwen3-30b' },
    modelSource: { type: String, default: 'default', enum: ['default', 'tenant'] },
    tenantModelId: { type: String, default: undefined },
    shortCircuit: { type: PipelineShortCircuitSchema, default: () => ({}) },
    toolFilter: { type: PipelineToolFilterSchema, default: () => ({}) },
    keywordVeto: { type: PipelineKeywordVetoSchema, default: () => ({}) },
    intentBridge: { type: IntentBridgeConfigSchema, default: () => ({}) },
  },
  { _id: false },
);

const FillerConfigSchema = new Schema<IRuntimeFillerConfig>(
  {
    enabled: { type: Boolean, default: true },
    chatEnabled: { type: Boolean, default: true },
    voiceEnabled: { type: Boolean, default: true },
    chatDelayMs: { type: Number, default: 1200, min: 0, max: 60000 },
    voiceDelayMs: { type: Number, default: 500, min: 1, max: 60000 },
    cooldownMs: { type: Number, default: 3000, min: 0, max: 60000 },
    maxPerTurn: { type: Number, default: 5, min: 0, max: 20 },
    piggybackEnabled: { type: Boolean, default: true },
    pipelineGenerationEnabled: { type: Boolean, default: true },
    modelSource: {
      type: String,
      default: 'system',
      enum: ['system', 'project', 'tenant', 'default'],
    },
    modelId: { type: String, default: undefined },
    tenantModelId: { type: String, default: undefined },
    promptRef: { type: PromptOverrideRefSchema, default: undefined },
  },
  { _id: false },
);

// =============================================================================
// MAIN SCHEMA
// =============================================================================

const ProjectRuntimeConfigSchema = new Schema<IProjectRuntimeConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    operationTierOverrides: { type: Map, of: String, default: new Map() },
    extraction: { type: ExtractionConfigSchema, default: () => ({}) },
    multi_intent: { type: MultiIntentConfigSchema, default: () => ({}) },
    inference: { type: InferenceConfigSchema, default: () => ({}) },
    conversion: { type: ConversionConfigSchema, default: () => ({}) },
    pii_redaction: { type: PIIRedactionConfigSchema, default: () => ({}) },
    lookup_tables: { type: [LookupTableEntrySchema], default: [] },
    compaction: { type: CompactionConfigSchema, default: undefined },
    pipeline: { type: PipelineConfigSchema, default: undefined },
    filler: { type: FillerConfigSchema, default: undefined },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_runtime_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectRuntimeConfigSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectRuntimeConfigSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectRuntimeConfig =
  (mongoose.models.ProjectRuntimeConfig as any) ||
  model<IProjectRuntimeConfig>('ProjectRuntimeConfig', ProjectRuntimeConfigSchema);
