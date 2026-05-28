/**
 * Document Page Model
 *
 * Represents a single page extracted by Docling from a document.
 * Stores page-level content, layout, tables, images, and screenshots.
 *
 * Part of ATLAS-KG v2 pipeline:
 * Docling Extraction → DocumentPage → Page Processing → SearchChunk
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

export interface HeadingInfo {
  level: number;
  text: string;
  bbox?: BoundingBox;
}

export interface TableInfo {
  rows: string[][];
  headers: string[];
  html: string;
  markdown: string;
  bbox?: BoundingBox;
  isComplete: boolean;
}

export interface ImageInfo {
  s3Url: string;
  format: string;
  bbox?: BoundingBox;
  sizeBytes?: number;
}

export interface PageLayout {
  headings: HeadingInfo[];
  structure: any; // Docling's layout tree (arbitrary structure)
}

// ─── Document Interface ──────────────────────────────────────────────────────

export interface IDocumentPage {
  _id: string;
  tenantId: string;
  indexId: string;
  documentId: string;
  pageNumber: number;

  // Content from Docling
  text: string;
  tokenCount: number;

  // Layout from Docling
  layout: PageLayout;

  // Tables from Docling
  tables: TableInfo[];

  // Images from Docling (uploaded to S3)
  images: ImageInfo[];

  // Page screenshot (uploaded to S3)
  screenshot: string | null; // S3 URL

  // Processing status
  status: 'pending' | 'processed' | 'failed';

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Version for schema evolution
  _v: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const BoundingBoxSchema = new Schema<BoundingBox>(
  {
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    page: { type: Number, required: true },
  },
  { _id: false },
);

const HeadingInfoSchema = new Schema<HeadingInfo>(
  {
    level: { type: Number, required: true },
    text: { type: String, required: true },
    bbox: { type: BoundingBoxSchema, required: false },
  },
  { _id: false },
);

const TableInfoSchema = new Schema<TableInfo>(
  {
    rows: { type: [[String]], required: true },
    headers: { type: [String], required: true },
    html: { type: String, required: true },
    markdown: { type: String, required: true },
    bbox: { type: BoundingBoxSchema, required: false },
    isComplete: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

const ImageInfoSchema = new Schema<ImageInfo>(
  {
    s3Url: { type: String, required: true },
    format: { type: String, required: true },
    bbox: { type: BoundingBoxSchema, required: false },
    sizeBytes: { type: Number, required: false },
  },
  { _id: false },
);

const PageLayoutSchema = new Schema<PageLayout>(
  {
    headings: { type: [HeadingInfoSchema], default: [] },
    structure: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const DocumentPageSchema = new Schema<IDocumentPage>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    indexId: { type: String, required: true },
    documentId: { type: String, required: true },
    pageNumber: { type: Number, required: true },

    // Content (may be empty for image-only pages where OCR yields no text)
    text: { type: String, default: '' },
    tokenCount: { type: Number, required: true, default: 0 },

    // Layout
    layout: { type: PageLayoutSchema, required: true },

    // Tables
    tables: { type: [TableInfoSchema], default: [] },

    // Images
    images: { type: [ImageInfoSchema], default: [] },

    // Screenshot
    screenshot: { type: String, default: null },

    // Status
    status: {
      type: String,
      enum: ['pending', 'processed', 'failed'],
      default: 'pending',
    },

    // Version
    _v: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    collection: 'document_pages',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────────

DocumentPageSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// Primary lookup: by document
DocumentPageSchema.index({ documentId: 1, pageNumber: 1 });

// Tenant isolation
DocumentPageSchema.index({ tenantId: 1, indexId: 1 });

// Query by document + status
DocumentPageSchema.index({ documentId: 1, status: 1 });

// Query pending pages for processing
DocumentPageSchema.index({ status: 1, createdAt: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('DocumentPage', DocumentPageSchema, 'searchaicontent');

export const DocumentPage =
  (mongoose.models.DocumentPage as any) || model<IDocumentPage>('DocumentPage', DocumentPageSchema);
