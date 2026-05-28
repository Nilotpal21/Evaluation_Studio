/**
 * SiteDiscovery Model
 *
 * Generic per-domain discovery data shared across tenants — no tenant scoping
 * by design. Stores navigation structure, discovered URLs, site profile, and
 * tree hierarchy. Stored in the searchaicontent database.
 *
 * TENANT_PLUGIN_EXCEPTION — this model is intentionally cross-tenant. The
 * tenant-isolation-lint flags any model file that contains the literal
 * string "tenantId" but doesn't register tenantIsolationPlugin. The previous
 * comment referenced "tenantId" textually; this marker tells the lint the
 * absence is intentional.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

export interface IDiscoveredPage {
  url: string;
  foundOn: string[];
  renderMethod: 'http' | 'browser' | 'unknown';
  visited: boolean;
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  childUrls: string[];
  title?: string;
  pageRole?: 'hub' | 'leaf' | 'mixed';
  errorMessage?: string;
  lastVisitedAt?: Date;
  // === V2 provenance ===
  discoverySource?:
    | 'primary'
    | 'seed'
    | 'nav'
    | 'breadcrumb-climb'
    | 'bfs'
    | 'user-command'
    | 'sitemap';
  linkText?: string;
  breadcrumbLabel?: string;
  discoveredAt?: number;
  // === V2 computed ===
  linkFrequency?: number;
  isGlobalLink?: boolean;
}

export interface ITreeNode {
  url: string;
  label: string;
  children: ITreeNode[];
  depth: number;
  visited: boolean;
  renderMethod: 'http' | 'browser' | 'unknown';
  pageRole?: 'hub' | 'leaf' | 'mixed';
  status: 'discovered' | 'visiting' | 'visited' | 'error';
  // === V2 enrichment ===
  foundOn?: string[];
  discoverySource?: string;
  isGlobalLink?: boolean;
  isVirtual?: boolean;
  childPageCount?: number;
  errorMessage?: string;
}

export interface ISiteProfile {
  platform?: string;
  jsRequired: boolean;
  estimatedPageCount?: number;
  sitemapFound: boolean;
  sitemapUrlCount?: number;
}

export interface ISiteDiscovery {
  _id: string;
  domain: string;
  navStructure: Array<{
    label: string;
    href?: string;
    depth: number;
    children: unknown[];
    source: string;
    estimatedChildren?: number;
  }>;
  discoveredUrls: IDiscoveredPage[];
  treeHierarchy: ITreeNode[];
  siteProfile: ISiteProfile;
  sitemapUrls: string[];
  breadcrumbChains: Array<{
    sourceUrl: string;
    crumbs: Array<{ text: string; href: string; depth: number }>;
    strategy: string;
  }>;
  lastDiscoveryAt: Date;
  totalPagesVisited: number;
  totalUrlsFound: number;
  createdAt: Date;
  updatedAt: Date;
}

const discoveredPageSchema = new Schema<IDiscoveredPage>(
  {
    url: { type: String, required: true },
    foundOn: [{ type: String }],
    renderMethod: {
      type: String,
      enum: ['http', 'browser', 'unknown'],
      default: 'unknown',
    },
    visited: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['discovered', 'visiting', 'visited', 'error'],
      default: 'discovered',
    },
    childUrls: [{ type: String }],
    title: String,
    pageRole: { type: String, enum: ['hub', 'leaf', 'mixed'] },
    errorMessage: String,
    lastVisitedAt: Date,
    discoverySource: {
      type: String,
      enum: ['primary', 'seed', 'nav', 'breadcrumb-climb', 'bfs', 'user-command', 'sitemap'],
    },
    linkText: { type: String },
    breadcrumbLabel: { type: String },
    discoveredAt: { type: Number },
    linkFrequency: { type: Number },
    isGlobalLink: { type: Boolean },
  },
  { _id: false },
);

const treeNodeSchema = new Schema(
  {
    url: { type: String, required: true },
    label: { type: String, required: true },
    children: [{ type: Schema.Types.Mixed }],
    depth: { type: Number, required: true },
    visited: { type: Boolean, default: false },
    renderMethod: {
      type: String,
      enum: ['http', 'browser', 'unknown'],
      default: 'unknown',
    },
    pageRole: { type: String, enum: ['hub', 'leaf', 'mixed'], required: false },
    status: {
      type: String,
      enum: ['discovered', 'visiting', 'visited', 'error'],
      default: 'discovered',
    },
    foundOn: { type: [String], default: undefined },
    discoverySource: { type: String },
    isGlobalLink: { type: Boolean },
    isVirtual: { type: Boolean },
    childPageCount: { type: Number },
    errorMessage: { type: String },
  },
  { _id: false },
);

const siteProfileSchema = new Schema<ISiteProfile>(
  {
    platform: String,
    jsRequired: { type: Boolean, default: false },
    estimatedPageCount: Number,
    sitemapFound: { type: Boolean, default: false },
    sitemapUrlCount: Number,
  },
  { _id: false },
);

const breadcrumbChainSchema = new Schema(
  {
    sourceUrl: { type: String, required: true },
    crumbs: [
      {
        text: { type: String, required: true },
        href: { type: String, required: true },
        depth: { type: Number, required: true },
      },
    ],
    strategy: { type: String, required: true },
  },
  { _id: false },
);

export const siteDiscoverySchema = new Schema<ISiteDiscovery>(
  {
    _id: { type: String, default: uuidv7 },
    domain: { type: String, required: true },
    navStructure: [{ type: Schema.Types.Mixed }],
    discoveredUrls: [discoveredPageSchema],
    treeHierarchy: [treeNodeSchema],
    siteProfile: { type: siteProfileSchema, default: () => ({}) },
    sitemapUrls: [{ type: String }],
    breadcrumbChains: [breadcrumbChainSchema],
    lastDiscoveryAt: { type: Date, default: Date.now },
    totalPagesVisited: { type: Number, default: 0 },
    totalUrlsFound: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Indexes
siteDiscoverySchema.index({ domain: 1 }, { unique: true });
siteDiscoverySchema.index({ updatedAt: 1 });

// HMR guard (standard ESM pattern — matches crawl-job.model.ts)
export const SiteDiscovery =
  (mongoose.models.SiteDiscovery as mongoose.Model<ISiteDiscovery>) ||
  model<ISiteDiscovery>('SiteDiscovery', siteDiscoverySchema);
