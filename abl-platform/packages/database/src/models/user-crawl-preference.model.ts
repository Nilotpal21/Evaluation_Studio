/**
 * User Crawl Preference Model
 *
 * Stores user-specific crawl preferences for domains.
 * Enables personalized crawl strategy selection based on user history.
 *
 * Features:
 * - Domain pattern matching (exact and wildcard)
 * - Tenant isolation
 * - Usage tracking (useCount, lastUsed)
 * - Auto-decide flag
 */

import mongoose, { Schema, model } from 'mongoose';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

/**
 * User Crawl Preference Document
 */
export interface IUserCrawlPreference {
  _id: string;

  /** User ID */
  userId: string;

  /** Tenant ID (for isolation) */
  tenantId: string;

  /** Domain pattern (exact or wildcard, e.g., "example.com" or "*.example.com") */
  domainPattern: string;

  /** Preferred crawl strategy */
  strategy: 'browser' | 'bulk' | 'hybrid';

  /** Preferred batch size (optional) */
  batchSize?: number;

  /** Preferred concurrency (optional) */
  concurrency?: number;

  /** Auto-decide without prompting */
  autoDecide: boolean;

  /** Usage tracking */
  useCount: number;
  lastUsed: Date;

  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * User Crawl Preference Schema
 */
const UserCrawlPreferenceSchema = new Schema<IUserCrawlPreference>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    domainPattern: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    strategy: {
      type: String,
      required: true,
      enum: ['browser', 'bulk', 'hybrid'],
    },
    batchSize: {
      type: Number,
      min: 1,
    },
    concurrency: {
      type: Number,
      min: 1,
    },
    autoDecide: {
      type: Boolean,
      required: true,
      default: false,
    },
    useCount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lastUsed: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    collection: 'user_crawl_preferences',
  },
);

// ========================================
// Indexes
// ========================================

// Unique constraint: one preference per user+tenant+domain pattern
UserCrawlPreferenceSchema.index({ userId: 1, tenantId: 1, domainPattern: 1 }, { unique: true });

// Query by userId and tenantId
UserCrawlPreferenceSchema.index({ userId: 1, tenantId: 1 });

// Query by domain pattern for wildcard matching
UserCrawlPreferenceSchema.index({ domainPattern: 1 });

// ========================================
// Plugins
// ========================================

// Tenant isolation
UserCrawlPreferenceSchema.plugin(tenantIsolationPlugin);

// ========================================
// Model
// ========================================

export const UserCrawlPreference =
  (mongoose.models.UserCrawlPreference as mongoose.Model<IUserCrawlPreference>) ||
  model<IUserCrawlPreference>('UserCrawlPreference', UserCrawlPreferenceSchema);
