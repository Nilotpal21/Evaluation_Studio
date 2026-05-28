/**
 * Project Module Dependency Model
 *
 * Records a consumer project's dependency on a module project.
 * Each dependency specifies a selector (version or environment pointer)
 * and stores a denormalized snapshot of the module's contract for
 * validation without joining to ModuleRelease.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { ModuleReleaseContract } from './module-release.model.js';

// ─── Sub-document Types ─────────────────────────────────────────────────

export type ModuleDependencySelector = {
  type: 'version' | 'environment';
  value: string;
};

// ─── Document Interface ─────────────────────────────────────────────────

export interface IProjectModuleDependency {
  _id: string;
  tenantId: string;
  projectId: string;
  moduleProjectId: string;
  moduleProjectName: string;
  alias: string;
  selector: ModuleDependencySelector;
  resolvedReleaseId: string;
  resolvedVersion: string;
  configOverrides: Record<string, string>;
  contractSnapshot: ModuleReleaseContract;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const ProjectModuleDependencySchema = new Schema<IProjectModuleDependency>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    moduleProjectId: { type: String, required: true },
    moduleProjectName: { type: String, required: true },
    alias: { type: String, required: true },
    selector: {
      type: new Schema(
        {
          type: { type: String, required: true, enum: ['version', 'environment'] },
          value: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    resolvedReleaseId: { type: String, required: true },
    resolvedVersion: { type: String, required: true },
    configOverrides: { type: Schema.Types.Mixed, default: {} },
    contractSnapshot: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'project_module_dependencies' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ProjectModuleDependencySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

ProjectModuleDependencySchema.index({ tenantId: 1, projectId: 1, alias: 1 }, { unique: true });
ProjectModuleDependencySchema.index({ tenantId: 1, moduleProjectId: 1 });

// ─── Model ──────────────────────────────────────────────────────────────

export const ProjectModuleDependency =
  (mongoose.models.ProjectModuleDependency as any) ||
  model<IProjectModuleDependency>('ProjectModuleDependency', ProjectModuleDependencySchema);
