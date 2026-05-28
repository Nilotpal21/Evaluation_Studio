/**
 * Embedding Services Exports
 *
 * Provides access to EmbeddingProvider for query-time embedding generation.
 */

export { getEmbeddingProvider, closeEmbeddingProvider } from './provider.js';
export { CachedEmbeddingProvider, type CacheOptions } from './cached-provider.js';
