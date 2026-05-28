/**
 * Project Tool Model
 *
 * Single-document tool definition for DSL-native tools. Stores the complete
 * tool DSL (signature + implementation) in `dslContent`, with denormalized
 * `toolType` and `description` for fast listing/filtering.
 *
 * Replaces the old `tools` + `tool_versions` two-collection model.
 * No versioning, no publish/draft. Agent versions snapshot tool state.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Constants ──────────────────────────────────────────────────────────

export const PROJECT_TOOL_TYPES = ['http', 'mcp', 'sandbox', 'searchai', 'workflow'] as const;
export type ProjectToolType = (typeof PROJECT_TOOL_TYPES)[number];

/** Maximum dslContent size: 512KB */
const MAX_DSL_CONTENT_SIZE = 512 * 1024;

/** Maximum description length: 2048 chars */
const MAX_DESCRIPTION_LENGTH = 2048;

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProjectTool {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  slug: string;
  toolType: ProjectToolType;
  description: string | null;
  dslContent: string;
  sourceHash: string;
  variableNamespaceIds: string[];
  /**
   * Denormalized auth-profile reference. Set by the save handler whenever
   * dslContent changes, by resolving the DSL's `auth_profile: <name>` literal
   * to the matching AuthProfile._id in the same tenant+project. `null` when
   * the DSL has no auth_profile or the name doesn't resolve.
   *
   * Used by the auth-profile list route to count consumers efficiently. The
   * DSL remains the source of truth at runtime (resolved by name); this field
   * is purely for query/aggregation.
   */
  authProfileId: string | null;
  createdBy: string;
  lastEditedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectToolSchema = new Schema<IProjectTool>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 64,
      match: /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/,
      trim: true,
      lowercase: true,
    },
    slug: {
      type: String,
      required: true,
      minlength: 2,
      maxlength: 64,
      match: /^[a-z][a-z0-9_]*$/,
    },
    toolType: {
      type: String,
      required: true,
      enum: PROJECT_TOOL_TYPES,
    },
    description: {
      type: String,
      default: null,
      maxlength: MAX_DESCRIPTION_LENGTH,
    },
    dslContent: {
      type: String,
      required: true,
      maxlength: MAX_DSL_CONTENT_SIZE,
    },
    sourceHash: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
    },
    variableNamespaceIds: {
      type: [String],
      default: [],
    },
    authProfileId: { type: String, default: null },
    createdBy: { type: String, required: true },
    lastEditedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_tools' },
);

// ─── Guards ──────────────────────────────────────────────────────────────

// Slug immutability — pre-save
ProjectToolSchema.pre('save', function () {
  if (!this.isNew && this.isModified('slug')) {
    throw new Error('Tool slug cannot be changed after creation');
  }
});

// Slug immutability — findOneAndUpdate
ProjectToolSchema.pre('findOneAndUpdate', function () {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) return;

  const directSlug = update.slug;
  const setSlug = (update.$set as Record<string, unknown> | undefined)?.slug;

  if (directSlug !== undefined || setSlug !== undefined) {
    throw new Error('Tool slug cannot be changed after creation');
  }
});

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectToolSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary lookup: unique name per project
ProjectToolSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });

// Unique slug per project (for URL resolution)
ProjectToolSchema.index({ tenantId: 1, projectId: 1, slug: 1 }, { unique: true });

// Filter by type within a project
ProjectToolSchema.index({ tenantId: 1, projectId: 1, toolType: 1 });

// Batch resolution: name $in [...] query
ProjectToolSchema.index({ tenantId: 1, projectId: 1 });

// Consumer-count query: find tools by auth-profile reference (sparse — most tools have null)
ProjectToolSchema.index({ tenantId: 1, projectId: 1, authProfileId: 1 }, { sparse: true });

// Full-text search on name + description
ProjectToolSchema.index({ name: 'text', description: 'text' });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectTool =
  (mongoose.models.ProjectTool as mongoose.Model<IProjectTool>) ||
  model<IProjectTool>('ProjectTool', ProjectToolSchema);
