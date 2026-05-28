/**
 * Source URL Bucket Model
 *
 * Stores URLs for web crawl source sections using the bucket pattern.
 * Each document holds up to URL_BUCKET_SIZE (500) URLs for one section.
 * This prevents unbounded array growth that would hit MongoDB's 16MB BSON limit.
 *
 * A section with 50,000 URLs produces 100 bucket documents (~100KB each).
 * Pagination is O(1): compute target bucket from offset, fetch 1-2 buckets, slice.
 *
 * Re-keyed from CrawlDraftUrlBucket: draftId → sourceId.
 *
 * Lifecycle: created during discovery/URL storage → deleted by worker on
 * crawl start → TTL-cleaned if abandoned (30 days via configExpiresAt).
 *
 * Database: searchaicontent (co-located with SearchSource for cascade delete).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max URLs per bucket document. 500 × ~200 bytes = ~100KB per doc. */
export const SOURCE_URL_BUCKET_SIZE = 500;

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ISourceBucketUrl {
  url: string;
  title: string | null;
  score: number | null;
  depth: number;
}

export interface ISourceUrlBucket {
  _id: string;
  tenantId: string;
  sourceId: string;
  sectionId: string;
  bucketIndex: number;

  urls: ISourceBucketUrl[];
  urlCount: number;

  /** TTL — copied from parent source, auto-delete when parent expires */
  configExpiresAt: Date | null;

  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const sourceBucketUrlSchema = new Schema<ISourceBucketUrl>(
  {
    url: { type: String, required: true },
    title: { type: String, default: null },
    score: { type: Number, default: null },
    depth: { type: Number, default: 0 },
  },
  { _id: false },
);

const sourceUrlBucketSchema = new Schema<ISourceUrlBucket>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    sourceId: { type: String, required: true },
    sectionId: { type: String, required: true },
    bucketIndex: { type: Number, required: true },

    urls: { type: [sourceBucketUrlSchema], default: [] },
    urlCount: { type: Number, default: 0 },

    configExpiresAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'source_url_buckets',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────────

sourceUrlBucketSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Primary lookup + ordered pagination (unique: one bucket per section per index)
sourceUrlBucketSchema.index(
  { tenantId: 1, sourceId: 1, sectionId: 1, bucketIndex: 1 },
  { unique: true },
);

// Cascade delete all buckets for a source
sourceUrlBucketSchema.index({ sourceId: 1 });

// TTL: auto-delete when parent source expires (same configExpiresAt timestamp)
sourceUrlBucketSchema.index({ configExpiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('SourceUrlBucket', sourceUrlBucketSchema, 'searchaicontent');

export const SourceUrlBucket =
  (mongoose.models.SourceUrlBucket as mongoose.Model<ISourceUrlBucket>) ||
  model<ISourceUrlBucket>('SourceUrlBucket', sourceUrlBucketSchema);
