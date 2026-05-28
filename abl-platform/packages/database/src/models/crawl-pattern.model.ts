/**
 * Crawl Pattern Model
 *
 * Stores successful site profiling results and crawl patterns for reuse.
 * Used by the Autonomous Intelligence layer to avoid re-profiling domains.
 *
 * Design:
 * - One document per domain (upserted on each successful profile)
 * - TTL-based expiration (profiles expire after N days of inactivity)
 * - Tenant-scoped for multi-tenancy
 * - Compressed profile data to save space
 *
 * Usage:
 * 1. After successful site profiling, upsert pattern
 * 2. Before profiling, check if pattern exists and is fresh
 * 3. Periodic cleanup via MongoDB TTL index
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ICrawlPattern {
  _id: string;
  domain: string; // Normalized domain (e.g., "example.com")
  tenantId: string; // Tenant isolation

  // Site Profile (from profiler)
  siteType: 'static' | 'spa' | 'hybrid' | 'unknown';
  framework?: string; // e.g., "next", "react", "vue"
  jsRequired: boolean;
  linkDensity: number;
  estimatedSize: number;
  avgResponseTime: number;
  rateLimitDetected: boolean;
  maxConcurrency: number;
  confidence: number; // 0-100

  // Metadata
  metadata: {
    hasRobotsTxt?: boolean;
    hasSitemap?: boolean;
    htmlSize?: number;
    scriptTagCount?: number;
    [key: string]: any;
  };

  // Crawl Performance (updated on each crawl)
  lastCrawlAt?: Date;
  totalCrawlsCompleted: number;
  avgCrawlDurationMs?: number;
  lastCrawlSuccess: boolean;
  lastCrawlError?: string;

  // Timestamps
  profiledAt: Date; // When site was last profiled
  lastAccessedAt: Date; // Last time pattern was read (for TTL)
  createdAt: Date;
  updatedAt: Date;

  _v: number;
}

// Input for creating/updating pattern
export interface ICrawlPatternInput {
  domain: string;
  tenantId: string;
  siteType: 'static' | 'spa' | 'hybrid' | 'unknown';
  framework?: string;
  jsRequired: boolean;
  linkDensity: number;
  estimatedSize: number;
  avgResponseTime: number;
  rateLimitDetected: boolean;
  maxConcurrency: number;
  confidence: number;
  metadata?: Record<string, any>;
  profiledAt?: Date;
}

// Update for crawl completion
export interface ICrawlPatternCrawlUpdate {
  lastCrawlAt: Date;
  avgCrawlDurationMs?: number;
  lastCrawlSuccess: boolean;
  lastCrawlError?: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const CrawlPatternSchema = new Schema<ICrawlPattern>(
  {
    _id: { type: String, default: uuidv7 },
    domain: { type: String, required: true },
    tenantId: { type: String, required: true },

    // Site Profile
    siteType: {
      type: String,
      enum: ['static', 'spa', 'hybrid', 'unknown'],
      required: true,
    },
    framework: { type: String },
    jsRequired: { type: Boolean, required: true },
    linkDensity: { type: Number, required: true },
    estimatedSize: { type: Number, required: true },
    avgResponseTime: { type: Number, required: true },
    rateLimitDetected: { type: Boolean, required: true },
    maxConcurrency: { type: Number, required: true },
    confidence: { type: Number, required: true, min: 0, max: 100 },

    // Metadata
    metadata: { type: Schema.Types.Mixed, default: {} },

    // Crawl Performance
    lastCrawlAt: { type: Date },
    totalCrawlsCompleted: { type: Number, default: 0 },
    avgCrawlDurationMs: { type: Number },
    lastCrawlSuccess: { type: Boolean, default: true },
    lastCrawlError: { type: String },

    // Timestamps
    profiledAt: { type: Date, required: true },
    lastAccessedAt: { type: Date, required: true },

    _v: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    collection: 'crawl_patterns',
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique index: one pattern per domain per tenant
CrawlPatternSchema.index({ tenantId: 1, domain: 1 }, { unique: true });

// TTL index: expire patterns after 90 days of no access
// MongoDB will delete documents where lastAccessedAt is older than 90 days
CrawlPatternSchema.index(
  { lastAccessedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }, // 90 days
);

// Query index: find by tenant
CrawlPatternSchema.index({ tenantId: 1, lastAccessedAt: -1 });

// Query index: find by site type for analytics
CrawlPatternSchema.index({ tenantId: 1, siteType: 1 });

// Query index: find by framework
CrawlPatternSchema.index({ tenantId: 1, framework: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

CrawlPatternSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const CrawlPattern =
  (mongoose.models.CrawlPattern as mongoose.Model<ICrawlPattern>) ||
  model<ICrawlPattern>('CrawlPattern', CrawlPatternSchema);
