/**
 * Pipeline Definition Model
 *
 * Represents a pluggable ingestion pipeline configuration for a knowledge base.
 * Contains multiple flows (processing paths) that are selected at runtime based
 * on document properties using CEL expressions.
 *
 * Design: Single-document model with embedded flows (no separate collection).
 * Scoped to tenant via tenant isolation plugin.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interfaces ─────────────────────────────────────────────────

export interface ISearchValidationError {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  path: string;
}

export type SearchPipelineStageType =
  | 'extraction'
  | 'chunking'
  | 'enrichment'
  | 'embedding'
  | 'multimodal'
  | 'content-intelligence'
  | 'visual-analysis'
  | 'custom-script'
  | 'field-mapping'
  | 'api-webhook'
  | 'llm-stage';

export type SearchRuleConditionType = 'simple' | 'compound' | 'cel';

export interface ISearchRuleCondition {
  type: SearchRuleConditionType;
  description?: string;

  // Simple condition (field operator value)
  field?: string;
  operator?: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'matches' | 'in';
  value?: unknown;

  // Compound condition (AND/OR logic)
  logic?: 'AND' | 'OR';
  conditions?: ISearchRuleCondition[];

  // CEL expression (most flexible)
  celExpression?: string;
}

export interface ISearchPipelineStage {
  id: string;
  name: string;
  type: SearchPipelineStageType;
  provider: string;
  providerConfig: Record<string, unknown>;

  onError: 'fail' | 'continue';

  fallbackProvider?: string;
  fallbackConfig?: Record<string, unknown>;

  executionCondition?: string;
  requiredProviderVersion?: string;

  description?: string;
  estimatedDuration?: number;
  estimatedCost?: number;
}

export interface ISearchPipelineFlow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  selectionRules?: ISearchRuleCondition[];
  priority: number;
  isDefault: boolean;
  templateVersion?: string;

  stages: ISearchPipelineStage[];

  customEnrichment?: ISearchPipelineStage[];
  customIndexing?: ISearchPipelineStage[];

  providerDefaults?: Record<string, Record<string, unknown>>;

  createdAt: Date;
  updatedAt: Date;
}

export type EmbeddingProviderType = 'openai' | 'cohere' | 'bge-m3' | 'azure' | 'custom';

export interface IActiveEmbeddingConfig {
  /** Embedding provider ID */
  provider: EmbeddingProviderType;
  /** Model identifier (e.g., 'text-embedding-3-small', 'bge-m3') */
  model: string;
  /** Vector dimensions */
  dimensions: number;
  /** Provider-specific configuration (baseUrl, batchSize, timeout, etc.) */
  providerConfig?: Record<string, unknown>;
}

export interface ISearchPipelineDefinition {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;

  name: string;
  description: string;
  version: number;
  status: 'draft' | 'active' | 'archived';

  /** Whether this is the system default pipeline (cannot be deleted, stages cannot be removed) */
  isDefault: boolean;

  flows: ISearchPipelineFlow[];

  /**
   * Active embedding configuration for the pipeline.
   * Used at both ingestion time and query time.
   * All flows must use the same embedding provider/model/dimensions.
   * Changing this triggers reindexing of all documents.
   */
  activeEmbeddingConfig: IActiveEmbeddingConfig;

  sharedStages?: {
    enrichment?: ISearchPipelineStage[];
    indexing?: ISearchPipelineStage[];
  };

  providerDefaults?: Record<string, Record<string, unknown>>;

  /** Snapshot of the previously active pipeline, stored at publish time for reindex diffing */
  previousVersion?: Record<string, unknown> | null;

  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastDeployedAt?: Date;

  validationErrors?: ISearchValidationError[];
  validationStatus?: 'valid' | 'invalid' | 'pending';
  lastValidatedAt?: Date;
}

// ─── Schemas ─────────────────────────────────────────────────────────────

// RuleCondition Schema (Recursive)
const RuleConditionSchema: Schema = new Schema<ISearchRuleCondition>(
  {
    type: {
      type: String,
      enum: ['simple', 'compound', 'cel'],
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    // Simple condition fields
    field: {
      type: String,
      trim: true,
      required: function (this: ISearchRuleCondition) {
        return this.type === 'simple';
      },
    },
    operator: {
      type: String,
      enum: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'matches', 'in'],
      required: function (this: ISearchRuleCondition) {
        return this.type === 'simple';
      },
    },
    value: {
      type: Schema.Types.Mixed,
      required: function (this: ISearchRuleCondition) {
        return this.type === 'simple';
      },
    },
    // Compound condition fields
    logic: {
      type: String,
      enum: ['AND', 'OR'],
      required: function (this: ISearchRuleCondition) {
        return this.type === 'compound';
      },
    },
    conditions: {
      type: [Schema.Types.Mixed], // Will be validated as ISearchRuleCondition[]
      required: function (this: ISearchRuleCondition) {
        return this.type === 'compound';
      },
    },
    // CEL expression field
    celExpression: {
      type: String,
      trim: true,
      required: function (this: ISearchRuleCondition) {
        return this.type === 'cel';
      },
    },
  },
  {
    _id: false,
  },
);

// PipelineStage Schema
const PipelineStageSchema = new Schema<ISearchPipelineStage>(
  {
    id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    type: {
      type: String,
      enum: [
        'extraction',
        'chunking',
        'enrichment',
        'embedding',
        'multimodal',
        'content-intelligence',
        'visual-analysis',
        'custom-script',
        'field-mapping',
        'api-webhook',
        'llm-stage',
      ],
      required: true,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
    },
    providerConfig: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
    },
    onError: {
      type: String,
      enum: ['fail', 'continue'],
      required: true,
      default: 'fail',
    },
    fallbackProvider: {
      type: String,
      trim: true,
      required: false,
    },
    fallbackConfig: {
      type: Schema.Types.Mixed,
      required: false,
    },
    executionCondition: {
      type: String,
      trim: true,
      required: false,
    },
    requiredProviderVersion: {
      type: String,
      trim: true,
      required: false,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    estimatedDuration: {
      type: Number,
      min: 0,
      required: false,
    },
    estimatedCost: {
      type: Number,
      min: 0,
      required: false,
    },
  },
  {
    _id: false,
  },
);

// PipelineFlow Schema
const PipelineFlowSchema = new Schema<ISearchPipelineFlow>(
  {
    id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    enabled: {
      type: Boolean,
      required: true,
      default: true,
    },
    selectionRules: {
      type: [RuleConditionSchema],
      required: false,
    },
    priority: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    isDefault: {
      type: Boolean,
      required: true,
      default: false,
    },
    templateVersion: {
      type: String,
      trim: true,
      required: false,
    },
    stages: {
      type: [PipelineStageSchema],
      required: true,
      validate: {
        validator: (stages: ISearchPipelineStage[]) => stages.length > 0,
        message: 'Flow must have at least one stage',
      },
    },
    customEnrichment: {
      type: [PipelineStageSchema],
      required: false,
    },
    customIndexing: {
      type: [PipelineStageSchema],
      required: false,
    },
    providerDefaults: {
      type: Schema.Types.Mixed,
      required: false,
    },
  },
  {
    timestamps: true,
    _id: false,
  },
);

// ActiveEmbeddingConfig Schema
const ActiveEmbeddingConfigSchema = new Schema<IActiveEmbeddingConfig>(
  {
    provider: {
      type: String,
      required: true,
      enum: ['openai', 'cohere', 'bge-m3', 'azure', 'custom'],
      default: 'bge-m3',
    },
    model: {
      type: String,
      required: true,
      default: 'bge-m3',
    },
    dimensions: {
      type: Number,
      required: true,
      default: 1024,
      min: 1,
    },
    providerConfig: {
      type: Schema.Types.Mixed,
      required: false,
    },
  },
  { _id: false },
);

// PipelineDefinition Schema
const SearchPipelineDefinitionSchema = new Schema<ISearchPipelineDefinition>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    knowledgeBaseId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: '',
    },
    version: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'archived'],
      default: 'draft',
      required: true,
    },
    isDefault: {
      type: Boolean,
      required: true,
      default: false,
    },
    flows: {
      type: [PipelineFlowSchema],
      required: true,
      validate: [
        {
          validator: (flows: ISearchPipelineFlow[]) => flows.length > 0,
          message: 'Pipeline must have at least one flow',
        },
        {
          validator: (flows: ISearchPipelineFlow[]) => flows.length <= 50,
          message: 'Pipeline cannot exceed 50 flows (performance limit)',
        },
      ],
    },
    activeEmbeddingConfig: {
      type: ActiveEmbeddingConfigSchema,
      required: true,
      default: () => ({
        provider: 'bge-m3',
        model: 'bge-m3',
        dimensions: 1024,
      }),
    },
    sharedStages: {
      type: {
        enrichment: [PipelineStageSchema],
        indexing: {
          type: [PipelineStageSchema],
          validate: {
            validator: (stages: ISearchPipelineStage[]) => !stages || stages.length > 0,
            message: 'Indexing stages array must not be empty if provided',
          },
        },
      },
      required: false,
    },
    providerDefaults: {
      type: Schema.Types.Mixed,
      required: false,
    },
    previousVersion: {
      type: Schema.Types.Mixed,
      required: false,
      default: null,
    },
    createdBy: {
      type: String,
      required: true,
    },
    lastDeployedAt: {
      type: Date,
      required: false,
    },
    validationErrors: {
      type: [
        {
          code: String,
          message: String,
          severity: {
            type: String,
            enum: ['error', 'warning', 'info'],
          },
          path: String,
        },
      ],
      required: false,
    },
    validationStatus: {
      type: String,
      enum: ['valid', 'invalid', 'pending'],
      required: false,
    },
    lastValidatedAt: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: true,
    collection: 'search_pipeline_definitions',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SearchPipelineDefinitionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique on tenant + kb + name allows multiple pipelines per KB (default + custom)
SearchPipelineDefinitionSchema.index(
  { tenantId: 1, knowledgeBaseId: 1, name: 1 },
  { unique: true },
);
// Only one default pipeline per KB
SearchPipelineDefinitionSchema.index(
  { tenantId: 1, knowledgeBaseId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);
SearchPipelineDefinitionSchema.index({ tenantId: 1, status: 1 });
SearchPipelineDefinitionSchema.index({ tenantId: 1, 'flows.id': 1 });

// ─── Pre-save Middleware ─────────────────────────────────────────────────

// Increment version on update
SearchPipelineDefinitionSchema.pre('save', function (next) {
  if (!this.isNew) {
    this.version += 1;
  }
  next();
});

// Ensure at least one enabled flow
SearchPipelineDefinitionSchema.pre('save', function (next) {
  const hasEnabledFlow = this.flows.some((flow) => flow.enabled);
  if (!hasEnabledFlow) {
    return next(new Error('Pipeline must have at least one enabled flow'));
  }
  next();
});

// ─── Model ───────────────────────────────────────────────────────────────

export const SearchPipelineDefinition =
  (mongoose.models.SearchPipelineDefinition as any) ||
  model<ISearchPipelineDefinition>('SearchPipelineDefinition', SearchPipelineDefinitionSchema);
