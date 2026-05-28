/**
 * Handler Template Model
 *
 * Persists IPageHandler objects (Playwright steps + extraction selectors) generated
 * by the crawl intelligence system for reuse across sessions.
 *
 * Design:
 * - One document per unique handler fingerprint per domain per tenant
 * - TTL-based expiration (templates expire after 90 days of no use)
 * - Tenant-scoped for multi-tenancy
 * - Tracks success/failure counts for confidence scoring
 *
 * Usage:
 * 1. After building a handler, upsert template with fingerprint
 * 2. Before building, check if matching template exists
 * 3. Update success/failure counts after replay
 * 4. Periodic cleanup via MongoDB TTL index on lastUsedAt
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IHandlerTemplateStep {
  action: string;
  selector?: string;
  value?: string;
  description: string;
}

export interface IHandlerTemplateExtractionSelectors {
  title?: string;
  content: string;
  metadata?: Record<string, string>;
}

export interface IHandlerTemplateHandler {
  urlPattern: string;
  description: string;
  steps: IHandlerTemplateStep[];
  extractionSelectors: IHandlerTemplateExtractionSelectors;
}

export interface IHandlerTemplate {
  _id: string;
  tenantId: string;
  domain: string; // e.g. "example.com"
  urlPattern: string; // from IPageHandler
  fingerprint: string; // hex string (BigInt serialized via TemplateFingerprinter.toSerializable)
  handler: IHandlerTemplateHandler;
  trainedOn: string[]; // URLs this handler was trained on
  successCount: number; // times reuse succeeded (default 0)
  failureCount: number; // times reuse failed (default 0)
  confidence: number; // 0-1, derived from success/failure ratio
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const HandlerTemplateStepSchema = new Schema(
  {
    action: { type: String, required: true },
    selector: { type: String },
    value: { type: String },
    description: { type: String, required: true },
  },
  { _id: false },
);

const HandlerTemplateExtractionSelectorsSchema = new Schema(
  {
    title: { type: String },
    content: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const HandlerTemplateHandlerSchema = new Schema(
  {
    urlPattern: { type: String, required: true },
    description: { type: String, required: true },
    steps: { type: [HandlerTemplateStepSchema], required: true, default: [] },
    extractionSelectors: {
      type: HandlerTemplateExtractionSelectorsSchema,
      required: true,
    },
  },
  { _id: false },
);

const HandlerTemplateSchema = new Schema<IHandlerTemplate>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    domain: { type: String, required: true },
    urlPattern: { type: String, required: true },
    fingerprint: { type: String, required: true },
    handler: { type: HandlerTemplateHandlerSchema, required: true },
    trainedOn: { type: [String], default: [] },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    lastUsedAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    collection: 'handler_templates',
  },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Unique index: one template per fingerprint per domain per tenant
HandlerTemplateSchema.index({ tenantId: 1, domain: 1, fingerprint: 1 }, { unique: true });

// Query index: find templates by domain
HandlerTemplateSchema.index({ tenantId: 1, domain: 1 });

// TTL index: expire templates after 90 days of no use
HandlerTemplateSchema.index(
  { lastUsedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }, // 90 days
);

// ─── Plugins ─────────────────────────────────────────────────────────────

HandlerTemplateSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const HandlerTemplate =
  (mongoose.models.HandlerTemplate as mongoose.Model<IHandlerTemplate>) ||
  model<IHandlerTemplate>('HandlerTemplate', HandlerTemplateSchema);
