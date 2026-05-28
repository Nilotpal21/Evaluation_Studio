/**
 * SearchAI Configuration
 *
 * Thin wrapper around @agent-platform/config.
 * Composes the base config schema with ingestion-specific extensions.
 */

import { z } from 'zod';
import {
  composeConfigSchema,
  createConfigLoader,
  validateProductionConfig,
  type BaseAppConfig,
} from '@agent-platform/config';

// =============================================================================
// SEARCHAI-SPECIFIC EXTENSIONS
// =============================================================================

const StorageConfigSchema = z.object({
  /** Storage backend provider */
  provider: z.enum(['local', 's3', 'minio']).default('local'),
  /** Storage bucket or container name */
  bucket: z.string().default('abl-platform-documents'),
  /** Cloud region (S3) */
  region: z.string().optional(),
  /** Custom endpoint (MinIO, S3-compatible) */
  endpoint: z.string().optional(),
  /** Local filesystem base path for 'local' provider */
  basePath: z.string().default('./uploads'),
  /** Explicit AWS access key (overrides default credential chain) */
  accessKeyId: z.string().optional(),
  /** Explicit AWS secret key (overrides default credential chain) */
  secretAccessKey: z.string().optional(),
});

const IngestionConfigSchema = z.object({
  /** Number of documents to process in a single batch */
  batchSize: z.coerce.number().int().positive().default(100),
  /** Maximum concurrent ingestion jobs */
  maxConcurrentJobs: z.coerce.number().int().positive().default(5),
  /** Timeout for content extraction (ms) */
  extractionTimeoutMs: z.coerce.number().int().positive().default(30000),
  /** Number of embeddings to generate per batch */
  embeddingBatchSize: z.coerce.number().int().positive().default(50),
});

const VectorStoreConfigSchema = z.object({
  /** Vector store provider (opensearch, qdrant, pinecone, pgvector) */
  provider: z.enum(['opensearch', 'qdrant', 'pinecone', 'pgvector']).default('opensearch'),
  /** Vector store URL */
  url: z.string().default('http://localhost:9200'),
  /** Vector store API key */
  apiKey: z.string().optional(),
  /** Request timeout in milliseconds */
  timeoutMs: z.coerce.number().int().positive().default(30_000),
});

const EmbeddingConfigSchema = z.object({
  /** Embedding provider (openai, cohere, bge-m3, azure, custom) */
  provider: z.enum(['openai', 'cohere', 'bge-m3', 'azure', 'custom']).default('bge-m3'),
  /** Embedding model name */
  model: z.string().default('bge-m3'),
  /** Embedding vector dimensions */
  dimensions: z.coerce.number().int().positive().default(1024),
  /** Base URL for custom embedding provider (e.g., BGE-M3 TEI service) */
  baseUrl: z.string().optional(),
  /** Maximum batch size for embedding requests */
  maxBatchSize: z.coerce.number().int().positive().default(32),
  /** Request timeout in milliseconds */
  timeoutMs: z.coerce.number().int().positive().default(60_000),
});

const KnowledgeGraphConfigSchema = z.object({
  /** Enable knowledge graph extraction */
  enabled: z.coerce.boolean().default(true),
  /** Neo4j connection URI */
  uri: z.string().default('neo4j://localhost:7687'),
  /** Neo4j username */
  username: z.string().default('neo4j'),
  /** Neo4j password */
  password: z.string().default('abl_dev_password'),
  /** Neo4j database name */
  database: z.string().default('neo4j'),
  /** Neo4j maximum connection pool size (100 recommended for 11-worker production load) */
  neo4jMaxPoolSize: z.coerce.number().int().positive().default(100),
  /** Entity extraction method (regex, compromise, hybrid) */
  entityExtractionMethod: z.enum(['regex', 'compromise', 'hybrid']).default('hybrid'),
  /** Enable co-occurrence analysis */
  enableCoOccurrence: z.coerce.boolean().default(true),
  /** Co-occurrence window size (chunks within N distance) */
  coOccurrenceWindow: z.coerce.number().int().positive().default(5),
  /** Minimum IDF threshold for co-occurrence edges */
  minIdfThreshold: z.coerce.number().positive().default(1.5),
});

const MultiModalConfigSchema = z.object({
  /** Enable multi-modal enrichment (images, tables, charts) */
  enabled: z.coerce.boolean().default(false),
  /** Vision provider (openai, anthropic) */
  visionProvider: z.enum(['openai', 'anthropic']).default('openai'),
  /** Vision API key (optional - if not provided, skip vision processing) */
  visionApiKey: z.string().optional(),
  /** Custom vision API endpoint (for custom provider) */
  customVisionEndpoint: z.string().optional(),
  /** Vision model name */
  visionModel: z.string().default('gpt-4-vision-preview'),
  /** LLM provider for table summarization */
  tableSummarizerProvider: z.enum(['openai', 'anthropic']).default('anthropic'),
  /** LLM API key for table summarization */
  tableSummarizerApiKey: z.string().optional(),
  /** Table summarizer model */
  tableSummarizerModel: z.string().default('claude-3-5-haiku-20241022'),
  /** Enable image description */
  enableImageDescription: z.coerce.boolean().default(true),
  /** Enable table summarization */
  enableTableSummarization: z.coerce.boolean().default(true),
  /** Enable chart analysis */
  enableChartAnalysis: z.coerce.boolean().default(true),
  /** Maximum image size in bytes (default 20MB) */
  maxImageSizeBytes: z.coerce.number().int().positive().default(20_971_520),
  /** Maximum table size in bytes (default 100KB) */
  maxTableSizeBytes: z.coerce.number().int().positive().default(102_400),
  /** Rate limit: max requests per minute */
  rateLimitPerMinute: z.coerce.number().int().positive().default(60),
});

const TreeBuilderConfigSchema = z.object({
  /** Enable adaptive tree building */
  enabled: z.coerce.boolean().default(false),
  /** LLM provider for summary generation */
  summaryProvider: z.enum(['openai', 'anthropic']).default('openai'),
  /** LLM API key for summary generation */
  summaryApiKey: z.string().optional(),
  /** Summary generation model */
  summaryModel: z.string().default('gpt-4o-mini'),
  /** Maximum tokens for summaries */
  summaryMaxTokens: z.coerce.number().int().positive().default(200),
  /** Target chunk size in tokens */
  targetChunkSize: z.coerce.number().int().positive().default(512),
  /** Maximum chunk size in tokens */
  maxChunkSize: z.coerce.number().int().positive().default(1024),
  /** Minimum chunk size in tokens */
  minChunkSize: z.coerce.number().int().positive().default(128),
  /** Similarity threshold for semantic grouping (0-1) */
  similarityThreshold: z.coerce.number().positive().max(1).default(0.7),
  /** Maximum tree depth */
  maxDepth: z.coerce.number().int().positive().default(4),
  /** Maximum children per node */
  maxChildrenPerNode: z.coerce.number().int().positive().default(10),
  /** Enable semantic splitting (requires embeddings) */
  enableSemanticSplitting: z.coerce.boolean().default(false),
});

// Dual-database: Content database config (KG feature)
const SearchAIContentDatabaseConfigSchema = z.object({
  /** MongoDB URI for SearchAI content database (chunks, documents) */
  uri: z.string().default('mongodb://abl_admin:abl_dev_password@localhost:27018/?authSource=admin'),
  /** Database name for SearchAI content */
  database: z.string().default('search_ai'),
  /** Maximum connection pool size */
  maxPoolSize: z.coerce.number().int().positive().default(50),
  /** Minimum connection pool size */
  minPoolSize: z.coerce.number().int().positive().default(10),
  /** Server selection timeout (ms) */
  serverSelectionTimeoutMs: z.coerce.number().int().positive().default(30000),
  /** Socket timeout (ms) */
  socketTimeoutMs: z.coerce.number().int().positive().default(60000),
});
// =============================================================================
// LLM FEATURE CONFIGS REMOVED
// =============================================================================
//
// Progressive summarization, question synthesis, and scope classification
// are now configured PER-INDEX via SearchIndex.llmConfig.
//
// This ensures dev and prod use the same configuration method (no env var fallback).
// See: packages/database/src/models/search-index.model.ts (llmConfig field)
// See: apps/search-ai/src/services/llm-config/resolver.ts (resolution logic)
//
// Credential fallback (ANTHROPIC_API_KEY, etc.) is OK for dev/testing.

// =============================================================================
// COMPOSED SCHEMA
// =============================================================================

export const SearchAIConfigSchema = composeConfigSchema({
  storage: StorageConfigSchema.default({}),
  ingestion: IngestionConfigSchema.default({}),
  vectorStore: VectorStoreConfigSchema.default({}),
  embedding: EmbeddingConfigSchema.default({}),
  knowledgeGraph: KnowledgeGraphConfigSchema.default({}),
  multiModal: MultiModalConfigSchema.default({}),
  treeBuilder: TreeBuilderConfigSchema.default({}),
  // Dual-database: Content DB config
  searchaiContentDb: SearchAIContentDatabaseConfigSchema.default({}),
  // Progressive summarization, question synthesis, and scope classification
  // are now per-index config only (SearchIndex.llmConfig)
});

export type SearchAIConfig = z.infer<typeof SearchAIConfigSchema>;

// =============================================================================
// CONFIG LOADER
// =============================================================================

const SEARCH_AI_ENV_MAPPING = {
  // Storage
  STORAGE_PROVIDER: 'storage.provider',
  STORAGE_BUCKET: 'storage.bucket',
  STORAGE_REGION: 'storage.region',
  STORAGE_ENDPOINT: 'storage.endpoint',
  STORAGE_BASE_PATH: 'storage.basePath',
  AWS_ACCESS_KEY_ID: 'storage.accessKeyId',
  AWS_SECRET_ACCESS_KEY: 'storage.secretAccessKey',

  // Ingestion
  INGESTION_BATCH_SIZE: 'ingestion.batchSize',
  INGESTION_MAX_CONCURRENT_JOBS: 'ingestion.maxConcurrentJobs',
  INGESTION_EXTRACTION_TIMEOUT_MS: 'ingestion.extractionTimeoutMs',
  INGESTION_EMBEDDING_BATCH_SIZE: 'ingestion.embeddingBatchSize',

  // Vector Store
  VECTOR_STORE_PROVIDER: 'vectorStore.provider',
  VECTOR_STORE_URL: 'vectorStore.url',
  VECTOR_STORE_API_KEY: 'vectorStore.apiKey',
  VECTOR_STORE_TIMEOUT_MS: 'vectorStore.timeoutMs',

  // Embedding
  EMBEDDING_PROVIDER: 'embedding.provider',
  EMBEDDING_MODEL: 'embedding.model',
  EMBEDDING_DIMENSIONS: 'embedding.dimensions',
  EMBEDDING_BASE_URL: 'embedding.baseUrl',
  EMBEDDING_MAX_BATCH_SIZE: 'embedding.maxBatchSize',
  EMBEDDING_TIMEOUT_MS: 'embedding.timeoutMs',

  // Knowledge Graph
  KNOWLEDGE_GRAPH_ENABLED: 'knowledgeGraph.enabled',
  NEO4J_URI: 'knowledgeGraph.uri',
  NEO4J_USERNAME: 'knowledgeGraph.username',
  NEO4J_PASSWORD: 'knowledgeGraph.password',
  NEO4J_DATABASE: 'knowledgeGraph.database',
  NEO4J_MAX_POOL_SIZE: 'knowledgeGraph.neo4jMaxPoolSize',
  KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD: 'knowledgeGraph.entityExtractionMethod',
  KNOWLEDGE_GRAPH_ENABLE_COOCCURRENCE: 'knowledgeGraph.enableCoOccurrence',
  KNOWLEDGE_GRAPH_COOCCURRENCE_WINDOW: 'knowledgeGraph.coOccurrenceWindow',
  KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD: 'knowledgeGraph.minIdfThreshold',

  // Multi-Modal
  MULTIMODAL_ENABLED: 'multiModal.enabled',
  MULTIMODAL_VISION_PROVIDER: 'multiModal.visionProvider',
  MULTIMODAL_VISION_API_KEY: 'multiModal.visionApiKey',
  MULTIMODAL_CUSTOM_VISION_ENDPOINT: 'multiModal.customVisionEndpoint',
  MULTIMODAL_VISION_MODEL: 'multiModal.visionModel',
  MULTIMODAL_TABLE_SUMMARIZER_PROVIDER: 'multiModal.tableSummarizerProvider',
  MULTIMODAL_TABLE_SUMMARIZER_API_KEY: 'multiModal.tableSummarizerApiKey',
  MULTIMODAL_TABLE_SUMMARIZER_MODEL: 'multiModal.tableSummarizerModel',
  MULTIMODAL_ENABLE_IMAGE_DESCRIPTION: 'multiModal.enableImageDescription',
  MULTIMODAL_ENABLE_TABLE_SUMMARIZATION: 'multiModal.enableTableSummarization',
  MULTIMODAL_ENABLE_CHART_ANALYSIS: 'multiModal.enableChartAnalysis',
  MULTIMODAL_MAX_IMAGE_SIZE_BYTES: 'multiModal.maxImageSizeBytes',
  MULTIMODAL_MAX_TABLE_SIZE_BYTES: 'multiModal.maxTableSizeBytes',
  MULTIMODAL_RATE_LIMIT_PER_MINUTE: 'multiModal.rateLimitPerMinute',

  // Tree Builder
  TREE_BUILDER_ENABLED: 'treeBuilder.enabled',
  TREE_BUILDER_SUMMARY_PROVIDER: 'treeBuilder.summaryProvider',
  TREE_BUILDER_SUMMARY_API_KEY: 'treeBuilder.summaryApiKey',
  TREE_BUILDER_SUMMARY_MODEL: 'treeBuilder.summaryModel',
  TREE_BUILDER_SUMMARY_MAX_TOKENS: 'treeBuilder.summaryMaxTokens',
  TREE_BUILDER_TARGET_CHUNK_SIZE: 'treeBuilder.targetChunkSize',
  TREE_BUILDER_MAX_CHUNK_SIZE: 'treeBuilder.maxChunkSize',
  TREE_BUILDER_MIN_CHUNK_SIZE: 'treeBuilder.minChunkSize',
  TREE_BUILDER_SIMILARITY_THRESHOLD: 'treeBuilder.similarityThreshold',
  TREE_BUILDER_MAX_DEPTH: 'treeBuilder.maxDepth',
  TREE_BUILDER_MAX_CHILDREN_PER_NODE: 'treeBuilder.maxChildrenPerNode',
  TREE_BUILDER_ENABLE_SEMANTIC_SPLITTING: 'treeBuilder.enableSemanticSplitting',

  // SearchAI Content Database (separate from platform database) - Dual-DB
  SEARCHAI_CONTENT_URI: 'searchaiContentDb.uri',
  SEARCHAI_CONTENT_DATABASE: 'searchaiContentDb.database',
  SEARCHAI_CONTENT_MAX_POOL_SIZE: 'searchaiContentDb.maxPoolSize',
  SEARCHAI_CONTENT_MIN_POOL_SIZE: 'searchaiContentDb.minPoolSize',
  SEARCHAI_CONTENT_SERVER_SELECTION_TIMEOUT_MS: 'searchaiContentDb.serverSelectionTimeoutMs',
  SEARCHAI_CONTENT_SOCKET_TIMEOUT_MS: 'searchaiContentDb.socketTimeoutMs',
  // Progressive Summarization, Question Synthesis, and Scope Classification
  // are now per-index config only (SearchIndex.llmConfig) - no global env vars
};

function logSearchAIConfigSummary(cfg: unknown): void {
  const c = cfg as SearchAIConfig;
  console.log(`
[Config] SearchAI configuration loaded:
  Environment:              ${c.env}
  Server:                   ${c.server.host}:${c.server.port}
  Database:                 ${c.database.url ? 'configured' : 'not configured'}
  JWT Secret:               ${c.jwt.secret.length >= 32 ? 'configured (secure)' : 'WARNING: using default'}
  Redis:                    ${c.redis.enabled ? `enabled (${c.redis.url || 'localhost'})` : 'disabled'}
  Storage:                  ${c.storage.provider} (${c.storage.provider === 'local' ? `basePath: ${c.storage.basePath}` : `bucket: ${c.storage.bucket}`})
  Ingestion:                batch=${c.ingestion.batchSize}, concurrency=${c.ingestion.maxConcurrentJobs}
  Vector Store:             ${c.vectorStore.provider} (${c.vectorStore.url})
  Embedding:                ${c.embedding.provider}/${c.embedding.model} (${c.embedding.dimensions}d)
  Knowledge Graph:          ${c.knowledgeGraph.enabled ? `enabled (${c.knowledgeGraph.uri})` : 'disabled'}
  Multi-Modal:              ${c.multiModal.enabled ? `enabled (vision: ${c.multiModal.visionProvider}, tables: ${c.multiModal.tableSummarizerProvider})` : 'disabled'}
  Tree Builder:             ${c.treeBuilder.enabled ? `enabled (model: ${c.treeBuilder.summaryModel}, depth: ${c.treeBuilder.maxDepth})` : 'disabled'}

  Note: Progressive Summarization, Question Synthesis, and Scope Classification
        are now configured per-index via SearchIndex.llmConfig (no global env vars)
`);
}

const loader = createConfigLoader(SearchAIConfigSchema, {
  envMapping: SEARCH_AI_ENV_MAPPING,
  productionChecks: (cfg) => validateProductionConfig(cfg as BaseAppConfig).map((w) => w.message),
  logSummary: logSearchAIConfigSummary,
});

export const loadConfig = loader.loadConfig;
export const getConfig = loader.getConfig;
export const isConfigLoaded = loader.isConfigLoaded;
export const reloadConfig = loader.reloadConfig;
export const getConfigMeta = loader.getConfigMeta;

// Re-export vault types for backward compatibility
export type { VaultType, VaultProvider } from '@agent-platform/config';
