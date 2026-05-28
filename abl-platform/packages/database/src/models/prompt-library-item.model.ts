/**
 * Prompt Library Item Model
 *
 * Stores prompt templates within a project.
 * Each item can have multiple versions (see prompt-library-version.model.ts).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export type PromptLibraryItemStatus = 'active' | 'archived';

export interface IPromptLibraryItem {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  tags: string[];
  usageCount: number;
  nextVersionNumber: number;
  status: PromptLibraryItemStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const PromptLibraryItemSchema = new Schema<IPromptLibraryItem>(
  {
    _id: { type: String, default: () => 'pl_' + uuidv7() },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 128 },
    description: { type: String, maxlength: 512 },
    tags: { type: [String], default: [] },
    usageCount: { type: Number, default: 0 },
    nextVersionNumber: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'prompt_library_items' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

PromptLibraryItemSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

PromptLibraryItemSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
PromptLibraryItemSchema.index({ tenantId: 1, projectId: 1, status: 1 });
PromptLibraryItemSchema.index({ tenantId: 1, projectId: 1, tags: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const PromptLibraryItem =
  (mongoose.models.PromptLibraryItem as any) ||
  model<IPromptLibraryItem>('PromptLibraryItem', PromptLibraryItemSchema);
