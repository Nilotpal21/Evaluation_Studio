/**
 * Search Chunk Model
 *
 * Represents a chunk of a document, ready for embedding and vector storage.
 * Canonical metadata is materialized at ingestion time via field mappings.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEntityExtraction {
  type: string;
  name: string;
  dataType: string;
  rawValue: string;
  normalizedValue: string | number | boolean;
  productType: string;
  context: {
    chunkScope: string;
    inScopeMatch: boolean;
    attributeApplicable: boolean;
  };
}

export interface IKGState {
  status: 'NOT_ENRICHED' | 'ENRICHED' | 'SKIPPED' | 'NEEDS_RECLASSIFICATION';
  enrichedAt?: Date;
  skippedReason?: 'NO_TAXONOMY' | 'KG_DISABLED';
  taxonomyVersion?: string;
  needsReclassification: boolean;
}

export interface IChunkClassification {
  productScope: {
    primaryProduct: string;
    confidence: number;
    secondaryProducts: string[];
  };
  department: string;
  category: string;
  classifiedAt: Date;
  model: string;
  escalatedToSonnet: boolean;
}

export interface ISearchChunk {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;
  /** Pipeline that produced this chunk (for traceability and reindexing) */
  pipelineId: string | null;
  /** Flow that produced this chunk (for reindexing: checkpoint 3 queries by flow) */
  flowId: string | null;
  /** Chunk content text */
  content: string;
  /** Token count for this chunk */
  tokenCount: number;
  /** Position of this chunk within the document */
  chunkIndex: number;
  /** Vector ID in the external vector store */
  vectorId: string | null;
  /** Raw source metadata carried from the document */
  metadata: any | null;
  /**
   * Canonical metadata: materialized at ingestion time via field mappings.
   * Queries use canonical field names (e.g., canonical.title, canonical.status)
   * rather than raw source field names.
   */
  canonicalMetadata: Record<string, unknown> | null;
  /**
   * Knowledge Graph: Product scope classification for this chunk.
   * Used for query-time disambiguation and scoped retrieval.
   */
  classification?: IChunkClassification;
  status: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const SearchChunkSchema = new Schema<ISearchChunk>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    documentId: { type: String, required: true },
    pipelineId: { type: String, default: null },
    flowId: { type: String, default: null },
    content: { type: String, required: true },
    tokenCount: { type: Number, default: 0 },
    chunkIndex: { type: Number, required: true, default: 0 },
    vectorId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    canonicalMetadata: { type: Schema.Types.Mixed, default: null },
    classification: {
      type: {
        productScope: {
          primaryProduct: { type: String, required: true },
          confidence: { type: Number, required: true },
          secondaryProducts: [{ type: String }],
        },
        department: { type: String, required: true },
        category: { type: String, required: true },
        classifiedAt: { type: Date, required: true },
        model: { type: String, required: true },
        escalatedToSonnet: { type: Boolean, required: true },
      },
      required: false,
      default: undefined,
    },
    status: { type: String, required: true, default: 'pending' },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'search_chunks' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SearchChunkSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Document and chunk lookup
SearchChunkSchema.index({ indexId: 1, documentId: 1, chunkIndex: 1 });
SearchChunkSchema.index({ indexId: 1, status: 1 });
SearchChunkSchema.index({ vectorId: 1 }, { sparse: true });
SearchChunkSchema.index({ tenantId: 1, indexId: 1 });
SearchChunkSchema.index({ tenantId: 1, pipelineId: 1 }, { sparse: true });
SearchChunkSchema.index({ tenantId: 1, flowId: 1 }, { sparse: true });
SearchChunkSchema.index({ tenantId: 1, indexId: 1, flowId: 1 }, { sparse: true });

// Knowledge Graph: KG state queries (enrichment status, re-classification)
SearchChunkSchema.index(
  { tenantId: 1, indexId: 1, 'metadata.kgState.status': 1 },
  { sparse: true },
);
SearchChunkSchema.index(
  {
    tenantId: 1,
    indexId: 1,
    'metadata.kgState.needsReclassification': 1,
    'metadata.kgState.taxonomyVersion': 1,
  },
  { sparse: true },
);

// Knowledge Graph: Classification queries (product scope filtering)
SearchChunkSchema.index(
  { tenantId: 1, indexId: 1, 'classification.productScope.primaryProduct': 1 },
  { sparse: true },
);
SearchChunkSchema.index(
  { tenantId: 1, indexId: 1, 'classification.department': 1, 'classification.category': 1 },
  { sparse: true },
);

// Knowledge Graph: Entity queries
SearchChunkSchema.index({ tenantId: 1, indexId: 1, 'metadata.entities.type': 1 }, { sparse: true });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('SearchChunk', SearchChunkSchema, 'searchaicontent');

export const SearchChunk =
  (mongoose.models.SearchChunk as any) || model<ISearchChunk>('SearchChunk', SearchChunkSchema);
