/**
 * Domain Vocabulary Model (Layer 3) - ENHANCED for Canonical Mapping RFC
 *
 * Business-level terminology that resolves to canonical fields + filters at query time.
 * Scoped to a ProjectKnowledgeBase (project-level customization of a KB).
 *
 * CHANGES (RFC-SEARCHAI-001):
 * - Added capabilities (canFilter, canDisplay, canAggregate, canSort) for FR-1
 * - Added relatedFields (displayWith, aggregateWith) for FR-4
 * - Replaced static resolution with fieldRef + dynamic resolution at query time
 * - Added confidence and generatedBy metadata
 *
 * Entries are embedded subdocuments (not a separate collection) since they're
 * always queried and updated together with their parent vocabulary.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IVocabularyEntry {
  // Entry identification (NEW - for API reference)
  id: string; // Unique identifier for this entry (e.g., "entry_abc123")

  // Term identification
  term: string; // e.g., "priority"
  aliases: string[]; // e.g., ["issue priority", "ticket priority", "pri"]
  description?: string; // e.g., "Priority level of issues"

  // Field reference (REVISED - FR-1: not static resolution, just field reference)
  fieldRef: string; // e.g., "issue_priority" - canonical field name

  // Capabilities (NEW - FR-1)
  // Defines WHAT this term CAN resolve to (not WHAT it resolves to)
  capabilities: {
    canFilter: boolean; // Can use in filters (e.g., "filter by priority")
    canDisplay: boolean; // Can show in results (e.g., "show priority")
    canAggregate: boolean; // Can group/count by (e.g., "count by priority")
    canSort: boolean; // Can order by (e.g., "sort by priority")
  };

  // Related fields (NEW - FR-4)
  // Context-aware field inclusion for list and aggregation queries
  relatedFields: {
    displayWith: string[]; // 10-30 fields for detail/list view
    aggregateWith: string[]; // 3-7 fields for aggregated view
  };

  // Metadata
  enabled: boolean;
  confidence?: number; // LLM generation confidence (0.0-1.0)
  generatedBy: 'static' | 'auto' | 'manual'; // How this entry was created: 'static' = pre-defined, 'auto' = LLM/system-generated, 'manual' = user-created

  // Usage tracking (NEW - for API-4 delete validation)
  usageCount?: number; // Number of times this entry has been used in queries
  lastUsed?: Date; // Last time this entry was used in a query

  // Audit trail (NEW - for API tracking)
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IDomainVocabulary {
  _id: string;
  tenantId: string;
  projectKnowledgeBaseId: string; // References ProjectKnowledgeBase
  version: number; // Version of this vocabulary (increments on changes)
  status: 'draft' | 'active' | 'inactive'; // Vocabulary lifecycle status
  entries: IVocabularyEntry[]; // Embedded vocabulary entries
  _v: number; // Mongoose version key
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const VocabularyEntrySchema = new Schema<IVocabularyEntry>(
  {
    id: { type: String, required: true, default: uuidv7 }, // NEW - unique entry ID
    term: { type: String, required: true },
    aliases: { type: [String], default: [] },
    description: { type: String },
    fieldRef: { type: String, required: true }, // NEW - canonical field reference
    capabilities: {
      // NEW - FR-1
      canFilter: { type: Boolean, required: true },
      canDisplay: { type: Boolean, required: true },
      canAggregate: { type: Boolean, required: true },
      canSort: { type: Boolean, required: true },
    },
    relatedFields: {
      // NEW - FR-4
      displayWith: { type: [String], default: [] },
      aggregateWith: { type: [String], default: [] },
    },
    enabled: { type: Boolean, default: true },
    confidence: { type: Number }, // Optional - for LLM-generated entries
    generatedBy: { type: String, enum: ['static', 'auto', 'manual'], required: true },
    usageCount: { type: Number, default: 0 }, // NEW - usage tracking
    lastUsed: { type: Date }, // NEW - last usage timestamp
  },
  { _id: false, timestamps: true }, // timestamps adds createdAt/updatedAt
);

const DomainVocabularySchema = new Schema<IDomainVocabulary>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectKnowledgeBaseId: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    status: {
      type: String,
      enum: ['draft', 'active', 'inactive'],
      required: true,
      default: 'draft',
    },
    entries: { type: [VocabularyEntrySchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'domain_vocabularies' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

DomainVocabularySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

DomainVocabularySchema.index({ projectKnowledgeBaseId: 1, version: 1 }, { unique: true });
DomainVocabularySchema.index({ tenantId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const DomainVocabulary =
  (mongoose.models.DomainVocabulary as any) ||
  model<IDomainVocabulary>('DomainVocabulary', DomainVocabularySchema);
