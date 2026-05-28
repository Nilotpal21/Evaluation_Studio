/**
 * Tenant Attachment Configuration Model
 *
 * Per-tenant configuration for attachment handling: file size limits,
 * allowed/blocked MIME types, scan/processing/embedding toggles, and
 * per-session/storage quotas.
 *
 * One config per tenant (unique index on tenantId). When no config
 * exists, the multimodal service falls back to platform defaults.
 *
 * Tenant-scoped via tenantIsolationPlugin — all queries must include tenantId.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// =============================================================================
// INTERFACE
// =============================================================================

export interface ITenantAttachmentConfig {
  _id: string;
  tenantId: string;

  /** Maximum file size in bytes per upload. Default: 20 MB */
  maxFileSizeBytes: number;

  /**
   * Allowed MIME types. Empty array means all types are allowed
   * (subject to blockedMimeTypes).
   */
  allowedMimeTypes: string[];

  /**
   * Blocked MIME types. Takes precedence over allowedMimeTypes.
   * Empty array means nothing is explicitly blocked.
   */
  blockedMimeTypes: string[];

  /** Whether virus scanning is enabled for this tenant. */
  scanEnabled: boolean;

  /** Whether file processing (image resize, doc parsing, transcription) is enabled. */
  processingEnabled: boolean;

  /** Whether search/embedding indexing is enabled for processed content. */
  embeddingEnabled: boolean;

  /** PII handling policy for attachment content before LLM injection. Default: 'redact' */
  piiPolicy: 'redact' | 'block' | 'allow';

  /** Maximum number of attachments allowed per session. */
  maxAttachmentsPerSession: number;

  /** Maximum total storage in bytes across all attachments for this tenant. */
  maxTotalStorageBytes: number;

  retentionDays: {
    image: number;
    document: number;
    audio: number;
    video: number;
  };

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// SCHEMA
// =============================================================================

const TenantAttachmentConfigSchema = new Schema<ITenantAttachmentConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },

    maxFileSizeBytes: { type: Number, default: 20 * 1024 * 1024 }, // 20 MB
    allowedMimeTypes: { type: [String], default: [] },
    blockedMimeTypes: { type: [String], default: [] },
    scanEnabled: { type: Boolean, default: true },
    processingEnabled: { type: Boolean, default: true },
    embeddingEnabled: { type: Boolean, default: true },
    piiPolicy: { type: String, default: 'redact', enum: ['redact', 'block', 'allow'] },
    maxAttachmentsPerSession: { type: Number, default: 100 },
    maxTotalStorageBytes: { type: Number, default: 1024 * 1024 * 1024 }, // 1 GB

    retentionDays: {
      image: { type: Number, default: 90 },
      document: { type: Number, default: 90 },
      audio: { type: Number, default: 90 },
      video: { type: Number, default: 90 },
    },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'tenant_attachment_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

TenantAttachmentConfigSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// One config per tenant
TenantAttachmentConfigSchema.index({ tenantId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const TenantAttachmentConfig =
  (mongoose.models.TenantAttachmentConfig as any) ||
  model<ITenantAttachmentConfig>('TenantAttachmentConfig', TenantAttachmentConfigSchema);
