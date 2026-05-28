/**
 * Search Document Model
 *
 * Represents a single document ingested into a search index.
 * Tracks content hash for deduplication, extraction status, and enrichment results.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDocumentClassification {
  productScope: {
    primaryProduct: string;
    confidence: number;
    secondaryProducts: string[];
  };
  department: string;
  subDepartment?: string;
  category: string;
  classifiedAt: Date;
  classificationMethod: 'llm' | 'rule-based' | 'hybrid';
  model: string;
  escalatedToSonnet: boolean;
}

export interface IDocumentKGState {
  status: 'NOT_ENRICHED' | 'ENRICHED' | 'SKIPPED' | 'NEEDS_RECLASSIFICATION';
  enrichedAt?: Date;
  skippedReason?: 'NO_TAXONOMY' | 'KG_DISABLED';
  taxonomyVersion?: string;
  needsReclassification: boolean;
}

export interface IEntityInstance {
  /** Deduplicated entity instance ID (format: "attributeId:normalizedValue") */
  entityInstanceId: string;
  /** Attribute type (e.g., "interest_rate", "credit_limit") */
  type: string;
  /** Raw value as extracted (e.g., "15.99%", "$5,000") */
  rawValue: string;
  /** Normalized value for filtering (e.g., 15.99, 5000) */
  normalizedValue: string | number | boolean;
  /** Chunk IDs where this entity was found */
  chunkIds: string[];
}

export interface ISearchDocument {
  _id: string;
  tenantId: string;
  indexId: string;
  sourceId: string;
  /** Connector ID that ingested this document (null for direct uploads) */
  connectorId: string | null;
  /** SHA-256 content hash for deduplication */
  contentHash: string;
  /** Document name (filename or title) for display in UI */
  name: string | null;
  /** Original filename or URL */
  originalReference: string | null;
  /** MIME content type */
  contentType: string | null;
  /** Original content size in bytes */
  contentSizeBytes: number;
  /** Source URL (file:// for local, s3:// for S3, https:// for web) */
  sourceUrl: string | null;
  /** Public download URL (signed, time-limited) for external access */
  downloadUrl: string | null;
  /** Permanent internal file URL (API-key authenticated, no expiry) for citations */
  internalFileUrl: string | null;
  /** Extracted plain text */
  extractedText: string | null;
  /** Detected language */
  language: string | null;
  /** Extracted named entities */
  entities: Array<{ type: string; value: string; confidence: number }>;
  /** Short raw text snippet (first 500 chars) for UI display. For LLM summary, see metadata.documentSummary. */
  textPreview: string | null;
  /** Source-specific metadata (raw field values from connector) */
  sourceMetadata: any | null;
  /** Knowledge Graph: Product scope classification (Document-Level) */
  classification?: IDocumentClassification;
  /** Knowledge Graph: Entity instances (references to Neo4j deduplicated nodes) */
  entityInstances?: IEntityInstance[];
  /** Knowledge Graph: State tracking */
  metadata: {
    kgState?: IDocumentKGState;
    [key: string]: any;
  };
  /** Flow that processed this document (for reindexing: checkpoint 2 queries by flow) */
  flowId: string | null;
  status: string;
  /** Error message if processing failed */
  processingError: string | null;
  /** Number of chunks generated */
  chunkCount: number;
  /** Number of pages (for Docling-extracted documents) */
  pageCount?: number;
  /** Soft deletion flag (for delta sync @removed handling) */
  isDeleted: boolean;
  /** Timestamp when document was marked as deleted */
  deletedAt: Date | null;
  /** Timestamp when document was marked stale (URL disappeared between re-crawls). TTL-indexed for auto-cleanup. */
  staleAt?: Date | null;
  /** Timestamp when document was last verified as unchanged during a recrawl (content hash matched). */
  lastVerifiedAt?: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EntitySchema = new Schema(
  {
    type: { type: String, required: true },
    value: { type: String, required: true },
    confidence: { type: Number, required: true },
  },
  { _id: false },
);

const EntityInstanceSchema = new Schema(
  {
    entityInstanceId: { type: String, required: true },
    type: { type: String, required: true },
    rawValue: { type: String, required: true },
    normalizedValue: { type: Schema.Types.Mixed, required: true },
    chunkIds: [{ type: String }],
  },
  { _id: false },
);

const SearchDocumentSchema = new Schema<ISearchDocument>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    sourceId: { type: String, required: true },
    connectorId: { type: String, default: null },
    contentHash: { type: String, required: true },
    name: { type: String, default: null },
    originalReference: { type: String, default: null },
    contentType: { type: String, default: null },
    contentSizeBytes: { type: Number, default: 0 },
    sourceUrl: { type: String, default: null },
    downloadUrl: { type: String, default: null },
    internalFileUrl: { type: String, default: null },
    extractedText: { type: String, default: null },
    language: { type: String, default: null },
    entities: { type: [EntitySchema], default: [] },
    textPreview: { type: String, default: null },
    sourceMetadata: { type: Schema.Types.Mixed, default: null },
    classification: {
      type: {
        productScope: {
          primaryProduct: { type: String, required: true },
          confidence: { type: Number, required: true },
          secondaryProducts: [{ type: String }],
        },
        department: { type: String, required: true },
        subDepartment: { type: String },
        category: { type: String, required: true },
        classifiedAt: { type: Date, required: true },
        classificationMethod: {
          type: String,
          enum: ['llm', 'rule-based', 'hybrid'],
          required: true,
        },
        model: { type: String, required: true },
        escalatedToSonnet: { type: Boolean, required: true },
      },
      required: false,
      default: undefined,
    },
    entityInstances: {
      type: [EntityInstanceSchema],
      required: false,
      default: undefined,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    flowId: { type: String, default: null },
    status: { type: String, required: true, default: 'pending' },
    processingError: { type: String, default: null },
    chunkCount: { type: Number, default: 0 },
    pageCount: { type: Number, required: false },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    staleAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'search_documents' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SearchDocumentSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

SearchDocumentSchema.index({ indexId: 1, sourceId: 1 });
// Unique per source — different sources in the same index may legitimately
// have the same content hash (overlapping crawl URLs). Upload dedup uses a
// findOne query (document-upload.ts line ~294) and is unaffected.
SearchDocumentSchema.index({ indexId: 1, sourceId: 1, contentHash: 1 }, { unique: true });
SearchDocumentSchema.index({ indexId: 1, status: 1 });
SearchDocumentSchema.index({ tenantId: 1, indexId: 1 });
SearchDocumentSchema.index({ connectorId: 1, tenantId: 1 }); // Canonical mapping lookups
SearchDocumentSchema.index({ tenantId: 1, indexId: 1, flowId: 1 }, { sparse: true }); // Reindexing: checkpoint 2 queries
SearchDocumentSchema.index({ tenantId: 1, indexId: 1, isDeleted: 1 }); // For filtering deleted docs
SearchDocumentSchema.index({ isDeleted: 1, deletedAt: 1 }); // For cleanup job
SearchDocumentSchema.index({ 'sourceMetadata.crawlJobId': 1, tenantId: 1 }); // USP: pages-by-job queries

// Re-crawl stale document TTL: auto-delete 30 days after marked stale (O8)
SearchDocumentSchema.index(
  { staleAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days
    partialFilterExpression: { staleAt: { $type: 'date' } },
  },
);

// Knowledge Graph: KG state queries (enrichment status, re-classification)
SearchDocumentSchema.index(
  { tenantId: 1, indexId: 1, 'metadata.kgState.status': 1 },
  { sparse: true },
);
SearchDocumentSchema.index(
  {
    tenantId: 1,
    indexId: 1,
    'metadata.kgState.needsReclassification': 1,
    'metadata.kgState.taxonomyVersion': 1,
  },
  { sparse: true },
);

// Knowledge Graph: Classification queries (product scope filtering)
SearchDocumentSchema.index(
  { tenantId: 1, indexId: 1, 'classification.productScope.primaryProduct': 1 },
  { sparse: true },
);
SearchDocumentSchema.index(
  { tenantId: 1, indexId: 1, 'classification.department': 1, 'classification.category': 1 },
  { sparse: true },
);

// Knowledge Graph: Entity instance queries (document-to-entity lookups)
SearchDocumentSchema.index(
  { tenantId: 1, indexId: 1, 'entityInstances.entityInstanceId': 1 },
  { sparse: true },
);

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('SearchDocument', SearchDocumentSchema, 'searchaicontent');

export const SearchDocument =
  (mongoose.models.SearchDocument as any) ||
  model<ISearchDocument>('SearchDocument', SearchDocumentSchema);
