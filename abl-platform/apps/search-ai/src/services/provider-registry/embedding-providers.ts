/**
 * Embedding Provider Registry
 *
 * Static metadata for available embedding providers.
 * Used by API endpoints (GET /providers/embedding) and UI dropdowns.
 *
 * This is separate from the ProviderRegistry (which handles pipeline stage providers).
 * Embedding providers are resolved at both ingestion and query time via
 * EmbeddingProviderResolver.
 *
 * Reference: docs/searchai/pipelines/design/backend/04-CONFIGURABLE-EMBEDDING-PROVIDERS.md
 */

import type { EmbeddingProviderType } from '@agent-platform/database';

// ─── Types ───────────────────────────────────────────────────────────────

export interface EmbeddingModelMetadata {
  /** Model identifier (e.g., 'text-embedding-3-small') */
  id: string;
  /** Display name */
  name: string;
  /** Supported dimensions (some models support multiple) */
  dimensions: number[];
  /** Default dimensions if not specified */
  defaultDimensions: number;
  /** Cost per 1M tokens in USD (0 for self-hosted) */
  costPer1MTokens: number;
  /** Maximum texts per batch request */
  maxBatchSize: number;
  /** Maximum input tokens per text */
  maxInputTokens: number;
}

export interface EmbeddingProviderMetadata {
  /** Provider identifier */
  id: EmbeddingProviderType;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Whether the provider is self-hosted (no external API calls) */
  selfHosted: boolean;
  /** Whether API credentials are required */
  requiresCredentials: boolean;
  /** Supported models */
  models: EmbeddingModelMetadata[];
}

// ─── Registry ────────────────────────────────────────────────────────────

export const EMBEDDING_PROVIDERS: Record<EmbeddingProviderType, EmbeddingProviderMetadata> = {
  'bge-m3': {
    id: 'bge-m3',
    name: 'BGE-M3',
    description: 'Self-hosted multilingual embedding model (default)',
    selfHosted: true,
    requiresCredentials: false,
    models: [
      {
        id: 'bge-m3',
        name: 'BGE-M3 v1',
        dimensions: [1024],
        defaultDimensions: 1024,
        costPer1MTokens: 0,
        maxBatchSize: 32,
        maxInputTokens: 8192,
      },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI Embeddings',
    description: 'OpenAI cloud embedding models',
    selfHosted: false,
    requiresCredentials: true,
    models: [
      {
        id: 'text-embedding-3-small',
        name: 'Text Embedding 3 Small',
        dimensions: [512, 1536],
        defaultDimensions: 1536,
        costPer1MTokens: 0.02,
        maxBatchSize: 100,
        maxInputTokens: 8191,
      },
      {
        id: 'text-embedding-3-large',
        name: 'Text Embedding 3 Large',
        dimensions: [256, 1024, 3072],
        defaultDimensions: 3072,
        costPer1MTokens: 0.13,
        maxBatchSize: 100,
        maxInputTokens: 8191,
      },
    ],
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere Embeddings',
    description: 'Cohere cloud embedding models',
    selfHosted: false,
    requiresCredentials: true,
    models: [
      {
        id: 'embed-english-v3.0',
        name: 'Embed English v3',
        dimensions: [1024],
        defaultDimensions: 1024,
        costPer1MTokens: 0.1,
        maxBatchSize: 96,
        maxInputTokens: 512,
      },
    ],
  },
  azure: {
    id: 'azure',
    name: 'Azure OpenAI Embeddings',
    description: 'Azure-hosted OpenAI embedding models',
    selfHosted: false,
    requiresCredentials: true,
    models: [
      {
        id: 'text-embedding-3-small',
        name: 'Text Embedding 3 Small',
        dimensions: [512, 1536],
        defaultDimensions: 1536,
        costPer1MTokens: 0.02,
        maxBatchSize: 100,
        maxInputTokens: 8191,
      },
      {
        id: 'text-embedding-3-large',
        name: 'Text Embedding 3 Large',
        dimensions: [256, 1024, 3072],
        defaultDimensions: 3072,
        costPer1MTokens: 0.13,
        maxBatchSize: 100,
        maxInputTokens: 8191,
      },
      {
        id: 'text-embedding-ada-002',
        name: 'Text Embedding Ada 002',
        dimensions: [1536],
        defaultDimensions: 1536,
        costPer1MTokens: 0.1,
        maxBatchSize: 100,
        maxInputTokens: 8191,
      },
    ],
  },
  custom: {
    id: 'custom',
    name: 'Custom Endpoint',
    description: 'OpenAI-compatible custom embedding endpoint',
    selfHosted: true,
    requiresCredentials: false,
    models: [],
  },
};

// ─── Helper Functions ────────────────────────────────────────────────────

/**
 * Get metadata for a specific embedding provider.
 */
export function getEmbeddingProvider(
  providerId: EmbeddingProviderType,
): EmbeddingProviderMetadata | undefined {
  return EMBEDDING_PROVIDERS[providerId];
}

/**
 * List all available embedding providers.
 */
export function listEmbeddingProviders(): EmbeddingProviderMetadata[] {
  return Object.values(EMBEDDING_PROVIDERS);
}

/**
 * Get models for a specific provider.
 */
export function getModelsForProvider(providerId: EmbeddingProviderType): EmbeddingModelMetadata[] {
  return EMBEDDING_PROVIDERS[providerId]?.models ?? [];
}

/**
 * Validate that a provider/model/dimensions combination is valid.
 */
export function validateEmbeddingConfig(
  providerId: string,
  modelId: string,
  dimensions: number,
): { valid: boolean; error?: string } {
  const provider = EMBEDDING_PROVIDERS[providerId as EmbeddingProviderType];
  if (!provider) {
    return { valid: false, error: `Unknown embedding provider: '${providerId}'` };
  }

  // Custom provider accepts any model
  if (providerId === 'custom') {
    return { valid: true };
  }

  const model = provider.models.find((m) => m.id === modelId);
  if (!model) {
    const validModels = provider.models.map((m) => m.id).join(', ');
    return {
      valid: false,
      error: `Model '${modelId}' not found for provider '${providerId}'. Valid models: ${validModels}`,
    };
  }

  if (!model.dimensions.includes(dimensions)) {
    return {
      valid: false,
      error: `Dimensions ${dimensions} not supported by model '${modelId}'. Supported: ${model.dimensions.join(', ')}`,
    };
  }

  return { valid: true };
}
