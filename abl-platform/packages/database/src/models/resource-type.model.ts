/**
 * Resource Type Model
 *
 * Defines the types of resources available in the platform along with
 * the operations that can be performed on each type.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

// ─── Subdocument Interface ───────────────────────────────────────────────

export interface IResourceTypeOperation {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IResourceType {
  _id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  isDeprecated: boolean;
  deprecatedAt: Date | null;
  deprecationNote: string | null;
  operations: IResourceTypeOperation[];
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Subdocument Schema ─────────────────────────────────────────────────

const ResourceTypeOperationSchema = new Schema<IResourceTypeOperation>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    description: { type: String, default: null },
    isSystem: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// ─── Schema ──────────────────────────────────────────────────────────────

const ResourceTypeSchema = new Schema<IResourceType>(
  {
    _id: { type: String, default: uuidv7 },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    description: { type: String, default: null },
    isSystem: { type: Boolean, default: false },
    isDeprecated: { type: Boolean, default: false },
    deprecatedAt: { type: Date, default: null },
    deprecationNote: { type: String, default: null },
    operations: { type: [ResourceTypeOperationSchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'resource_types' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

ResourceTypeSchema.index({ name: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ResourceType =
  (mongoose.models.ResourceType as any) || model<IResourceType>('ResourceType', ResourceTypeSchema);
