/**
 * Validation schemas for SearchIndex configuration
 *
 * Ensures user-provided configurations are valid before creating/updating indexes.
 */

import { z } from 'zod';

/**
 * Vector Store Validation
 */
export const VectorStoreSchema = z.object({
  provider: z.enum(['opensearch', 'qdrant', 'pinecone', 'pgvector', 'weaviate'], {
    errorMap: () => ({
      message: 'provider must be one of: opensearch, qdrant, pinecone, pgvector, weaviate',
    }),
  }),
  collectionName: z
    .string()
    .min(1, 'collectionName is required')
    .max(100, 'collectionName cannot exceed 100 characters')
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'collectionName must only contain letters, numbers, hyphens, and underscores',
    ),
  connectionConfig: z.record(z.unknown()).optional(),
});

/**
 * Search Defaults Validation
 */
export const SearchDefaultsSchema = z.object({
  topK: z.number().int().min(1, 'topK must be at least 1').max(100, 'topK cannot exceed 100'),
  similarityThreshold: z
    .number()
    .min(0, 'similarityThreshold must be between 0 and 1')
    .max(1, 'similarityThreshold must be between 0 and 1'),
  includeMetadata: z.boolean(),
  includeContent: z.boolean(),
  reranker: z
    .object({
      provider: z.string(),
      model: z.string().optional(),
      topN: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  responseFields: z.array(z.string().min(1).max(100)).max(30).optional(),
});

/**
 * Embedding Configuration Validation
 *
 * Note: Full per-index embedding provider config is not yet implemented.
 * This validates the basic model/dimensions fields currently supported.
 */
export const EmbeddingConfigSchema = z.object({
  embeddingModel: z.string().min(1, 'embeddingModel is required'),
  embeddingDimensions: z
    .number()
    .int()
    .min(128, 'embeddingDimensions must be at least 128')
    .max(4096, 'embeddingDimensions cannot exceed 4096'),
});

/**
 * Validate embedding dimensions match model capabilities
 */
export function validateEmbeddingDimensions(
  model: string,
  dimensions: number,
): { valid: boolean; error?: string } {
  const knownModels: Record<string, number[]> = {
    'text-embedding-3-small': [512, 1536],
    'text-embedding-3-large': [256, 1024, 3072],
    'text-embedding-ada-002': [1536],
    'embed-english-v3.0': [1024],
    'embed-multilingual-v3.0': [1024],
    'bge-m3': [1024],
  };

  const supportedDimensions = knownModels[model];
  if (!supportedDimensions) {
    // Unknown model, allow any valid dimension
    return { valid: true };
  }

  if (!supportedDimensions.includes(dimensions)) {
    return {
      valid: false,
      error: `Model "${model}" supports dimensions: ${supportedDimensions.join(', ')}. Got: ${dimensions}`,
    };
  }

  return { valid: true };
}

/**
 * Create Index Request Body Validation
 */
export const CreateIndexSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  slug: z
    .string()
    .min(1, 'slug is required')
    .max(50, 'slug cannot exceed 50 characters')
    .regex(/^[a-z0-9-]+$/, 'slug must only contain lowercase letters, numbers, and hyphens'),
  name: z.string().min(1, 'name is required').max(100, 'name cannot exceed 100 characters'),
  description: z
    .string()
    .max(500, 'description cannot exceed 500 characters')
    .optional()
    .nullable(),
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.number().int().optional(),
  vectorStore: VectorStoreSchema.optional(),
  searchDefaults: SearchDefaultsSchema.optional(),
});

/**
 * Update Index Request Body Validation
 */
export const UpdateIndexSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  searchDefaults: SearchDefaultsSchema.optional(),
  status: z.enum(['creating', 'active', 'indexing', 'error']).optional(),
});

/**
 * Use Case Configuration Validation
 *
 * Base schema for all use cases - specific fields added per use case
 */
const BaseUseCaseConfigSchema = z.object({
  enabled: z.boolean().optional(),
  modelTier: z.enum(['fast', 'balanced', 'powerful']).optional(),
  /** Pin a specific TenantModel by ID for this use case (overrides tier-based resolution) */
  preferredModelId: z.string().min(1).optional(),
});

/**
 * Progressive Summarization Config
 */
export const ProgressiveSummarizationConfigSchema = BaseUseCaseConfigSchema.extend({
  maxTokens: z.number().int().min(50).max(1000).optional(),
  enableDocumentSummary: z.boolean().optional(),
  documentSummaryMaxTokens: z.number().int().min(100).max(2000).optional(),
});

/**
 * Question Synthesis Config
 */
export const QuestionSynthesisConfigSchema = BaseUseCaseConfigSchema.extend({
  questionsPerChunk: z.number().int().min(1).max(10).optional(),
  maxTokens: z.number().int().min(50).max(500).optional(),
  enableEmbedding: z.boolean().optional(),
  enableDocumentQuestions: z.boolean().optional(),
  documentQuestionsCount: z.number().int().min(1).max(20).optional(),
});

/**
 * Vision Processing Config
 */
export const VisionConfigSchema = BaseUseCaseConfigSchema.extend({
  maxTokens: z.number().int().min(100).max(1500).optional(),
  analyzeScreenshots: z.boolean().optional(),
  analyzeImages: z.boolean().optional(),
  enhanceTableContinuations: z.boolean().optional(),
});

/**
 * Multimodal Processing Config
 */
export const MultimodalConfigSchema = BaseUseCaseConfigSchema.extend({
  enableImageDescription: z.boolean().optional(),
  enableTableSummarization: z.boolean().optional(),
  enableChartAnalysis: z.boolean().optional(),
});

/**
 * Knowledge Graph Config
 */
export const KnowledgeGraphConfigSchema = BaseUseCaseConfigSchema.extend({
  enableCoOccurrence: z.boolean().optional(),
});

/**
 * Tree Builder Config
 */
export const TreeBuilderConfigSchema = BaseUseCaseConfigSchema.extend({
  maxTokens: z.number().int().min(50).max(1024).optional(),
  targetChunkSize: z.number().int().min(128).max(2048).optional(),
  maxChunkSize: z.number().int().min(256).max(4096).optional(),
  minChunkSize: z.number().int().min(64).max(1024).optional(),
  similarityThreshold: z.number().min(0).max(1).optional(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  maxChildrenPerNode: z.number().int().min(2).max(20).optional(),
  enableSemanticSplitting: z.boolean().optional(),
});

/**
 * Mapping Suggestion Config
 */
export const MappingSuggestionConfigSchema = BaseUseCaseConfigSchema.extend({});

/**
 * Vocabulary Generation Config
 */
export const VocabularyGenerationConfigSchema = BaseUseCaseConfigSchema.extend({});

/**
 * Scope Classification Config
 */
export const ScopeClassificationConfigSchema = BaseUseCaseConfigSchema.extend({
  maxTokens: z.number().int().min(20).max(200).optional(),
});

/**
 * Query Pipeline LLM Configuration Validation
 */
export const QueryLLMConfigSchema = z.object({
  enabled: z.boolean().optional(),
  modelId: z.string().nullable().optional(),
  autoSelect: z.boolean().optional(),
  preferredTier: z.enum(['fast', 'balanced', 'powerful']).optional(),
});

/**
 * LLM Configuration Validation
 */
export const LLMConfigSchema = z.object({
  enabled: z.boolean().optional(),
  useCases: z
    .object({
      progressiveSummarization: ProgressiveSummarizationConfigSchema.optional(),
      questionSynthesis: QuestionSynthesisConfigSchema.optional(),
      vision: VisionConfigSchema.optional(),
      multimodal: MultimodalConfigSchema.optional(),
      knowledgeGraph: KnowledgeGraphConfigSchema.optional(),
      treeBuilder: TreeBuilderConfigSchema.optional(),
      scopeClassification: ScopeClassificationConfigSchema.optional(),
      mapping_suggestion: MappingSuggestionConfigSchema.optional(),
      vocabularyGeneration: VocabularyGenerationConfigSchema.optional(),
    })
    .optional(),
});
