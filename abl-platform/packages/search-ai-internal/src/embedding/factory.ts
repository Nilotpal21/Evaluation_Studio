/**
 * Embedding Provider Factory
 *
 * Creates EmbeddingProvider instances based on configuration.
 * Supports: OpenAI, Cohere, BGE-M3 (in-house), Custom (customer-hosted)
 */

import type { EmbeddingProvider, EmbeddingProviderConfig } from './interface.js';
import { OpenAIEmbeddingProvider } from './openai.js';
import { CohereEmbeddingProvider } from './cohere.js';
import { BGEm3EmbeddingProvider } from './bge-m3.js';
import { CustomEmbeddingProvider } from './custom.js';
import { AzureOpenAIEmbeddingProvider } from './azure-openai.js';

export interface EmbeddingFactoryConfig {
  provider: 'openai' | 'cohere' | 'bge-m3' | 'azure' | 'custom';
  apiKey?: string;
  model: string;
  dimensions?: number;
  maxBatchSize?: number;
  timeoutMs?: number;
  baseUrl?: string;
  /** Azure-specific: resource name (e.g., 'my-openai-resource') */
  resourceName?: string;
  /** Azure-specific: deployment name */
  deploymentId?: string;
  /** Azure-specific: API version (default: 2024-10-21) */
  apiVersion?: string;
}

/**
 * Create an embedding provider from configuration.
 */
export function createEmbeddingProvider(config: EmbeddingFactoryConfig): EmbeddingProvider {
  const providerConfig: EmbeddingProviderConfig = {
    apiKey: config.apiKey ?? '',
    model: config.model,
    dimensions: config.dimensions,
    maxBatchSize: config.maxBatchSize,
    timeoutMs: config.timeoutMs,
    baseUrl: config.baseUrl,
  };

  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider(providerConfig);

    case 'cohere':
      return new CohereEmbeddingProvider(providerConfig);

    case 'bge-m3':
      return new BGEm3EmbeddingProvider(providerConfig);

    case 'azure':
      return new AzureOpenAIEmbeddingProvider({
        ...providerConfig,
        resourceName: config.resourceName ?? '',
        deploymentId: config.deploymentId ?? config.model,
        apiVersion: config.apiVersion,
      });

    case 'custom':
      return new CustomEmbeddingProvider(providerConfig);

    default:
      throw new Error(`Unknown embedding provider: ${config.provider}`);
  }
}
