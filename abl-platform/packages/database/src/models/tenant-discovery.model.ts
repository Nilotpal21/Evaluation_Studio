/**
 * TenantDiscovery Model
 *
 * Per-tenant discovery selections with tenant isolation.
 * Links to a SiteDiscovery record and stores tenant-specific URL selections,
 * explored branches, and crawl configuration preferences.
 * Stored in the searchaicontent database.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

export interface ITenantDiscovery {
  _id: string;
  tenantId: string;
  domain: string;
  sourceId?: string;
  discoveryId: string;
  exploredBranches: string[];
  selectedUrls: string[];
  selectionPatterns: string[];
  seedsUsed: Array<{
    type: 'nav-section' | 'target-url';
    url: string;
    label?: string;
  }>;
  crawlConfig?: {
    maxDepth?: number;
    renderMethod?: 'http' | 'browser' | 'auto';
    excludePatterns?: string[];
    includePatterns?: string[];
  };
  status: 'active' | 'completed' | 'abandoned';
  createdAt: Date;
  updatedAt: Date;
}

export const tenantDiscoverySchema = new Schema<ITenantDiscovery>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    domain: { type: String, required: true },
    sourceId: String,
    discoveryId: { type: String, required: true },
    exploredBranches: [{ type: String }],
    selectedUrls: [{ type: String }],
    selectionPatterns: [{ type: String }],
    seedsUsed: [
      {
        type: {
          type: String,
          enum: ['nav-section', 'target-url'],
          required: true,
        },
        url: { type: String, required: true },
        label: String,
      },
    ],
    crawlConfig: {
      maxDepth: Number,
      renderMethod: { type: String, enum: ['http', 'browser', 'auto'] },
      excludePatterns: [String],
      includePatterns: [String],
    },
    status: {
      type: String,
      enum: ['active', 'completed', 'abandoned'],
      default: 'active',
    },
  },
  { timestamps: true },
);

// Indexes
tenantDiscoverySchema.index(
  { tenantId: 1, domain: 1, sourceId: 1 },
  { unique: true, sparse: true },
);
tenantDiscoverySchema.index({ tenantId: 1, status: 1 });
tenantDiscoverySchema.index({ discoveryId: 1 });

// Tenant isolation
tenantDiscoverySchema.plugin(tenantIsolationPlugin);

// HMR guard (standard ESM pattern)
export const TenantDiscovery =
  (mongoose.models.TenantDiscovery as mongoose.Model<ITenantDiscovery>) ||
  model<ITenantDiscovery>('TenantDiscovery', tenantDiscoverySchema);
