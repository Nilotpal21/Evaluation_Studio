/**
 * Widget Config Model
 *
 * Stores the UI widget configuration for a project.
 * Controls appearance, behavior, and feature toggles for the
 * embedded chat/voice widget.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IWidgetConfig {
  _id: string;
  tenantId: string;
  projectId: string;
  channelId: string | null;
  mode: string;
  position: string;
  theme: any;
  welcomeMessage: string | null;
  placeholderText: string | null;
  voiceEnabled: boolean;
  chatEnabled: boolean;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const WidgetConfigSchema = new Schema<IWidgetConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    channelId: { type: String, default: null },
    mode: { type: String, required: true },
    position: { type: String, required: true },
    theme: { type: Schema.Types.Mixed, default: {} },
    welcomeMessage: { type: String, default: null },
    placeholderText: { type: String, default: null },
    voiceEnabled: { type: Boolean, required: true },
    chatEnabled: { type: Boolean, required: true },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'widget_configs' },
);

// ─── Indexes ─────────────────────────────────────────────────────────────

WidgetConfigSchema.index({ projectId: 1 }, { unique: true });
WidgetConfigSchema.index({ tenantId: 1, projectId: 1 });

// ─── Plugins ─────────────────────────────────────────────────────────────

WidgetConfigSchema.plugin(tenantIsolationPlugin);

// ─── Model ───────────────────────────────────────────────────────────────

export const WidgetConfig =
  (mongoose.models.WidgetConfig as any) || model<IWidgetConfig>('WidgetConfig', WidgetConfigSchema);
