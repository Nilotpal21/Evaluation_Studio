/**
 * Template Model
 *
 * Stores template definitions in the Template Store.
 * Templates can represent agents, projects, or other reusable configurations
 * that can be browsed, searched, and installed by users.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Sub-Schema Interfaces ──────────────────────────────────────────────

export interface ITemplateMedia {
  type: 'image' | 'video';
  url: string;
  thumbnailUrl?: string; // video poster frame
  caption: string;
  order: number;
}

export interface ITemplatePrerequisites {
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
  models: string[];
}

export interface IDemoConversationMessage {
  role: string;
  content: string;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITemplate {
  _id: string;
  slug: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  type: string;
  typeMetadata: Record<string, unknown> | null;
  detailSections: string[];
  category: string;
  subcategory: string | null;
  industries: string[];
  tags: string[];
  complexity: string;
  publisherId: string;
  publisherTenantId: string;
  publisherName: string;
  publisherVerified: boolean;
  visibility: string;
  status: string;
  installCount: number;
  activeInstallCount: number;
  viewCount: number;
  ratingAverage: number;
  ratingCount: number;
  featuredOrder: number | null;
  publishedAt: Date | null;
  deprecatedAt: Date | null;
  deprecationMessage: string | null;
  sourceId: string | null;
  sourceType: string | null;
  media: ITemplateMedia[];
  prerequisites: ITemplatePrerequisites;
  reviewStatus: string; // 'approved' | 'pending' | 'rejected'
  demoConversation: IDemoConversationMessage[];
  iconUrl: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-Schemas ─────────────────────────────────────────────────────────

const MediaSchema = new Schema<ITemplateMedia>(
  {
    type: { type: String, required: true, enum: ['image', 'video'] },
    url: { type: String, required: true },
    thumbnailUrl: { type: String, default: undefined },
    caption: { type: String, required: true },
    order: { type: Number, required: true },
  },
  { _id: false },
);

const PrerequisitesSchema = new Schema<ITemplatePrerequisites>(
  {
    envVars: { type: [String], default: [] },
    connectors: { type: [String], default: [] },
    mcpServers: { type: [String], default: [] },
    authProfiles: { type: [String], default: [] },
    models: { type: [String], default: [] },
  },
  { _id: false },
);

const DemoConversationMessageSchema = new Schema<IDemoConversationMessage>(
  {
    role: { type: String, required: true },
    content: { type: String, required: true },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const TemplateSchema = new Schema<ITemplate>(
  {
    _id: { type: String, default: uuidv7 },
    slug: { type: String, required: true },
    name: { type: String, required: true },
    shortDescription: { type: String, required: true },
    longDescription: { type: String, required: true },
    type: { type: String, required: true },
    typeMetadata: { type: Schema.Types.Mixed, default: null },
    detailSections: { type: [String], default: [] },
    category: { type: String, required: true },
    subcategory: { type: String, default: null },
    industries: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    complexity: { type: String, required: true },
    publisherId: { type: String, required: true },
    publisherTenantId: { type: String, required: true },
    publisherName: { type: String, required: true },
    publisherVerified: { type: Boolean, default: false },
    visibility: { type: String, default: 'draft' },
    status: { type: String, default: 'draft' },
    installCount: { type: Number, default: 0 },
    activeInstallCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
    ratingAverage: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    featuredOrder: { type: Number, default: null },
    publishedAt: { type: Date, default: null },
    deprecatedAt: { type: Date, default: null },
    deprecationMessage: { type: String, default: null },
    sourceId: { type: String, default: null },
    sourceType: { type: String, default: null },
    media: { type: [MediaSchema], default: [] },
    prerequisites: {
      type: PrerequisitesSchema,
      default: () => ({
        envVars: [],
        connectors: [],
        mcpServers: [],
        authProfiles: [],
        models: [],
      }),
    },
    reviewStatus: { type: String, default: 'approved' },
    demoConversation: { type: [DemoConversationMessageSchema], default: [] },
    iconUrl: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'templates' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

TemplateSchema.index({ slug: 1 }, { unique: true });
TemplateSchema.index({ type: 1, category: 1, status: 1 });
TemplateSchema.index({ status: 1, visibility: 1 });
TemplateSchema.index({ publisherTenantId: 1 });
TemplateSchema.index({ tags: 1 });
TemplateSchema.index({ name: 'text', shortDescription: 'text', tags: 'text' });

// ─── Model ───────────────────────────────────────────────────────────────

export const Template =
  (mongoose.models.Template as any) || model<ITemplate>('Template', TemplateSchema);
