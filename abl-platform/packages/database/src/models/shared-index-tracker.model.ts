/**
 * SharedIndexTracker Model
 *
 * Tracks shared vector store indices and their capacity.
 * Enables automatic rotation when capacity reaches threshold (default: 70%).
 *
 * Lifecycle:
 * 1. Create v1: status=active
 * 2. Reaches 70%: Mark v1 as full, create v2 as active
 * 3. New apps use v2, old apps continue on v1
 * 4. Eventually archive v1 when no longer needed
 */

import mongoose, { Schema, model, type Document } from 'mongoose';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SharedIndexStatus = 'active' | 'full' | 'migrating' | 'archived';

export interface ISharedIndexTracker extends Document {
  indexName: string; // e.g., 'search-vectors-1024-v1'
  version: number; // 1, 2, 3...
  dimensions: number; // Vector dimensions (e.g., 1024, 1536) — indexes are pooled per dimension
  status: SharedIndexStatus;
  vectorCount: number;
  estimatedSizeGB: number;
  capacityPercent: number; // vectorCount / maxVectors
  maxVectors: number; // Configured limit (from deployment config)
  maxSizeGB: number; // Configured size limit
  appCount: number; // Number of apps using this index
  createdAt: Date;
  lastSyncedAt: Date; // Last time we synced stats from vector store
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const SharedIndexTrackerSchema = new Schema<ISharedIndexTracker>(
  {
    indexName: {
      type: String,
      required: true,
      unique: true,
    },
    version: {
      type: Number,
      required: true,
    },
    dimensions: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'full', 'migrating', 'archived'],
      default: 'active',
    },
    vectorCount: {
      type: Number,
      default: 0,
    },
    estimatedSizeGB: {
      type: Number,
      default: 0,
    },
    capacityPercent: {
      type: Number,
      default: 0,
    },
    maxVectors: {
      type: Number,
      required: true,
    },
    maxSizeGB: {
      type: Number,
      required: true,
    },
    appCount: {
      type: Number,
      default: 0,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false, // Using custom lastSyncedAt
    collection: 'shared_index_tracker',
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Find active shared index by dimension (for new app assignments)
SharedIndexTrackerSchema.index({ dimensions: 1, status: 1, version: -1 });

// ─── Model ───────────────────────────────────────────────────────────────────

export const SharedIndexTracker =
  (mongoose.models.SharedIndexTracker as any) ||
  model<ISharedIndexTracker>('SharedIndexTracker', SharedIndexTrackerSchema);
