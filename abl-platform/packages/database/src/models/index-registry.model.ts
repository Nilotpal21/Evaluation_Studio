/**
 * IndexRegistry Model
 *
 * Maps appId + connectorId to vector store index names.
 * Supports all three strategies: shared, per-app, per-connector.
 *
 * Key Patterns:
 * - Default entry: { appId, connectorId: null } = app-level default index
 * - Override entry: { appId, connectorId: 'xyz' } = connector-specific index
 * - Hybrid strategy: One app can have multiple entries (base + overrides)
 */

import mongoose, { Schema, model, type Document } from 'mongoose';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type IndexStrategy = 'shared' | 'per-app' | 'per-connector';
export type IndexStatus = 'active' | 'migrating' | 'deleting';

export interface IIndexRegistry extends Document {
  tenantId: string;
  appId: string;
  connectorId: string | null; // null = app default, non-null = connector override
  indexName: string;
  strategy: IndexStrategy;
  status: IndexStatus;
  vectorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const IndexRegistrySchema = new Schema<IIndexRegistry>(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    appId: {
      type: String,
      required: true,
      index: true,
    },
    connectorId: {
      type: String,
      default: null,
      index: true, // Sparse index
    },
    indexName: {
      type: String,
      required: true,
      // Not unique: shared strategy maps multiple apps to the same vector store index.
      // Lookup efficiency provided by compound index (indexName, status).
    },
    strategy: {
      type: String,
      enum: ['shared', 'per-app', 'per-connector'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'migrating', 'deleting'],
      default: 'active',
    },
    vectorCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: 'index_registry',
  },
);

// ─── Compound Indexes ────────────────────────────────────────────────────────

// Unique constraint: one active registry entry per tenant+app+connector
IndexRegistrySchema.index({ tenantId: 1, appId: 1, connectorId: 1, status: 1 }, { unique: true });

// Find all indices for an app (search across all sources)
IndexRegistrySchema.index({ tenantId: 1, appId: 1, status: 1 });

// Find index for specific connector (write path)
IndexRegistrySchema.index({ indexName: 1, status: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────────

IndexRegistrySchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────────

export const IndexRegistry =
  (mongoose.models.IndexRegistry as any) ||
  model<IIndexRegistry>('IndexRegistry', IndexRegistrySchema);
