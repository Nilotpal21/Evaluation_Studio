/**
 * CrawlJob Model
 *
 * Tracks crawl job execution history, configuration, and results.
 * Provides historical record for comparison and audit trail.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

export interface ICrawlJob {
  _id: string;
  tenantId: string;
  userId?: string; // Who initiated the crawl

  // Job Metadata
  status: 'queued' | 'crawling' | 'ingesting' | 'indexing' | 'completed' | 'failed' | 'cancelled';
  strategy: 'browser' | 'bulk' | 'hybrid' | 'intelligence' | 'single-page' | 'sitemap' | 'smart';

  // URLs
  urls: {
    original: string[]; // User-provided URLs
    expanded: string[]; // After sitemap/link discovery
    crawled: number;
    failed: number;
    blocked: number;
    unchanged: number; // Recrawl: pages skipped because content hash matched
    errors?: Array<{
      url: string;
      error: string;
      timestamp: Date;
    }>;
  };

  // Configuration Used
  configuration: {
    strategy: string;
    limits?: {
      maxPages?: number;
      maxDurationMinutes?: number;
      maxDepth?: number;
      maxLlmCalls?: number;
    };
    discovery?: {
      useSitemap?: boolean;
      followLinks?: boolean;
      respectRobotsTxt?: boolean;
    };
    filters?: {
      includePaths?: string[];
      excludePaths?: string[];
      contentKeywords?: string[];
    };
    sectionMapping?: Array<{
      sectionId: string;
      pattern: string;
      name: string;
      strategy?: string;
      urls: string[];
    }>;
  };

  // Execution Timeline
  timeline: {
    submittedAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    estimatedEndAt?: Date;
  };

  // Results Summary
  results: {
    documentsCreated: number;
    documentsIndexed: number;
    documentsFailed: number;
    chunksCreated: number;

    // Quality metrics at completion
    qualityMetrics?: {
      avgQualityScore: number;
      avgContentPreservation: number;
      avgChunksPerDoc: number;
      successRate: number;
    };

    // Metering breakdown by strategy
    metering?: {
      httpPages: number;
      browserPages: number;
      totalPages: number;
    };
  };

  // Error Tracking
  processingErrors: Array<{
    timestamp: Date;
    phase: 'crawl' | 'ingest' | 'extract' | 'embed' | 'index';
    message: string;
    count: number;
    sample?: string;
  }>;

  // Comparison with Previous
  comparison?: {
    previousJobId?: string;
    qualityChange?: number; // Percentage change
    contentChangePercent?: number;
    newDocuments?: number;
    changedDocuments?: number;
    unchangedDocuments?: number;
    deletedDocuments?: number;
  };

  // References
  indexId?: string;
  sourceId?: string;

  createdAt: Date;
  updatedAt: Date;
  _v: number;
}

const crawlJobSchema = new Schema<ICrawlJob>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true, index: true },
    userId: { type: String, index: true },

    status: {
      type: String,
      required: true,
      enum: ['queued', 'crawling', 'ingesting', 'indexing', 'completed', 'failed', 'cancelled'],
      index: true,
    },
    strategy: {
      type: String,
      required: true,
      enum: ['browser', 'bulk', 'hybrid', 'intelligence', 'single-page', 'sitemap', 'smart'],
    },

    urls: {
      original: [String],
      expanded: [String],
      crawled: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      blocked: { type: Number, default: 0 },
      unchanged: { type: Number, default: 0 },
      errors: [
        {
          url: String,
          error: String,
          timestamp: Date,
        },
      ],
    },

    configuration: {
      strategy: String,
      limits: {
        maxPages: Number,
        maxDurationMinutes: Number,
        maxDepth: Number,
        maxLlmCalls: { type: Number, default: null },
      },
      discovery: {
        useSitemap: Boolean,
        followLinks: Boolean,
        respectRobotsTxt: Boolean,
      },
      filters: {
        includePaths: [String],
        excludePaths: [String],
        contentKeywords: [String],
      },
      sectionMapping: [
        {
          sectionId: String,
          pattern: String,
          name: String,
          strategy: { type: String, enum: ['http', 'browser'] },
          urls: [String],
        },
      ],
    },

    timeline: {
      submittedAt: { type: Date, required: true },
      startedAt: Date,
      completedAt: Date,
      estimatedEndAt: Date,
    },

    results: {
      documentsCreated: { type: Number, default: 0 },
      documentsIndexed: { type: Number, default: 0 },
      documentsFailed: { type: Number, default: 0 },
      chunksCreated: { type: Number, default: 0 },
      qualityMetrics: {
        avgQualityScore: Number,
        avgContentPreservation: Number,
        avgChunksPerDoc: Number,
        successRate: Number,
      },
      metering: {
        httpPages: Number,
        browserPages: Number,
        totalPages: Number,
      },
    },

    processingErrors: [
      {
        timestamp: { type: Date, required: true },
        phase: {
          type: String,
          required: true,
          enum: ['crawl', 'ingest', 'extract', 'embed', 'index'],
        },
        message: { type: String, required: true },
        count: { type: Number, default: 1 },
        sample: String,
      },
    ],

    comparison: {
      previousJobId: String,
      qualityChange: Number,
      contentChangePercent: Number,
      newDocuments: Number,
      changedDocuments: Number,
      unchangedDocuments: Number,
      deletedDocuments: Number,
    },

    indexId: { type: String, index: true },
    sourceId: { type: String, index: true },
  },
  {
    timestamps: true,
    collection: 'crawl_jobs',
  },
);

// Indexes
crawlJobSchema.index({ tenantId: 1, createdAt: -1 });
crawlJobSchema.index({ tenantId: 1, status: 1 });
crawlJobSchema.index({ userId: 1, createdAt: -1 });
crawlJobSchema.index({ indexId: 1, createdAt: -1 });
// Compound index for efficient cursor-based pagination in history queries
crawlJobSchema.index({ tenantId: 1, indexId: 1, _id: -1 });

// V2: Auto-delete terminal crawl jobs after 90 days (D5)
crawlJobSchema.index(
  { 'timeline.completedAt': 1 },
  {
    expireAfterSeconds: 90 * 24 * 60 * 60, // 90 days
    partialFilterExpression: {
      'timeline.completedAt': { $type: 'date' },
      status: { $in: ['completed', 'failed', 'cancelled'] },
    },
  },
);

crawlJobSchema.plugin(tenantIsolationPlugin);

export const CrawlJob =
  (mongoose.models.CrawlJob as mongoose.Model<ICrawlJob>) ||
  model<ICrawlJob>('CrawlJob', crawlJobSchema);
