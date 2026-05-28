/**
 * Search AI Constants
 *
 * Queue names, status enums, and defaults shared across all search tiers.
 */

// ─── BullMQ Queue Names ─────────────────────────────────────────────────────

export const QUEUE_INGESTION = 'search-ingestion';
export const QUEUE_EXTRACTION = 'search-extraction';
export const QUEUE_DOCLING_EXTRACTION = 'search-docling-extraction';
export const QUEUE_WORKFLOW_DOCLING_EXTRACTION = 'workflow-docling-extraction';
export const QUEUE_PAGE_PROCESSING = 'search-page-processing';
export const QUEUE_TREE_BUILDING = 'search-tree-building';
export const QUEUE_CANONICAL_MAP = 'search-canonical-map';
export const QUEUE_ENRICHMENT = 'search-enrichment';
export const QUEUE_EMBEDDING = 'search-embedding';
export const QUEUE_MULTIMODAL = 'search-multimodal';
export const QUEUE_QUESTION_SYNTHESIS = 'search-question-synthesis';
export const QUEUE_SCOPE_CLASSIFICATION = 'search-scope-classification';
export const QUEUE_VISUAL_ENRICHMENT = 'search-visual-enrichment';
export const QUEUE_CLEANUP = 'search-cleanup';
export const QUEUE_SCHEMA_SYNC = 'search-schema-sync';
export const QUEUE_SCHEMA_DISCOVERY = 'search-schema-discovery';
export const QUEUE_FIELD_MAPPING_SUGGESTION = 'search-field-mapping-suggestion';
export const QUEUE_INTELLIGENCE_CRAWL = 'intelligence-crawl';

// ─── IdP Sync Queues (Phase 2B: IdP Authentication) ─────────────────────────

export const QUEUE_AZUREAD_USER_SYNC = 'search-azuread-user-sync';
export const QUEUE_AZUREAD_GROUP_SYNC = 'search-azuread-group-sync';
export const QUEUE_OKTA_USER_SYNC = 'search-okta-user-sync';
export const QUEUE_OKTA_GROUP_SYNC = 'search-okta-group-sync';
export const QUEUE_GOOGLE_USER_SYNC = 'search-google-user-sync';
export const QUEUE_GOOGLE_GROUP_SYNC = 'search-google-group-sync';

// ─── Index Status ────────────────────────────────────────────────────────────

export const IndexStatus = {
  CREATING: 'creating',
  ACTIVE: 'active',
  INDEXING: 'indexing',
  ERROR: 'error',
  DISABLED: 'disabled',
} as const;
export type IndexStatus = (typeof IndexStatus)[keyof typeof IndexStatus];

// ─── Source Status ───────────────────────────────────────────────────────────

export const SourceStatus = {
  CONFIGURING: 'configuring',
  PENDING: 'pending',
  SYNCING: 'syncing',
  ACTIVE: 'active',
  ERROR: 'error',
  DISABLED: 'disabled',
} as const;
export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus];

// ─── Document Status ─────────────────────────────────────────────────────────

export const DocumentStatus = {
  PENDING: 'pending',
  EXTRACTING: 'extracting',
  EXTRACTED: 'extracted',
  ENRICHING: 'enriching',
  ENRICHED: 'enriched',
  EMBEDDING: 'embedding',
  INDEXED: 'indexed',
  ERROR: 'error',
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

// ─── Chunk Status ────────────────────────────────────────────────────────────

export const ChunkStatus = {
  PENDING: 'pending',
  EMBEDDED: 'embedded',
  INDEXED: 'indexed',
  FILTERED: 'filtered',
  ERROR: 'error',
} as const;
export type ChunkStatus = (typeof ChunkStatus)[keyof typeof ChunkStatus];

// ─── Schema Status ───────────────────────────────────────────────────────────

export const SchemaStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  DEPRECATED: 'deprecated',
} as const;
export type SchemaStatus = (typeof SchemaStatus)[keyof typeof SchemaStatus];

// ─── Mapping Status ──────────────────────────────────────────────────────────

export const MappingStatus = {
  SUGGESTED: 'suggested',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
} as const;
export type MappingStatus = (typeof MappingStatus)[keyof typeof MappingStatus];

// ─── Schema Change Types ─────────────────────────────────────────────────────

export const SchemaChangeType = {
  FIELD_ADDED: 'field_added',
  FIELD_REMOVED: 'field_removed',
  FIELD_TYPE_CHANGED: 'field_type_changed',
  ENUM_VALUE_ADDED: 'enum_value_added',
  ENUM_VALUE_REMOVED: 'enum_value_removed',
} as const;
export type SchemaChangeType = (typeof SchemaChangeType)[keyof typeof SchemaChangeType];

// ─── Review Status ───────────────────────────────────────────────────────────

export const ReviewStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DISMISSED: 'dismissed',
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

// ─── Vocabulary Status ───────────────────────────────────────────────────────

export const VocabularyStatus = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  DEPRECATED: 'deprecated',
} as const;
export type VocabularyStatus = (typeof VocabularyStatus)[keyof typeof VocabularyStatus];

// ─── Query Types ─────────────────────────────────────────────────────────────

export const QueryType = {
  VECTOR: 'vector',
  STRUCTURED: 'structured',
  AGGREGATE: 'aggregate',
  HYBRID: 'hybrid',
  SUGGEST: 'suggest',
  SIMILAR: 'similar',
} as const;
export type QueryType = (typeof QueryType)[keyof typeof QueryType];

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
export const DEFAULT_CHUNK_SIZE = 1024;
export const DEFAULT_CHUNK_OVERLAP = 128;
export const DEFAULT_TOP_K = 10;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
export const DEFAULT_INGESTION_TIMEOUT_MS = 300_000;

// ─── Ingestion Pipeline Stages ───────────────────────────────────────────────

export const IngestionStage = {
  INGEST: 'ingest',
  EXTRACT: 'extract',
  CANONICAL_MAP: 'canonical_map',
  CHUNK: 'chunk',
  ENRICH: 'enrich',
  EMBED: 'embed',
} as const;
export type IngestionStage = (typeof IngestionStage)[keyof typeof IngestionStage];
