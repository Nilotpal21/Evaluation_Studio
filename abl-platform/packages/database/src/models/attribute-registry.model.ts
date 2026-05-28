/**
 * Attribute Registry Model
 *
 * Stores product-scoped attribute definitions for the Browse SDK.
 * Each entry represents a single attribute (e.g. "interest_rate") within
 * a specific product scope (e.g. "credit_card") for an index.
 *
 * Attributes progress through tiers: novel → beta → approved → permanent.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type AttributeTier = 'permanent' | 'approved' | 'beta' | 'novel' | 'discarded';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAttributeRegistry {
  _id: string;
  tenantId: string;
  indexId: string;
  attributeId: string; // snake_case base concept e.g. "interest_rate"
  productScope: string; // product type e.g. "credit_card"

  tier: AttributeTier;
  displayName: string; // product-specific e.g. "Interest Rate (APR)"
  dataType: string; // 'percentage' | 'currency' | 'date' | etc.
  aliases: string[]; // alternate names for this attribute
  extractionPatterns: string[]; // regex patterns for extraction
  typicalRange?: string; // from org profile, per product e.g. "15-30%"
  definition?: string; // human-readable definition of the attribute

  // Discovery metadata (populated in Sprint 5)
  discoverySource?: 'domain_definition' | 'llm_extraction' | 'admin_manual';
  confidence?: number; // 0-1, from LLM extraction
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  lastReconciledAt?: Date; // Set after reconciliation to prevent re-clustering
  documentCount?: number; // docs where this attribute appears

  // Auto-promotion metrics (populated in Sprint 6)
  uniqueUsers?: number;
  totalInteractions?: number;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AttributeRegistrySchema = new Schema<IAttributeRegistry>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    attributeId: { type: String, required: true },
    productScope: { type: String, required: true },

    tier: {
      type: String,
      enum: ['permanent', 'approved', 'beta', 'novel', 'discarded'],
      required: true,
    },
    displayName: { type: String, required: true },
    dataType: { type: String, required: true },
    aliases: [{ type: String }],
    extractionPatterns: [{ type: String }],
    typicalRange: { type: String },
    definition: { type: String },

    // Discovery metadata
    discoverySource: {
      type: String,
      enum: ['domain_definition', 'llm_extraction', 'admin_manual'],
    },
    confidence: { type: Number },
    firstSeenAt: { type: Date },
    lastSeenAt: { type: Date },
    lastReconciledAt: { type: Date },
    documentCount: { type: Number },

    // Auto-promotion metrics
    uniqueUsers: { type: Number },
    totalInteractions: { type: Number },
  },
  { timestamps: true, collection: 'attribute_registry' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AttributeRegistrySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Compound unique: one attribute per product scope per index
AttributeRegistrySchema.index(
  { tenantId: 1, indexId: 1, attributeId: 1, productScope: 1 },
  { unique: true },
);

// Secondary: tier-based queries for an index
AttributeRegistrySchema.index({ tenantId: 1, indexId: 1, tier: 1 });

// Reconciliation: find unreconciled novels efficiently
AttributeRegistrySchema.index({ tenantId: 1, indexId: 1, tier: 1, lastReconciledAt: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
// Uses 'platform' (abl_platform) — attribute definitions are config/metadata,
// and the kg-enrichment-worker writes via default mongoose connection (abl_platform).
ModelRegistry.registerModelDefinition('AttributeRegistry', AttributeRegistrySchema, 'platform');

export const AttributeRegistry =
  (mongoose.models.AttributeRegistry as any) ||
  model<IAttributeRegistry>('AttributeRegistry', AttributeRegistrySchema);
