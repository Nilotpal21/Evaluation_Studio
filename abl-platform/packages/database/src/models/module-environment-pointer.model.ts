/**
 * Module Environment Pointer Model
 *
 * Maps a module project + environment to a specific ModuleRelease.
 * Uses an optimistic concurrency `revision` field for safe concurrent updates.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ─────────────────────────────────────────────────

export interface IModuleEnvironmentPointer {
  _id: string;
  tenantId: string;
  moduleProjectId: string;
  environment: 'dev' | 'staging' | 'production';
  moduleReleaseId: string;
  revision: number;
  updatedBy: string;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const ModuleEnvironmentPointerSchema = new Schema<IModuleEnvironmentPointer>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    moduleProjectId: { type: String, required: true },
    environment: {
      type: String,
      required: true,
      enum: ['dev', 'staging', 'production'],
    },
    moduleReleaseId: { type: String, required: true },
    revision: { type: Number, required: true, default: 1 },
    updatedBy: { type: String, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'module_environment_pointers' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ModuleEnvironmentPointerSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

ModuleEnvironmentPointerSchema.index(
  { tenantId: 1, moduleProjectId: 1, environment: 1 },
  { unique: true },
);

// ─── Model ──────────────────────────────────────────────────────────────

export const ModuleEnvironmentPointer =
  (mongoose.models.ModuleEnvironmentPointer as any) ||
  model<IModuleEnvironmentPointer>('ModuleEnvironmentPointer', ModuleEnvironmentPointerSchema);
