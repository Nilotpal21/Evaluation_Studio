/**
 * Template Analytics Event Model
 *
 * Stores analytics events for the Template Store.
 * Events include marketplace views, detail views, searches,
 * category browsing, and install tracking.
 *
 * Documents auto-expire after 90 days via TTL index on createdAt.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITemplateAnalyticsEvent {
  _id: string;
  eventType: string;
  templateId: string | null;
  templateSlug: string | null;
  userId: string | null;
  tenantId: string | null;
  metadata: Record<string, unknown> | null;
  ipHash: string | null;
  userAgent: string | null;
  createdAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TemplateAnalyticsEventSchema = new Schema<ITemplateAnalyticsEvent>(
  {
    _id: { type: String, default: uuidv7 },
    eventType: { type: String, required: true },
    templateId: { type: String, default: null },
    templateSlug: { type: String, default: null },
    userId: { type: String, default: null },
    tenantId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    ipHash: { type: String, default: null },
    userAgent: { type: String, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: 'template_analytics_events' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

TemplateAnalyticsEventSchema.index({ eventType: 1, createdAt: -1 });
TemplateAnalyticsEventSchema.index({ templateId: 1, eventType: 1 });
TemplateAnalyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

// ─── Model ───────────────────────────────────────────────────────────────

export const TemplateAnalyticsEvent =
  (mongoose.models.TemplateAnalyticsEvent as any) ||
  model<ITemplateAnalyticsEvent>('TemplateAnalyticsEvent', TemplateAnalyticsEventSchema);
