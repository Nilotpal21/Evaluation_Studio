/**
 * Attachment Model
 *
 * Stores metadata about uploaded files (images, documents, audio, video)
 * for the multimodal service. Tracks file storage references, security
 * scan status, processing state, and search/embedding integration.
 * Tenant-scoped via denormalized tenantId.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAttachment {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string;
  messageId: string | null;

  // File metadata
  originalFilename: string;
  mimeType: string;
  detectedMimeType: string | null;
  category: 'image' | 'document' | 'audio' | 'video';
  sizeBytes: number;
  contentHash: string | null;

  // Storage reference
  storageProvider: string;
  storageKey: string;
  storageBucket: string;
  encrypted: boolean;
  encryptionKeyVersion: number;

  // Security
  scanStatus: 'pending' | 'clean' | 'infected' | 'error';
  scanEngine: string | null;
  scannedAt: Date | null;
  hasPII: boolean;
  piiDetections: { type: string; start: number; end: number; value: string }[];
  exifStripped: boolean;

  // Processing mode
  processingMode: 'full' | 'scan-only' | 'store-raw';

  // Processing state
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  processedContent: string | null;
  processedContentHash: string | null;
  processingError: string | null;
  processingEngine: string | null;
  processedAt: Date | null;

  // Image-specific
  resizedStorageKey: string | null;
  resizedSizeBytes: number | null;
  thumbnailStorageKey: string | null;

  // Video frame storage
  frameStorageKeys: string[];

  // Image description
  imageDescription: string | null;
  imageDescriptionModel: string | null;

  // Search AI integration
  searchIndexId: string | null;
  searchDocumentId: string | null;
  embeddingStatus: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  embeddedAt: Date | null;

  // Retry tracking
  retryCount: number;

  // Lifecycle
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _v: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AttachmentSchema = new Schema<IAttachment>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    sessionId: { type: String, required: true },
    messageId: { type: String, default: null },

    // File metadata
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    detectedMimeType: { type: String, default: null },
    category: {
      type: String,
      required: true,
      enum: ['image', 'document', 'audio', 'video'],
    },
    sizeBytes: { type: Number, required: true, min: 1 },
    contentHash: { type: String, default: null },

    // Storage reference
    storageProvider: { type: String, required: true },
    storageKey: { type: String, required: true },
    storageBucket: { type: String, required: true },
    encrypted: { type: Boolean, default: true },
    encryptionKeyVersion: { type: Number, default: 0 },

    // Security
    scanStatus: {
      type: String,
      default: 'pending',
      enum: ['pending', 'clean', 'infected', 'error'],
    },
    scanEngine: { type: String, default: null },
    scannedAt: { type: Date, default: null },
    hasPII: { type: Boolean, default: false },
    piiDetections: {
      type: [
        {
          type: { type: String, required: true },
          start: { type: Number, required: true },
          end: { type: Number, required: true },
          value: { type: String, required: true },
        },
      ],
      default: [],
    },
    exifStripped: { type: Boolean, default: false },

    // Processing mode
    processingMode: {
      type: String,
      default: 'full',
      enum: ['full', 'scan-only', 'store-raw'],
    },

    // Processing state
    processingStatus: {
      type: String,
      default: 'pending',
      enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
    },
    processedContent: { type: String, default: null },
    processedContentHash: { type: String, default: null },
    processingError: { type: String, default: null },
    processingEngine: { type: String, default: null },
    processedAt: { type: Date, default: null },

    // Image-specific
    resizedStorageKey: { type: String, default: null },
    resizedSizeBytes: { type: Number, default: null },
    thumbnailStorageKey: { type: String, default: null },

    // Video frame storage
    frameStorageKeys: { type: [String], default: [] },

    // Image description
    imageDescription: { type: String, default: null },
    imageDescriptionModel: { type: String, default: null },

    // Search AI integration
    searchIndexId: { type: String, default: null },
    searchDocumentId: { type: String, default: null },
    embeddingStatus: {
      type: String,
      default: 'pending',
      enum: ['pending', 'processing', 'completed', 'failed', 'skipped'],
    },
    embeddedAt: { type: Date, default: null },

    // Retry tracking
    retryCount: { type: Number, default: 0 },

    // Lifecycle
    expiresAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'attachments' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

AttachmentSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary query: list attachments for a session, newest first
AttachmentSchema.index({ tenantId: 1, sessionId: 1, createdAt: -1 });

// Lookup attachments for a specific message within a project
AttachmentSchema.index({ tenantId: 1, projectId: 1, messageId: 1 });

// Deduplication: find existing attachments by content hash (partial: only indexed when hash is set)
AttachmentSchema.index(
  { tenantId: 1, contentHash: 1 },
  { partialFilterExpression: { contentHash: { $exists: true } } },
);

// TTL index: auto-expire attachments after expiresAt
AttachmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Processing pipeline queries (cross-tenant): background workers poll across all tenants
AttachmentSchema.index({ scanStatus: 1, createdAt: 1 });

// Processing pipeline queries (cross-tenant): background workers poll across all tenants
AttachmentSchema.index({ processingStatus: 1, createdAt: 1 });

// Processing pipeline queries (cross-tenant): background workers poll across all tenants
AttachmentSchema.index({ embeddingStatus: 1, createdAt: 1 });

// Browse attachments by category within a project
AttachmentSchema.index({ tenantId: 1, projectId: 1, category: 1, createdAt: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const Attachment =
  (mongoose.models.Attachment as any) || model<IAttachment>('Attachment', AttachmentSchema);
