/**
 * Knowledge Base Model
 *
 * User-facing entity for retrieval-augmented generation (RAG).
 * A KnowledgeBase owns a linked SearchIndex (auto-created) and
 * one or more connectors (SearchSource). Technical details like
 * embedding model and chunk strategy live on the SearchIndex.
 *
 * Scoped to a tenant + project via the tenant isolation plugin.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IKnowledgeBase {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description: string | null;
  /** Link to the auto-created SearchIndex */
  searchIndexId: string | null;
  /** Reference to the canonical schema for this KB (Search AI Layer 2) */
  canonicalSchemaId: string | null;
  /** Denormalized connector (source) count */
  connectorCount: number;
  /** Overall status: creating | ready | rebuilding | error */
  status: string;
  /** User who created this knowledge base */
  createdBy?: string;
  documentCount: number;
  lastIndexedAt: Date | null;
  indexError: string | null;
  isPublic: boolean;
  metadata: any;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const KnowledgeBaseSchema = new Schema<IKnowledgeBase>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    searchIndexId: { type: String, default: null },
    canonicalSchemaId: { type: String, default: null },
    connectorCount: { type: Number, default: 0 },
    status: { type: String, required: true, default: 'creating' },
    createdBy: { type: String, default: 'system' },
    documentCount: { type: Number, default: 0 },
    lastIndexedAt: { type: Date, default: null },
    indexError: { type: String, default: null },
    isPublic: { type: Boolean, default: false },
    metadata: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'knowledge_bases' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

KnowledgeBaseSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

KnowledgeBaseSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
KnowledgeBaseSchema.index({ tenantId: 1, projectId: 1 });
KnowledgeBaseSchema.index({ status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const KnowledgeBase =
  (mongoose.models.KnowledgeBase as any) ||
  model<IKnowledgeBase>('KnowledgeBase', KnowledgeBaseSchema);
