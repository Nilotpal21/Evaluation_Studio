/**
 * Arch Blueprint Model
 *
 * Stores structured Arch-AI blueprint snapshots. Markdown is rendered from
 * output on read; this collection is the persistent structured source.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';

export type ArchBlueprintState = 'draft' | 'locked' | 'linked' | 'archived';

export interface IArchBlueprint {
  _id: string;
  tenantId: string;
  projectId: string | null;
  sessionId: string | null;
  version: number;
  state: ArchBlueprintState;
  output: unknown;
  sectionStatus: Record<string, unknown> | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  createdBy: string;
  updatedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const ArchBlueprintSchema = new Schema<IArchBlueprint>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    sessionId: { type: String, default: null },
    version: { type: Number, required: true },
    state: {
      type: String,
      enum: ['draft', 'locked', 'linked', 'archived'],
      required: true,
      default: 'draft',
    },
    output: { type: Schema.Types.Mixed, required: true },
    sectionStatus: { type: Schema.Types.Mixed, default: null },
    lockedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'arch_blueprints' },
);

ArchBlueprintSchema.index(
  { tenantId: 1, projectId: 1, version: 1 },
  { unique: true, partialFilterExpression: { projectId: { $type: 'string' } } },
);
ArchBlueprintSchema.index(
  { tenantId: 1, sessionId: 1, version: 1 },
  { unique: true, partialFilterExpression: { sessionId: { $type: 'string' } } },
);
ArchBlueprintSchema.index({ tenantId: 1, projectId: 1, state: 1, updatedAt: -1 });
ArchBlueprintSchema.index({ tenantId: 1, sessionId: 1, state: 1, updatedAt: -1 });

export const ArchBlueprint =
  (mongoose.models.ArchBlueprint as any) ||
  model<IArchBlueprint>('ArchBlueprint', ArchBlueprintSchema);
