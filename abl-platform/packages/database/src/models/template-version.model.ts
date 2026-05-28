/**
 * Template Version Model
 *
 * Stores versioned snapshots of template content.
 * Each version contains the full manifest (agents, config, etc.)
 * and an optional customization schema for variable substitution.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface ITemplateVersion {
  _id: string;
  templateId: string;
  version: string;
  changelog: string;
  manifest: Record<string, unknown>; // Typed as ProjectManifestV2 at application layer
  files: Record<string, string> | null; // Import-ready bundle, max 4MB
  customizationSchema: Record<string, unknown> | null;
  status: string;
  publishedAt: Date | null;
  createdBy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const TemplateVersionSchema = new Schema<ITemplateVersion>(
  {
    _id: { type: String, default: uuidv7 },
    templateId: { type: String, required: true },
    version: { type: String, required: true },
    changelog: { type: String, required: true },
    manifest: { type: Schema.Types.Mixed, required: true },
    files: { type: Schema.Types.Mixed, default: null },
    customizationSchema: { type: Schema.Types.Mixed, default: null },
    status: { type: String, default: 'draft' },
    publishedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'template_versions' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

TemplateVersionSchema.index({ templateId: 1, version: 1 }, { unique: true });
TemplateVersionSchema.index({ templateId: 1, status: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const TemplateVersion =
  (mongoose.models.TemplateVersion as any) ||
  model<ITemplateVersion>('TemplateVersion', TemplateVersionSchema);
