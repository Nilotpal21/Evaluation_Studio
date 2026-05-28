/**
 * Embedding Provider Factory for Search-AI Runtime
 *
 * Provides singleton access to EmbeddingProvider for query-time embedding generation.
 * Uses existing EmbeddingProvider infrastructure from @agent-platform/search-ai-internal.
 *
 * **Architecture:**
 * - Leverages createEmbeddingProvider factory (same as ingestion pipeline)
 * - Supports multiple providers: OpenAI, Cohere, BGE-M3, custom
 * - Configured via environment variables
 * - Singleton pattern for resource efficiency
 *
 * **Usage:**
 * ```typescript
 * const provider = getEmbeddingProvider();
 * const embedding = await provider.embed('semantic query text');
 * ```
 */

import {
  createEmbeddingProvider,
  EmbeddingProvider,
  type EmbeddingFactoryConfig,
} from '@agent-platform/search-ai-internal/embedding';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('EmbeddingProviderFactory');

// Singleton instance
let _embeddingProvider: EmbeddingProvider | null = null;

/**
 * Get singleton EmbeddingProvider instance
 *
 * Configured via environment variables:
 * - EMBEDDING_PROVIDER: 'openai' | 'cohere' | 'bge-m3' | 'custom'
 * - EMBEDDING_API_URL: Service URL (default: http://bge-m3:8000)
 * - EMBEDDING_API_KEY: API key (not needed for BGE-M3)
 * - EMBEDDING_MODEL: Model ID (default: BAAI/bge-m3)
 * - EMBEDDING_DIMENSIONS: Vector dimensions (default: 1024)
 * - EMBEDDING_MAX_BATCH_SIZE: Max batch size (default: 32)
 * - EMBEDDING_TIMEOUT: Request timeout in ms (default: 5000)
 *
 * @returns Singleton EmbeddingProvider instance
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_embeddingProvider) {
    const provider =
      (process.env.EMBEDDING_PROVIDER as 'openai' | 'cohere' | 'bge-m3' | 'custom') || 'bge-m3';

    // CRITICAL: Only pass baseUrl for bge-m3 and custom providers.
    // For openai/cohere, pass undefined so they use their default API URLs.
    // Applying the BGE-M3 service URL to cloud providers causes 404 errors.
    const baseUrl =
      provider === 'bge-m3' || provider === 'custom'
        ? process.env.EMBEDDING_API_URL || process.env.EMBEDDING_BASE_URL || 'http://bge-m3:8000'
        : undefined;

    const config: EmbeddingFactoryConfig = {
      provider,
      apiKey: process.env.EMBEDDING_API_KEY,
      baseUrl,
      model: process.env.EMBEDDING_MODEL || 'BAAI/bge-m3',
      dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10),
      maxBatchSize: parseInt(process.env.EMBEDDING_MAX_BATCH_SIZE || '32', 10),
      timeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT || '5000', 10),
    };

    _embeddingProvider = createEmbeddingProvider(config);

    logger.info('EmbeddingProvider initialized', {
      provider,
      model: _embeddingProvider.modelId,
      dimensions: _embeddingProvider.dimensions,
      maxBatchSize: _embeddingProvider.maxBatchSize,
      baseUrl: baseUrl || 'provider-default',
    });
  }

  return _embeddingProvider;
}

/**
 * Close embedding provider (cleanup connections)
 *
 * Call this during application shutdown to cleanup resources
 */
export async function closeEmbeddingProvider(): Promise<void> {
  if (_embeddingProvider?.close) {
    await _embeddingProvider.close();
    _embeddingProvider = null;
    logger.info('EmbeddingProvider closed');
  }
}
