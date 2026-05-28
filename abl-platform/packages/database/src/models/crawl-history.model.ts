/**
 * CrawlHistory Model
 *
 * Tracks status transitions, document processing, and performance metrics over time.
 * Enables timeline visualization and performance analysis.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

export interface ICrawlHistory {
  _id: string;
  tenantId: string;
  crawlJobId: string; // References CrawlJob

  // Status progression
  statuses: Array<{
    timestamp: Date;
    status: string;
    phase: string; // crawling, ingesting, indexing, etc
    reason?: string; // Why transition happened

    // Metrics at this point
    metrics?: {
      urlsCrawled?: number;
      documentsCreated?: number;
      documentsIndexed?: number;
      avgQualityScore?: number;
      queueHealth?: string; // healthy, degraded, critical
    };
  }>;

  // Document status progression
  documentStatusChanges: Array<{
    documentId: string;
    fromStatus: string;
    toStatus: string;
    timestamp: Date;
    worker: string;
    durationMs: number;
    metadata?: Record<string, any>;
  }>;

  // Performance timeline
  performance: Array<{
    timestamp: Date;
    phase: string;
    documentsProcessed: number;
    chunksCreated: number;
    avgProcessingTimeMs: number;
    queueDepth: number;
    workerCount: number;
  }>;

  createdAt: Date;
  updatedAt: Date;
  _v: number;
}

const crawlHistorySchema = new Schema<ICrawlHistory>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true, index: true },
    crawlJobId: { type: String, required: true },

    statuses: [
      {
        timestamp: { type: Date, required: true },
        status: { type: String, required: true },
        phase: { type: String, required: true },
        reason: String,
        metrics: {
          urlsCrawled: Number,
          documentsCreated: Number,
          documentsIndexed: Number,
          avgQualityScore: Number,
          queueHealth: String,
        },
      },
    ],

    documentStatusChanges: [
      {
        documentId: { type: String, required: true },
        fromStatus: { type: String, required: true },
        toStatus: { type: String, required: true },
        timestamp: { type: Date, required: true },
        worker: { type: String, required: true },
        durationMs: { type: Number, required: true },
        metadata: Schema.Types.Mixed,
      },
    ],

    performance: [
      {
        timestamp: { type: Date, required: true },
        phase: { type: String, required: true },
        documentsProcessed: { type: Number, required: true },
        chunksCreated: { type: Number, required: true },
        avgProcessingTimeMs: { type: Number, required: true },
        queueDepth: { type: Number, required: true },
        workerCount: { type: Number, required: true },
      },
    ],
  },
  {
    timestamps: true,
    collection: 'crawl_history',
  },
);

// Indexes
crawlHistorySchema.index({ crawlJobId: 1 });
crawlHistorySchema.index({ tenantId: 1, createdAt: -1 });

crawlHistorySchema.plugin(tenantIsolationPlugin);

export const CrawlHistory =
  (mongoose.models.CrawlHistory as mongoose.Model<ICrawlHistory>) ||
  model<ICrawlHistory>('CrawlHistory', crawlHistorySchema);
