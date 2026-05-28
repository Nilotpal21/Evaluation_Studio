/**
 * Tenant Crawl Policy Model
 *
 * Stores organization-level crawl policies and constraints.
 * Enforces resource limits, allowed strategies, and compliance rules.
 *
 * Features:
 * - Domain pattern matching (exact and wildcard)
 * - Strategy restrictions
 * - Resource limits (batch size, concurrency, memory, duration)
 * - Compliance flags (robots.txt, rate limiting, user agent)
 * - Admin audit trail
 */

import mongoose, { Schema, model } from 'mongoose';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

/**
 * Tenant Crawl Policy Document
 */
export interface ITenantCrawlPolicy {
  _id: string;

  /** Tenant ID */
  tenantId: string;

  /** Domain pattern (exact or wildcard, e.g., "example.com" or "*.example.com") */
  domainPattern: string;

  /** Allowed crawl strategies */
  allowedStrategies: Array<'browser' | 'bulk' | 'hybrid'>;

  /** Resource limits */
  limits: {
    maxBatchSize: number;
    maxConcurrency: number;
    maxMemoryMB: number;
    maxDurationMinutes: number;
  };

  /** Compliance flags (optional) */
  compliance?: {
    respectRobotsTxt: boolean;
    maxRequestsPerSecond: number;
    userAgent: string;
  };

  /** Admin who created this policy */
  createdBy: string;

  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tenant Crawl Policy Schema
 */
const TenantCrawlPolicySchema = new Schema<ITenantCrawlPolicy>(
  {
    tenantId: {
      type: String,
      required: true,
    },
    domainPattern: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    allowedStrategies: {
      type: [String],
      required: true,
      enum: ['browser', 'bulk', 'hybrid'],
      validate: {
        validator: (val: string[]) => val.length > 0,
        message: 'At least one strategy must be allowed',
      },
    },
    limits: {
      type: {
        maxBatchSize: {
          type: Number,
          required: true,
          min: 1,
        },
        maxConcurrency: {
          type: Number,
          required: true,
          min: 1,
        },
        maxMemoryMB: {
          type: Number,
          required: true,
          min: 1,
        },
        maxDurationMinutes: {
          type: Number,
          required: true,
          min: 1,
        },
      },
      required: true,
    },
    compliance: {
      type: {
        respectRobotsTxt: {
          type: Boolean,
          required: true,
        },
        maxRequestsPerSecond: {
          type: Number,
          required: true,
          min: 1,
        },
        userAgent: {
          type: String,
          required: true,
        },
      },
      required: false,
    },
    createdBy: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: 'tenant_crawl_policies',
  },
);

// ========================================
// Indexes
// ========================================

// Unique constraint: one policy per tenant+domain pattern
TenantCrawlPolicySchema.index({ tenantId: 1, domainPattern: 1 }, { unique: true });

// Query by tenant
TenantCrawlPolicySchema.index({ tenantId: 1 });

// Query by domain pattern for wildcard matching
TenantCrawlPolicySchema.index({ domainPattern: 1 });

// ========================================
// Plugins
// ========================================

// Tenant isolation
TenantCrawlPolicySchema.plugin(tenantIsolationPlugin);

// ========================================
// Model
// ========================================

export const TenantCrawlPolicy =
  (mongoose.models.TenantCrawlPolicy as mongoose.Model<ITenantCrawlPolicy>) ||
  model<ITenantCrawlPolicy>('TenantCrawlPolicy', TenantCrawlPolicySchema);
