/**
 * Demo Vision Config Model
 *
 * Controls which projects use pre-seeded video frames instead of FFmpeg
 * extraction. Toggle on/off per project via MongoDB — no redeployment needed.
 *
 * This is a temporary demo-enablement model. Remove when FFmpeg is provisioned
 * in the multimodal-service container image.
 *
 * Usage:
 *   Enable:  db.demovisionconfigs.insertOne({ tenantId, projectId, enabled: true, framePrefix: "demo-frames/proj_abc/" })
 *   Disable: db.demovisionconfigs.updateOne({ projectId: "proj_abc" }, { $set: { enabled: false } })
 */

import mongoose, { Schema, model } from 'mongoose';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IDemoVisionConfig {
  tenantId: string;
  projectId: string;
  enabled: boolean;
  /** NFS path prefix where pre-seeded frames live, e.g. "demo-frames/proj_abc/" */
  framePrefix: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const DemoVisionConfigSchema = new Schema<IDemoVisionConfig>(
  {
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    framePrefix: { type: String, required: true },
  },
  {
    timestamps: true,
    collection: 'demovisionconfigs',
  },
);

// Unique constraint: one config per tenant+project
DemoVisionConfigSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const DemoVisionConfig =
  (mongoose.models.DemoVisionConfig as mongoose.Model<IDemoVisionConfig>) ||
  model<IDemoVisionConfig>('DemoVisionConfig', DemoVisionConfigSchema);
