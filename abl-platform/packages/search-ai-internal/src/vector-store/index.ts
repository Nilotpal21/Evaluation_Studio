/**
 * Vector Store — barrel exports
 */

export type {
  VectorStoreProvider,
  VectorRecord,
  VectorSearchParams,
  VectorSearchResult,
  CollectionConfig,
  CollectionInfo,
  MetadataIndexConfig,
} from './interface.js';

export { QdrantVectorStore, type QdrantConfig } from './qdrant.js';
export { OpenSearchVectorStore, type OpenSearchConfig, deriveShardConfig } from './opensearch.js';
export { createVectorStore, type VectorStoreFactoryConfig } from './factory.js';

// OpenSearch Mappings
export {
  VECTOR_INDEX_MAPPING,
  getVectorIndexMapping,
  getSharedIndexMapping,
  getDedicatedIndexMapping,
  FIELD_TYPES,
  DYNAMIC_SETTINGS,
} from './opensearch-mappings.js';

// Index Registry
export {
  configureIndexRegistryModels,
  sanitizeId,
  generateIndexName,
  getActiveSharedIndex,
  forceRotateSharedIndex,
  syncAllSharedIndexStats,
  resolveIndexForWrite,
  ensureIndexExists,
  getAppIndices,
  deleteAppIndices,
  deleteConnectorIndex,
  type SharedIndexConfig,
} from './index-registry.js';
