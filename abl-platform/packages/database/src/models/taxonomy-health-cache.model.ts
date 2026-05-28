/**
 * Taxonomy Health Cache Model
 *
 * Caches quality signal computations for taxonomy health dashboard.
 * TTL: 1 hour (auto-expires after 3600 seconds).
 * Purpose: Avoid recomputing expensive aggregations on every dashboard load.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IQualitySignals {
  totalDocuments: number;
  classifiedDocuments: number;
  unclassifiedDocuments: number;
  lowConfidenceDocuments: number; // confidence < 0.5
  productDistribution: Record<string, number>; // product ID → doc count
  avgConfidenceByProduct: Record<string, number>; // product ID → avg confidence
  topUnclassifiedTerms: Array<{ term: string; frequency: number }>; // top 20
  suspiciousPatterns: Array<{ pattern: string; count: number }>; // detected anomalies
}

export interface ITaxonomyHealthCache {
  _id: string;
  tenantId: string;
  indexId: string;
  signals: IQualitySignals;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TaxonomyHealthCacheSchema = new Schema<ITaxonomyHealthCache>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true, index: true },
    indexId: { type: String, required: true, index: true },

    signals: {
      totalDocuments: { type: Number, required: true },
      classifiedDocuments: { type: Number, required: true },
      unclassifiedDocuments: { type: Number, required: true },
      lowConfidenceDocuments: { type: Number, required: true },
      productDistribution: {
        type: Map,
        of: Number,
        required: true,
        default: {},
      },
      avgConfidenceByProduct: {
        type: Map,
        of: Number,
        required: true,
        default: {},
      },
      topUnclassifiedTerms: [
        {
          term: { type: String, required: true },
          frequency: { type: Number, required: true },
        },
      ],
      suspiciousPatterns: [
        {
          pattern: { type: String, required: true },
          count: { type: Number, required: true },
        },
      ],
    },

    computedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, collection: 'taxonomy_health_cache' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TaxonomyHealthCacheSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique constraint: one cache entry per index
TaxonomyHealthCacheSchema.index({ tenantId: 1, indexId: 1 }, { unique: true });

// TTL index: auto-delete after 1 hour (3600 seconds)
TaxonomyHealthCacheSchema.index({ computedAt: 1 }, { expireAfterSeconds: 3600 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition(
  'TaxonomyHealthCache',
  TaxonomyHealthCacheSchema,
  'searchaicontent',
);

export const TaxonomyHealthCache =
  (mongoose.models.TaxonomyHealthCache as any) ||
  model<ITaxonomyHealthCache>('TaxonomyHealthCache', TaxonomyHealthCacheSchema);
