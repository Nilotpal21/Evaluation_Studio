/**
 * Chunk Hierarchy Model
 *
 * Represents hierarchical tree structure for adaptive chunking (ATLAS-KG Phase 2).
 * Chunks organized in a balanced tree with parent summaries and semantic grouping.
 *
 * Architecture:
 * - Max depth: 4 levels
 * - Max children per node: 10
 * - Internal nodes have summaries (LLM-generated)
 * - Leaf nodes are actual chunks with content
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IChunkHierarchy {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;
  /** Parent node ID (null for root) */
  parentId: string | null;
  /** Child node IDs */
  childIds: string[];
  /** Depth in tree (0 = root) */
  depth: number;
  /** Node type */
  nodeType: 'root' | 'internal' | 'leaf';
  /** Chunk ID if this is a leaf node */
  chunkId: string | null;
  /** Summary text (for internal nodes and root) */
  summary: string | null;
  /** Semantic similarity score with parent (for grouping) */
  similarityScore: number | null;
  /** Token count */
  tokenCount: number;
  /** Position in parent's children */
  positionInParent: number;
  /** Metadata */
  metadata: Record<string, unknown> | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ChunkHierarchySchema = new Schema<IChunkHierarchy>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    documentId: { type: String, required: true },
    parentId: { type: String, default: null },
    childIds: { type: [String], default: [] },
    depth: { type: Number, required: true, default: 0 },
    nodeType: {
      type: String,
      required: true,
      enum: ['root', 'internal', 'leaf'],
      default: 'leaf',
    },
    chunkId: { type: String, default: null },
    summary: { type: String, default: null },
    similarityScore: { type: Number, default: null },
    tokenCount: { type: Number, default: 0 },
    positionInParent: { type: Number, default: 0 },
    metadata: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'chunk_hierarchies' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ChunkHierarchySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Document-level queries with tenant isolation
ChunkHierarchySchema.index({ tenantId: 1, indexId: 1, documentId: 1 });
// Parent-child traversal with tenant isolation
ChunkHierarchySchema.index({ tenantId: 1, indexId: 1, parentId: 1 });
// Leaf node lookup (sparse since only leaf nodes have chunkId)
ChunkHierarchySchema.index({ chunkId: 1 }, { sparse: true });
// Filtering by node type with tenant isolation
ChunkHierarchySchema.index({ tenantId: 1, indexId: 1, nodeType: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('ChunkHierarchy', ChunkHierarchySchema, 'searchaicontent');

export const ChunkHierarchy =
  (mongoose.models.ChunkHierarchy as any) ||
  model<IChunkHierarchy>('ChunkHierarchy', ChunkHierarchySchema);
