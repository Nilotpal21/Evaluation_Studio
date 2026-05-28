/**
 * Pipeline Zod Validation Schemas
 *
 * Request-level validation schemas for pipeline CRUD API endpoints.
 * Complements Mongoose schema validation with strict input validation.
 *
 * Reference: docs/searchai/pipelines/design/backend/01-DATA-MODELS.md
 */

import { z } from 'zod';

// ─── Embedding Config Schema ─────────────────────────────────────────────

export const VALID_EMBEDDING_PROVIDERS = ['openai', 'cohere', 'bge-m3', 'azure', 'custom'] as const;

export const ActiveEmbeddingConfigSchema = z.object({
  provider: z.enum(VALID_EMBEDDING_PROVIDERS),
  model: z.string().min(1, 'Embedding model is required'),
  dimensions: z.number().int().positive('Dimensions must be a positive integer'),
  providerConfig: z.record(z.unknown()).optional(),
});

export type ActiveEmbeddingConfigInput = z.infer<typeof ActiveEmbeddingConfigSchema>;

// ─── Rule Condition Schema ───────────────────────────────────────────────

const SimpleRuleConditionSchema = z.object({
  type: z.literal('simple'),
  field: z.string(),
  operator: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'matches', 'in']),
  value: z.unknown(),
  description: z.string().optional(),
});

const CELRuleConditionSchema = z.object({
  type: z.literal('cel'),
  celExpression: z.string().min(1),
  description: z.string().optional(),
});

// Forward declaration for recursive compound type
const RuleConditionSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion('type', [
    SimpleRuleConditionSchema,
    z.object({
      type: z.literal('compound'),
      logic: z.enum(['AND', 'OR']),
      conditions: z.array(RuleConditionSchema),
      description: z.string().optional(),
    }),
    CELRuleConditionSchema,
  ]),
);

// ─── Pipeline Stage Schema ───────────────────────────────────────────────

const PipelineStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  type: z.enum(['extraction', 'chunking', 'enrichment', 'embedding', 'multimodal']),
  provider: z.string().min(1),
  providerConfig: z.record(z.unknown()).default({}),
  onError: z.enum(['fail', 'continue']).default('fail'),
  fallbackProvider: z.string().optional(),
  fallbackConfig: z.record(z.unknown()).optional(),
  executionCondition: z.string().optional(),
  requiredProviderVersion: z.string().optional(),
  description: z.string().max(1000).optional(),
  estimatedDuration: z.number().min(0).optional(),
  estimatedCost: z.number().min(0).optional(),
});

// ─── Pipeline Flow Schema ────────────────────────────────────────────────

const PipelineFlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  selectionRules: z.array(RuleConditionSchema).optional(),
  priority: z.number().min(1).max(100),
  stages: z.array(PipelineStageSchema).min(1),
  customEnrichment: z.array(PipelineStageSchema).optional(),
  customIndexing: z.array(PipelineStageSchema).optional(),
  providerDefaults: z.record(z.record(z.unknown())).optional(),
});

// ─── Pipeline Definition Schemas ─────────────────────────────────────────

export const CreatePipelineDefinitionSchema = z.object({
  knowledgeBaseId: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  flows: z.array(PipelineFlowSchema).min(1).max(50),
  activeEmbeddingConfig: ActiveEmbeddingConfigSchema.default({
    provider: 'bge-m3',
    model: 'bge-m3',
    dimensions: 1024,
  }),
  sharedStages: z
    .object({
      enrichment: z.array(PipelineStageSchema).optional(),
      indexing: z.array(PipelineStageSchema).min(1).optional(),
    })
    .optional(),
  providerDefaults: z.record(z.record(z.unknown())).optional(),
});

export const UpdatePipelineDefinitionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  flows: z.array(PipelineFlowSchema).min(1).max(50).optional(),
  activeEmbeddingConfig: ActiveEmbeddingConfigSchema.optional(),
  sharedStages: z
    .object({
      enrichment: z.array(PipelineStageSchema).optional(),
      indexing: z.array(PipelineStageSchema).min(1).optional(),
    })
    .optional(),
  providerDefaults: z.record(z.record(z.unknown())).optional(),
});

/**
 * Schema for the PATCH embedding-config endpoint.
 * Requires confirm: true to prevent accidental changes.
 */
export const UpdateEmbeddingConfigSchema = z.object({
  provider: z.enum(VALID_EMBEDDING_PROVIDERS),
  model: z.string().min(1, 'Embedding model is required'),
  dimensions: z.number().int().positive('Dimensions must be a positive integer'),
  providerConfig: z.record(z.unknown()).optional(),
  confirm: z.literal(true, {
    errorMap: () => ({
      message: 'Changing embedding config requires reindexing. Set confirm: true to proceed.',
    }),
  }),
});

export type CreatePipelineDefinitionInput = z.infer<typeof CreatePipelineDefinitionSchema>;
export type UpdatePipelineDefinitionInput = z.infer<typeof UpdatePipelineDefinitionSchema>;
export type UpdateEmbeddingConfigInput = z.infer<typeof UpdateEmbeddingConfigSchema>;
