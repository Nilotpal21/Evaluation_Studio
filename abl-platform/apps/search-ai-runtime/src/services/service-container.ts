/**
 * Service Container - Simple DI for Search Services
 *
 * Initializes and provides singleton instances of services needed for
 * LLM-based vocabulary resolution and hybrid search query building.
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import {
  EmbeddingProvider,
  type EmbeddingProviderResolver,
} from '@agent-platform/search-ai-internal/embedding';
import { createVectorStore, type VectorStoreProvider } from '@agent-platform/search-ai-internal';
import { DynamicVocabularyResolver } from './vocabulary/dynamic-vocabulary-resolver.js';
import {
  HybridSearchBuilder,
  HYBRID_SEARCH_PIPELINE,
} from './hybrid-search/hybrid-search-builder.js';
import { createEmbeddingProviderResolver } from './embedding/embedding-provider-resolver-init.js';
import { CachedEmbeddingProvider } from './embedding/cached-provider.js';
import { AliasResolver, getAliasResolver } from './alias/alias-resolver.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('ServiceContainer');

/**
 * Service container for search services
 */
class ServiceContainer {
  private static instance: ServiceContainer | null = null;

  private llmClient: WorkerLLMClient | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private embeddingProviderResolver: EmbeddingProviderResolver | null = null;
  private vectorStoreProvider: VectorStoreProvider | null = null;
  private vocabularyResolver: DynamicVocabularyResolver | null = null;
  private searchBuilder: HybridSearchBuilder | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
    }
    return ServiceContainer.instance;
  }

  /**
   * Initialize services with dependencies
   */
  initialize(params: { llmClient: WorkerLLMClient; embeddingProvider: EmbeddingProvider }): void {
    logger.info('Initializing service container');

    // Store dependencies — wrap embedding provider with LRU cache to avoid
    // re-computing embeddings for repeated/similar queries (BGE-M3 on CPU: ~1.2s per embed)
    this.llmClient = params.llmClient;
    this.embeddingProvider = new CachedEmbeddingProvider(params.embeddingProvider, {
      maxSize: 500,
      ttlMs: 1000 * 60 * 30, // 30 min TTL
    });

    // Initialize embedding provider resolver for per-KB dynamic resolution
    this.embeddingProviderResolver = createEmbeddingProviderResolver();

    // Initialize vector store provider for query execution
    this.vectorStoreProvider = createVectorStore({
      provider:
        (process.env.VECTOR_STORE_PROVIDER as 'opensearch' | 'qdrant' | 'pinecone' | 'pgvector') ||
        'opensearch',
      url: process.env.VECTOR_STORE_URL || 'https://localhost:9200',
      apiKey: process.env.VECTOR_STORE_API_KEY,
      timeoutMs: process.env.VECTOR_STORE_TIMEOUT_MS
        ? parseInt(process.env.VECTOR_STORE_TIMEOUT_MS, 10)
        : undefined,
    });

    // Ensure the hybrid search pipeline exists in OpenSearch (fire-and-forget, non-blocking)
    if (this.vectorStoreProvider.ensureHybridSearchPipeline) {
      this.vectorStoreProvider
        .ensureHybridSearchPipeline(HYBRID_SEARCH_PIPELINE)
        .then(() =>
          logger.info('Hybrid search pipeline ensured', { pipeline: HYBRID_SEARCH_PIPELINE }),
        )
        .catch((error) =>
          logger.warn('Failed to ensure hybrid search pipeline (non-fatal)', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }

    // Initialize vocabulary resolver
    this.vocabularyResolver = new DynamicVocabularyResolver(this.llmClient);

    // Initialize hybrid search builder with embedding provider resolver
    this.searchBuilder = new HybridSearchBuilder(
      this.vocabularyResolver,
      this.embeddingProvider,
      this.embeddingProviderResolver,
    );

    logger.info('Service container initialized successfully');
  }

  /**
   * Get vocabulary resolver
   */
  getVocabularyResolver(): DynamicVocabularyResolver {
    if (!this.vocabularyResolver) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this.vocabularyResolver;
  }

  /**
   * Get hybrid search builder
   */
  getSearchBuilder(): HybridSearchBuilder {
    if (!this.searchBuilder) {
      throw new Error('ServiceContainer not initialized. Call initialize() first.');
    }
    return this.searchBuilder;
  }

  /**
   * Get pipeline options for constructing a unified QueryPipeline.
   * Returns the LLM-based services (dynamicVocabularyResolver, hybridSearchBuilder)
   * and vector store that enable all 4 query types and auto-classification.
   */
  getPipelineOptions(): {
    dynamicVocabularyResolver?: DynamicVocabularyResolver;
    hybridSearchBuilder?: HybridSearchBuilder;
    vectorStore?: VectorStoreProvider;
    embeddingProvider?: EmbeddingProvider;
    embeddingProviderResolver?: EmbeddingProviderResolver;
    aliasResolver?: AliasResolver;
  } {
    return {
      dynamicVocabularyResolver: this.vocabularyResolver ?? undefined,
      hybridSearchBuilder: this.searchBuilder ?? undefined,
      vectorStore: this.vectorStoreProvider ?? undefined,
      embeddingProvider: this.embeddingProvider ?? undefined,
      embeddingProviderResolver: this.embeddingProviderResolver ?? undefined,
      aliasResolver: getAliasResolver(),
    };
  }

  /**
   * Get embedding provider (needed for per-tenant query LLM stack creation)
   */
  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider;
  }

  /**
   * Get embedding provider resolver (needed for cache invalidation on config changes)
   */
  getEmbeddingProviderResolver(): EmbeddingProviderResolver | null {
    return this.embeddingProviderResolver;
  }

  /**
   * Check if container is initialized
   */
  isInitialized(): boolean {
    return this.searchBuilder !== null;
  }

  /**
   * Reset container (for testing)
   */
  reset(): void {
    this.llmClient = null;
    this.embeddingProvider = null;
    this.embeddingProviderResolver = null;
    this.vectorStoreProvider = null;
    this.vocabularyResolver = null;
    this.searchBuilder = null;
    logger.info('Service container reset');
  }
}

// Export singleton instance
export const serviceContainer = ServiceContainer.getInstance();
