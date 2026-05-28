/**
 * CrawlError Model
 *
 * Persists per-URL crawl failures and blocked URLs as independent documents.
 * One document per failed/blocked URL — zero write contention.
 * Uses the same tenant isolation and UUID patterns as CrawlJob.
 *
 * TTL: 90 days on createdAt (unconditional).
 * Compound index: { tenantId, crawlJobId, timestamp } for efficient /pages queries.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

/**
 * CrawlErrorType — classification of crawl failures.
 * Matches the CrawlErrorType union in packages/crawler.
 */
export type CrawlErrorType =
  | 'http_4xx'
  | 'http_5xx'
  | 'connection_error'
  | 'timeout'
  | 'robots_blocked'
  | 'quality_gated'
  | 'content_filtered'
  | 'ssrf_blocked'
  | 'crawl_error';

export interface ICrawlError {
  _id: string;
  tenantId: string;
  crawlJobId: string;
  url: string;
  type: CrawlErrorType;
  error: string; // Sanitized error message
  statusCode?: number;
  timestamp: Date;
  createdAt: Date;
}

const crawlErrorSchema = new Schema<ICrawlError>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true, index: true },
    crawlJobId: { type: String, required: true, index: true },
    url: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: [
        'http_4xx',
        'http_5xx',
        'connection_error',
        'timeout',
        'robots_blocked',
        'quality_gated',
        'content_filtered',
        'ssrf_blocked',
        'crawl_error',
      ],
    },
    error: { type: String, required: true },
    statusCode: { type: Number },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'crawl_errors',
  },
);

// Compound index for /pages queries: tenant + job + time-ordered
crawlErrorSchema.index({ tenantId: 1, crawlJobId: 1, timestamp: -1 });

// TTL index: auto-delete after 90 days
crawlErrorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

crawlErrorSchema.plugin(tenantIsolationPlugin);

export const CrawlError =
  (mongoose.models.CrawlError as mongoose.Model<ICrawlError>) ||
  model<ICrawlError>('CrawlError', crawlErrorSchema);
