/**
 * Project Model
 *
 * Stores projects in the ABL Platform.
 * Each project belongs to an owner and optionally to a tenant.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IProject {
  _id: string;
  name: string;
  slug: string;
  description: string | null;
  ownerId: string;
  tenantId: string | null;
  entryAgentName: string | null;
  gitIntegrationId: string | null;
  messageRetentionDays: number | null;
  kind: 'application' | 'module';
  moduleVisibility?: 'private' | 'tenant';
  moduleDependencyVersion?: number;
  channels?: string[];
  language?: string;
  archConfig?: {
    canonicalBlueprintMode: boolean;
    canonicalBlueprintVersion: number | null;
    manualDriftEnabledAt: Date | null;
    manualDriftEnabledBy: string | null;
  };
  archivedAt?: Date | null;
  archivedBy?: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectSchema = new Schema<IProject>(
  {
    _id: { type: String, default: uuidv7 },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    description: { type: String, default: null },
    ownerId: { type: String, required: true },
    tenantId: { type: String, default: null },
    entryAgentName: { type: String, default: null },
    gitIntegrationId: { type: String, default: null },
    messageRetentionDays: { type: Number, default: null },
    kind: {
      type: String,
      enum: ['application', 'module'],
      default: 'application',
      required: true,
    },
    moduleVisibility: {
      type: String,
      enum: ['private', 'tenant'],
      default: 'private',
    },
    moduleDependencyVersion: {
      type: Number,
      default: 0,
    },
    channels: {
      type: [String],
      default: undefined,
    },
    language: {
      type: String,
      default: undefined,
    },
    archConfig: {
      canonicalBlueprintMode: { type: Boolean, default: false },
      canonicalBlueprintVersion: { type: Number, default: null },
      manualDriftEnabledAt: { type: Date, default: null },
      manualDriftEnabledBy: { type: String, default: null },
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    archivedBy: {
      type: String,
      default: null,
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'projects' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
ProjectSchema.index({ tenantId: 1, name: 1 });
ProjectSchema.index({ ownerId: 1 });
ProjectSchema.index({ tenantId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const Project =
  (mongoose.models.Project as any) || model<IProject>('Project', ProjectSchema);
