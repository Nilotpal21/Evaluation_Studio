/**
 * Vector Store Factory
 *
 * Creates VectorStoreProvider instances based on configuration.
 */

import type { VectorStoreProvider } from './interface.js';
import { QdrantVectorStore, type QdrantConfig } from './qdrant.js';
import { OpenSearchVectorStore, type OpenSearchConfig } from './opensearch.js';

export interface VectorStoreFactoryConfig {
  provider: 'qdrant' | 'opensearch' | 'pinecone' | 'pgvector';
  url: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Create a vector store provider from configuration.
 * Currently supports Qdrant. Pinecone and pgvector can be added later.
 */
export function createVectorStore(config: VectorStoreFactoryConfig): VectorStoreProvider {
  switch (config.provider) {
    case 'qdrant':
      return new QdrantVectorStore({
        url: config.url,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      } satisfies QdrantConfig);

    case 'opensearch':
      return new OpenSearchVectorStore({
        url: config.url,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs,
      } satisfies OpenSearchConfig);

    case 'pinecone':
      throw new Error(
        'Pinecone provider not yet implemented. Install @pinecone-database/pinecone and add the implementation.',
      );

    case 'pgvector':
      throw new Error(
        'pgvector provider not yet implemented. Install pg and pgvector and add the implementation.',
      );

    default:
      throw new Error(`Unknown vector store provider: ${config.provider}`);
  }
}
