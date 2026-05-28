/**
 * Project Attachment Configuration Model
 *
 * Per-project overrides for attachment handling: file size limits,
 * allowed MIME types, PII policy, and default processing mode.
 *
 * One config per project (unique index on tenantId + projectId).
 * When no config exists, the runtime falls back to tenant-level defaults
 * via TenantAttachmentConfig, then platform defaults.
 *
 * Resolution path:
 *   project-attachment-config → tenant-attachment-config → platform defaults
 *
 * Tenant-scoped via tenantIsolationPlugin — all queries must include tenantId.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// =============================================================================
// INTERFACE
// =============================================================================

export interface IProjectAttachmentConfig {
  _id: string;
  tenantId: string;
  projectId: string;

  /** Whether attachments are enabled for this project. Null = inherit from tenant. */
  enabled?: boolean | null;

  /** Maximum file size in bytes per upload. Null = inherit from tenant. */
  maxFileSizeBytes?: number | null;

  /** Allowed MIME types. Null = inherit from tenant. Empty array = all types allowed. */
  allowedMimeTypes?: string[] | null;

  /** PII handling policy. Null = inherit from tenant. */
  piiPolicy?: 'redact' | 'block' | 'allow' | null;

  /** Default processing mode for new uploads. */
  defaultProcessingMode?: 'full' | 'metadata_only' | 'skip' | null;

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// SCHEMA
// =============================================================================

const ProjectAttachmentConfigSchema = new Schema<IProjectAttachmentConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },

    enabled: { type: Boolean, default: null },
    maxFileSizeBytes: { type: Number, default: null },
    allowedMimeTypes: { type: [String], default: null },
    piiPolicy: {
      type: String,
      default: null,
      enum: ['redact', 'block', 'allow', null],
    },
    defaultProcessingMode: {
      type: String,
      default: null,
      enum: ['full', 'metadata_only', 'skip', null],
    },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_attachment_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectAttachmentConfigSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// One config per project per tenant
ProjectAttachmentConfigSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectAttachmentConfig =
  (mongoose.models.ProjectAttachmentConfig as any) ||
  model<IProjectAttachmentConfig>('ProjectAttachmentConfig', ProjectAttachmentConfigSchema);
