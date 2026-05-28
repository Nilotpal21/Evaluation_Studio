/**
 * Search Index Model
 *
 * Represents a search index that holds embeddings and metadata for a set of documents.
 * Each index belongs to a tenant and project, with configurable embedding, chunking,
 * and vector store settings.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

/**
 * LLM configuration for enrichment use cases
 *
 * Optional per-index overrides for LLM-powered features.
 * Uses smart defaults and inherits tenant LLM credentials if not specified.
 */
export interface SearchIndexLLMConfig {
  /** Global toggle for all LLM features */
  enabled?: boolean;

  /** Per-use-case configuration */
  useCases?: {
    /** Progressive Summarization: Generate context-aware chunk summaries */
    progressiveSummarization?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      maxTokens?: number;
      enableDocumentSummary?: boolean;
      documentSummaryMaxTokens?: number;
    };

    /** Question Synthesis: Generate questions for retrieval */
    questionSynthesis?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      questionsPerChunk?: number;
      maxTokens?: number;
      enableEmbedding?: boolean;
      enableDocumentQuestions?: boolean;
      documentQuestionsCount?: number;
    };

    /** Vision Processing: Analyze screenshots and images */
    vision?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      maxTokens?: number;
      analyzeScreenshots?: boolean;
      analyzeImages?: boolean;
      enhanceTableContinuations?: boolean;
    };

    /** Multimodal: Image/table/chart analysis */
    multimodal?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      enableImageDescription?: boolean;
      enableTableSummarization?: boolean;
      enableChartAnalysis?: boolean;
    };

    /** Knowledge Graph: Entity and relationship extraction */
    knowledgeGraph?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      modelId?: string | null;
      configuredAt?: Date | null;
      inheritedFrom?: string | null;
      enableCoOccurrence?: boolean;
    };

    /** Tree Builder: Adaptive hierarchical document chunking */
    treeBuilder?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      maxTokens?: number;
      targetChunkSize?: number;
      maxChunkSize?: number;
      minChunkSize?: number;
      similarityThreshold?: number;
      maxDepth?: number;
      maxChildrenPerNode?: number;
      enableSemanticSplitting?: boolean;
    };

    /** Scope Classification: Classify document scope and relevance */
    scopeClassification?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      maxTokens?: number;
    };

    /** Field Mapping Suggestions: LLM-assisted source→canonical mapping */
    mapping_suggestion?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      maxTokens?: number;
    };

    /** Vocabulary Generation: Enrich domain vocabulary with aliases and descriptions */
    vocabularyGeneration?: {
      enabled?: boolean;
      modelTier?: 'fast' | 'balanced' | 'powerful';
      maxTokens?: number;
    };
  };
}

export interface ICitationConfig {
  /** Whether citations are enabled for this index. Default: true */
  enabled: boolean;
  /** How file upload links are generated */
  linkMode: 'direct' | 'time_limited' | 'click_limited' | 'disabled';
  /** TTL for time-limited/click-limited links in seconds. Default: 3600 */
  linkTtlSeconds: number;
  /** Max clicks for click-limited links. Default: 5 */
  maxClicks: number;
}

export interface ISearchIndex {
  _id: string;
  tenantId: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Embedding model identifier */
  embeddingModel: string;
  /** Embedding vector dimensions */
  embeddingDimensions: number;
  /**
   * Token-based chunking strategy (optional)
   *
   * When null/undefined: Uses page-based chunking (Docling) - DEFAULT
   *   - 1 page = 1 chunk
   *   - Preserves document structure (tables, images, headings)
   *   - Best for structured documents (PDF, DOCX)
   *
   * When set: Uses token-based chunking (LlamaIndex) with specified strategy
   *   - Splits text into token-sized chunks with overlap
   *   - Best for plain text files or custom chunking needs
   */
  tokenChunkStrategy?: {
    method: 'fixed' | 'semantic' | 'sliding_window';
    chunkSize: number;
    chunkOverlap: number;
    separator?: string;
  } | null;
  /** Vector store backend configuration */
  vectorStore: {
    provider: string;
    collectionName: string;
    connectionConfig?: any;
  };
  /**
   * Active vector index name (versioned per embedding dimension change)
   * Format: search-vectors-{indexId}-v{version}
   * Example: search-vectors-019d4416-v2
   */
  activeVectorIndex?: string | null;
  /**
   * Vector index version history
   * Tracks all vector indices created for this index when embedding dimensions changed
   */
  vectorIndexHistory?: Array<{
    indexName: string;
    dimensions: number;
    provider: string;
    model: string;
    createdAt: Date;
    deletedAt?: Date;
  }>;
  /** Default search parameters */
  searchDefaults: {
    topK: number;
    similarityThreshold: number;
    includeMetadata: boolean;
    includeContent: boolean;
    reranker?: {
      provider: string;
      model?: string;
      topN?: number;
    };
    responseFields?: string[];
  };
  /**
   * LLM configuration for enrichment features (optional)
   *
   * When null/undefined, uses smart defaults based on use case.
   * Advanced users can override per use case.
   */
  llmConfig?: SearchIndexLLMConfig | null;
  /**
   * Query pipeline LLM configuration (optional)
   *
   * Controls which LLM model is used for vocabulary resolution and query
   * classification at query time. Defaults to auto-select best fast-tier model.
   *
   * - enabled: true → vocabulary resolution + LLM classification active
   * - enabled: false → no LLM calls at query time, vector/hybrid only
   * - modelId: null + autoSelect: true → system picks best fast-tier model
   * - modelId: 'tm_x' + autoSelect: false → pinned to specific model
   * - null → legacy / not yet configured (auto-select on first query)
   */
  queryLLMConfig?: {
    enabled: boolean;
    modelId: string | null;
    autoSelect: boolean;
    preferredTier: 'fast' | 'balanced' | 'powerful';
  } | null;
  /**
   * JSON field selection config (optional)
   *
   * Stores which JSON fields the user marked as "Important" for
   * embedding and vocabulary. Set after the first JSON upload when
   * the user completes the field selection dialog.
   *
   * - Selected string fields → included in chunk text for embedding
   * - Selected number/date fields → stored as canonicalMetadata for filtering
   * - Unselected fields → stored in metadata but not embedded or in vocab
   */
  jsonFieldConfig?: {
    version: number;
    fields: Array<{
      fieldPath: string;
      fieldType: string;
      selected: boolean;
      sampleValues: string[];
      maxLength: number;
      /** User's manual mapping override (when they change the auto-suggest) */
      mappingOverride?: string;
      /** Final resolved canonical mapping — persisted so subsequent uploads
       *  restore the user's chosen mapping without re-running the LLM pipeline */
      canonicalMapping?: string;
    }>;
    autoSuggestApplied: boolean;
    updatedAt: Date;
  } | null;
  /**
   * Whether this index contains structured data (CSV/Excel) stored in ClickHouse.
   * Set to true by the structured-data-ingestion worker, false when last table is removed.
   * Used by the query pipeline to skip text-to-SQL enrichment when no structured data exists.
   */
  hasStructuredData?: boolean;
  /** Citation configuration for this index */
  citationConfig?: ICitationConfig | null;
  status: string;
  documentCount: number;
  chunkCount: number;
  sourceCount: number;
  lastIndexedAt: Date | null;
  indexError: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SearchIndexSchema = new Schema<ISearchIndex>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    slug: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    embeddingModel: { type: String, required: true, default: 'text-embedding-3-small' },
    embeddingDimensions: { type: Number, required: true, default: 1536 },
    tokenChunkStrategy: {
      type: new Schema(
        {
          method: {
            type: String,
            required: true,
            enum: ['fixed', 'semantic', 'sliding_window'],
          },
          chunkSize: { type: Number, required: true },
          chunkOverlap: { type: Number, required: true },
          separator: { type: String },
        },
        { _id: false },
      ),
      required: false,
      default: null,
    },
    vectorStore: {
      type: new Schema(
        {
          provider: { type: String, required: true, default: 'qdrant' },
          collectionName: { type: String, required: true },
          connectionConfig: { type: Schema.Types.Mixed },
        },
        { _id: false },
      ),
      required: true,
    },
    activeVectorIndex: { type: String, default: null },
    vectorIndexHistory: {
      type: [
        new Schema(
          {
            indexName: { type: String, required: true },
            dimensions: { type: Number, required: true },
            provider: { type: String, required: true },
            model: { type: String, required: true },
            createdAt: { type: Date, default: () => new Date() },
            deletedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: () => [],
    },
    searchDefaults: {
      type: new Schema(
        {
          topK: { type: Number, required: true, default: 10 },
          similarityThreshold: { type: Number, required: true, default: 0.2 },
          includeMetadata: { type: Boolean, default: true },
          includeContent: { type: Boolean, default: true },
          reranker: {
            type: new Schema(
              {
                provider: { type: String, required: true },
                model: { type: String },
                topN: { type: Number },
              },
              { _id: false },
            ),
          },
          responseFields: { type: [String], default: undefined },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({
        topK: 10,
        similarityThreshold: 0.2,
        includeMetadata: true,
        includeContent: true,
      }),
    },
    llmConfig: {
      type: new Schema(
        {
          enabled: { type: Boolean },
          useCases: {
            type: new Schema(
              {
                progressiveSummarization: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      maxTokens: { type: Number },
                      enableDocumentSummary: { type: Boolean },
                      documentSummaryMaxTokens: { type: Number },
                    },
                    { _id: false },
                  ),
                },
                questionSynthesis: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      questionsPerChunk: { type: Number },
                      maxTokens: { type: Number },
                      enableEmbedding: { type: Boolean },
                      enableDocumentQuestions: { type: Boolean },
                      documentQuestionsCount: { type: Number },
                    },
                    { _id: false },
                  ),
                },
                vision: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      maxTokens: { type: Number },
                      analyzeScreenshots: { type: Boolean },
                      analyzeImages: { type: Boolean },
                      enhanceTableContinuations: { type: Boolean },
                    },
                    { _id: false },
                  ),
                },
                multimodal: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      enableImageDescription: { type: Boolean },
                      enableTableSummarization: { type: Boolean },
                      enableChartAnalysis: { type: Boolean },
                    },
                    { _id: false },
                  ),
                },
                knowledgeGraph: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      modelId: { type: String, default: null },
                      configuredAt: { type: Date, default: null },
                      inheritedFrom: { type: String, default: null },
                      enableCoOccurrence: { type: Boolean },
                    },
                    { _id: false },
                  ),
                },
                treeBuilder: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      maxTokens: { type: Number },
                      targetChunkSize: { type: Number },
                      maxChunkSize: { type: Number },
                      minChunkSize: { type: Number },
                      similarityThreshold: { type: Number },
                      maxDepth: { type: Number },
                      maxChildrenPerNode: { type: Number },
                      enableSemanticSplitting: { type: Boolean },
                    },
                    { _id: false },
                  ),
                },
                scopeClassification: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      maxTokens: { type: Number },
                    },
                    { _id: false },
                  ),
                },
                mapping_suggestion: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      maxTokens: { type: Number },
                    },
                    { _id: false },
                  ),
                },
                vocabularyGeneration: {
                  type: new Schema(
                    {
                      enabled: { type: Boolean },
                      modelTier: { type: String, enum: ['fast', 'balanced', 'powerful'] },
                      preferredModelId: { type: String },
                      maxTokens: { type: Number },
                    },
                    { _id: false },
                  ),
                },
              },
              { _id: false },
            ),
          },
        },
        { _id: false },
      ),
      default: null,
    },
    queryLLMConfig: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          modelId: { type: String, default: null },
          autoSelect: { type: Boolean, default: true },
          preferredTier: {
            type: String,
            enum: ['fast', 'balanced', 'powerful'],
            default: 'fast',
          },
        },
        { _id: false },
      ),
      default: () => ({ enabled: false, modelId: null, autoSelect: true, preferredTier: 'fast' }),
    },
    jsonFieldConfig: {
      type: new Schema(
        {
          version: { type: Number, required: true, default: 1 },
          fields: {
            type: [
              new Schema(
                {
                  fieldPath: { type: String, required: true },
                  fieldType: { type: String, required: true },
                  selected: { type: Boolean, required: true },
                  sampleValues: { type: [String], default: [] },
                  maxLength: { type: Number, default: 0 },
                  /** User's manual mapping override (when they change the auto-suggest) */
                  mappingOverride: { type: String, default: undefined },
                  /** Final resolved canonical mapping — persisted so subsequent uploads
                   *  restore the user's chosen mapping without re-running the LLM pipeline */
                  canonicalMapping: { type: String, default: undefined },
                },
                { _id: false },
              ),
            ],
            default: [],
          },
          autoSuggestApplied: { type: Boolean, default: false },
          updatedAt: { type: Date, default: () => new Date() },
        },
        { _id: false },
      ),
      default: null,
    },
    citationConfig: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: true },
          linkMode: {
            type: String,
            enum: ['direct', 'time_limited', 'click_limited', 'disabled'],
            default: 'direct',
          },
          linkTtlSeconds: { type: Number, default: 3600, min: 60, max: 604800 },
          maxClicks: { type: Number, default: 5, min: 1, max: 100 },
        },
        { _id: false },
      ),
      default: null,
    },
    hasStructuredData: { type: Boolean, default: false },
    status: { type: String, required: true, default: 'creating' },
    documentCount: { type: Number, default: 0 },
    chunkCount: { type: Number, default: 0 },
    sourceCount: { type: Number, default: 0 },
    lastIndexedAt: { type: Date, default: null },
    indexError: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'search_indexes' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SearchIndexSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

SearchIndexSchema.index({ tenantId: 1, projectId: 1, slug: 1 }, { unique: true });
SearchIndexSchema.index({ tenantId: 1, projectId: 1 });
SearchIndexSchema.index({ tenantId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const SearchIndex =
  (mongoose.models.SearchIndex as any) || model<ISearchIndex>('SearchIndex', SearchIndexSchema);
