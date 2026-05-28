/**
 * Chunk Scope Model
 *
 * Stores scope classification for chunks (ATLAS-KG Phase 5).
 * Classifies whether chunk answers chunk-level, section-level, or document-level queries.
 * Enables scope-aware retrieval strategies.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IChunkScope {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;
  chunkId: string;
  /** Scope level */
  scopeLevel: 'chunk' | 'section' | 'document';
  /** Confidence score (0-1) */
  confidence: number;
  /** Reasoning/explanation for classification */
  reasoning: string | null;
  /** Recommended retrieval strategy */
  retrievalStrategy: 'direct' | 'with_context' | 'summary' | 'hierarchical';
  /** Metadata */
  metadata: Record<string, unknown> | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ChunkScopeSchema = new Schema<IChunkScope>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    documentId: { type: String, required: true },
    chunkId: { type: String, required: true, unique: true },
    scopeLevel: {
      type: String,
      required: true,
      enum: ['chunk', 'section', 'document'],
      default: 'chunk',
    },
    confidence: { type: Number, default: 1.0, min: 0, max: 1 },
    reasoning: { type: String, default: null },
    retrievalStrategy: {
      type: String,
      required: true,
      enum: ['direct', 'with_context', 'summary', 'hierarchical'],
      default: 'direct',
    },
    metadata: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'chunk_scopes' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ChunkScopeSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Index-level queries with tenant isolation
ChunkScopeSchema.index({ tenantId: 1, indexId: 1 });
// Document-level queries
ChunkScopeSchema.index({ documentId: 1 });
// Scope-level filtering with tenant isolation for retrieval strategies
ChunkScopeSchema.index({ tenantId: 1, indexId: 1, scopeLevel: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('ChunkScope', ChunkScopeSchema, 'searchaicontent');

export const ChunkScope =
  (mongoose.models.ChunkScope as any) || model<IChunkScope>('ChunkScope', ChunkScopeSchema);
