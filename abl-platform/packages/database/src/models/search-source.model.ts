/**
 * Search Source Model
 *
 * Represents a data source connected to a search index.
 * Tracks source type, connection config, sync status, and extraction settings.
 *
 * For web crawl sources (sourceType: 'web'), the `crawlConfig` subdocument
 * stores permanent crawl configuration: profile, sections, settings, auth,
 * and per-section rendering strategies. This replaces the old CrawlDraft model.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Crawl Config Interfaces (web sources only) ─────────────────────────────

export type CrawlConfigWizardStep = 'profiling' | 'sections_ready' | 'configured' | 'submitted';

export type CrawlConfigStrategy = 'guided-discovery' | 'crawl-sitemap' | 'direct-urls';

export interface ICrawlConfigProfile {
  domain: string;
  siteType: string | null;
  hasSitemap: boolean;
  sitemapPageCount: number | null;
  jsRequired: boolean;
  estimatedSize: number | null;
  avgResponseTime: number | null;
  platform: string | null;
}

export interface ICrawlConfigSection {
  sectionId: string;
  pattern: string;
  name: string;
  source: 'sitemap' | 'explored' | 'auto' | 'direct';
  depth: number;
  pageCount: number;
  included: boolean;
  estimatedTime: number | null;
  warnings: string[];
  strategy: 'http' | 'browser';
  sitemapFile: string | null;
  sitemapOrigin: string | null;
}

export interface ICrawlConfigSettings {
  scope: 'limited' | 'full' | 'custom';
  rendering: 'http' | 'browser' | 'hybrid';
  maxPages: number;
  maxDepth: number;
  requestDelay: number;
  cleanup: 'aggressive' | 'standard' | 'none';
  respectRobotsTxt: boolean;
  deduplicate: boolean;
  cookieConsent: boolean;
  reuseHandlers: boolean;
}

export type CrawlConfigAuthMethod = 'none' | 'basic' | 'bearer' | 'headers' | 'cookies';

export interface ICrawlConfigAuth {
  method: CrawlConfigAuthMethod;
  basicUsername: string | null;
  basicPassword: string | null;
  bearerToken: string | null;
  customHeaders: Array<{ key: string; value: string }> | null;
  cookieString: string | null;
}

export interface ICrawlConfigGroupStrategy {
  pattern: string;
  method: 'http' | 'playwright';
  reason: string | null;
}

export interface ICrawlConfig {
  wizardStep: CrawlConfigWizardStep | null;
  strategy: CrawlConfigStrategy | null;
  profile: ICrawlConfigProfile | null;
  sections: ICrawlConfigSection[] | null;
  settings: ICrawlConfigSettings | null;
  auth: ICrawlConfigAuth | null;
  groupStrategies: ICrawlConfigGroupStrategy[] | null;
  configVersion: number;
  crawlJobId: string | null;
  configExpiresAt: Date | null;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface ISearchSource {
  _id: string;
  tenantId: string;
  indexId: string;
  name: string;
  sourceType: string;
  /** Connection/auth config (encrypted at rest) */
  sourceConfig: any;
  status: string;
  /** Extraction settings */
  extractionConfig: any | null;
  /** Enrichment settings */
  enrichmentConfig: any | null;
  /** Sync schedule (cron expression) */
  syncSchedule: string | null;
  documentCount: number;
  lastSyncAt: Date | null;
  syncError: string | null;
  /** User who created this source (ownership guard for wizard) */
  createdBy: string | null;
  /** Web crawl configuration subdocument (sourceType: 'web' only) */
  crawlConfig: ICrawlConfig | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Crawl Config Sub-schemas ────────────────────────────────────────────

const crawlConfigProfileSchema = new Schema<ICrawlConfigProfile>(
  {
    domain: { type: String, required: true },
    siteType: { type: String, default: null },
    hasSitemap: { type: Boolean, default: false },
    sitemapPageCount: { type: Number, default: null },
    jsRequired: { type: Boolean, default: false },
    estimatedSize: { type: Number, default: null },
    avgResponseTime: { type: Number, default: null },
    platform: { type: String, default: null },
  },
  { _id: false },
);

const crawlConfigSectionSchema = new Schema<ICrawlConfigSection>(
  {
    sectionId: { type: String, required: true },
    pattern: { type: String, required: true },
    name: { type: String, required: true },
    source: {
      type: String,
      required: true,
      enum: ['sitemap', 'explored', 'auto', 'direct'],
    },
    depth: { type: Number, default: 0 },
    pageCount: { type: Number, default: 0 },
    included: { type: Boolean, default: true },
    estimatedTime: { type: Number, default: null },
    warnings: { type: [String], default: [] },
    strategy: { type: String, enum: ['http', 'browser'], default: 'http' },
    sitemapFile: { type: String, default: null },
    sitemapOrigin: { type: String, default: null },
  },
  { _id: false },
);

const crawlConfigSettingsSchema = new Schema<ICrawlConfigSettings>(
  {
    scope: {
      type: String,
      enum: ['limited', 'full', 'custom'],
      default: 'limited',
    },
    rendering: {
      type: String,
      enum: ['http', 'browser', 'hybrid'],
      default: 'http',
    },
    maxPages: { type: Number, default: 1000 },
    maxDepth: { type: Number, default: 3 },
    requestDelay: { type: Number, default: 1000 },
    cleanup: {
      type: String,
      enum: ['aggressive', 'standard', 'none'],
      default: 'standard',
    },
    respectRobotsTxt: { type: Boolean, default: true },
    deduplicate: { type: Boolean, default: true },
    cookieConsent: { type: Boolean, default: false },
    reuseHandlers: { type: Boolean, default: false },
  },
  { _id: false },
);

const crawlConfigAuthHeaderSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
  },
  { _id: false },
);

const crawlConfigAuthSchema = new Schema<ICrawlConfigAuth>(
  {
    method: {
      type: String,
      enum: ['none', 'basic', 'bearer', 'headers', 'cookies'],
      default: 'none',
    },
    basicUsername: { type: String, default: null },
    basicPassword: { type: String, default: null },
    bearerToken: { type: String, default: null },
    customHeaders: { type: [crawlConfigAuthHeaderSchema], default: null },
    cookieString: { type: String, default: null },
  },
  { _id: false },
);

const crawlConfigGroupStrategySchema = new Schema<ICrawlConfigGroupStrategy>(
  {
    pattern: { type: String, required: true },
    method: {
      type: String,
      enum: ['http', 'playwright'],
      required: true,
    },
    reason: { type: String, default: null },
  },
  { _id: false },
);

const crawlConfigSchema = new Schema<ICrawlConfig>(
  {
    wizardStep: {
      type: String,
      enum: ['profiling', 'sections_ready', 'configured', 'submitted'],
      default: null,
    },
    strategy: {
      type: String,
      enum: ['guided-discovery', 'crawl-sitemap', 'direct-urls'],
      default: null,
    },
    profile: { type: crawlConfigProfileSchema, default: null },
    sections: { type: [crawlConfigSectionSchema], default: null },
    settings: { type: crawlConfigSettingsSchema, default: null },
    auth: { type: crawlConfigAuthSchema, default: null },
    groupStrategies: { type: [crawlConfigGroupStrategySchema], default: null },
    configVersion: { type: Number, default: 1 },
    crawlJobId: { type: String, default: null },
    configExpiresAt: { type: Date, default: null },
  },
  { _id: false },
);

// ─── Main Schema ─────────────────────────────────────────────────────────

const SearchSourceSchema = new Schema<ISearchSource>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    name: { type: String, required: true },
    sourceType: { type: String, required: true },
    sourceConfig: { type: Schema.Types.Mixed, default: null },
    status: { type: String, required: true, default: 'pending' },
    extractionConfig: { type: Schema.Types.Mixed, default: null },
    enrichmentConfig: { type: Schema.Types.Mixed, default: null },
    syncSchedule: { type: String, default: null },
    documentCount: { type: Number, default: 0 },
    lastSyncAt: { type: Date, default: null },
    syncError: { type: String, default: null },
    createdBy: { type: String, default: null },
    crawlConfig: { type: crawlConfigSchema, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'search_sources' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

SearchSourceSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

SearchSourceSchema.index({ tenantId: 1, indexId: 1 });
SearchSourceSchema.index({ indexId: 1, status: 1 });
SearchSourceSchema.index({ sourceType: 1 });

// TTL index — auto-delete abandoned configuring sources after configExpiresAt
SearchSourceSchema.index(
  { 'crawlConfig.configExpiresAt': 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { status: 'configuring' },
  },
);

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('SearchSource', SearchSourceSchema, 'searchaicontent');

export const SearchSource =
  (mongoose.models.SearchSource as any) || model<ISearchSource>('SearchSource', SearchSourceSchema);
