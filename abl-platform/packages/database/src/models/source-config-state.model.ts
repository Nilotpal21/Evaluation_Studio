/**
 * Source Config State Model
 *
 * Stores transient wizard state for web crawl source configuration.
 * Contains the discovery tree, discovered URLs, objectives, nav structure,
 * and coverage analysis — data that can reach 5MB and is discarded after
 * crawl starts.
 *
 * Separate from SearchSource to keep source documents small (~16KB) while
 * supporting full resume of the discovery wizard.
 *
 * Lifecycle: created lazily on first PUT /discovery-state → deleted by
 * worker on crawl start → TTL-cleaned if abandoned (30 days via configExpiresAt).
 *
 * Database: searchaicontent (co-located with SearchSource for cascade delete).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export type DiscoveryStatusValue = 'idle' | 'running' | 'complete' | 'stopped';

export interface ISourceConfigState {
  _id: string;
  tenantId: string;
  sourceId: string;
  projectId: string;

  /** Discovery state blob — up to 5MB (Zod-capped, uses .passthrough()) */
  discoveryState: Record<string, unknown> | null;

  /** Discovery engine status */
  discoveryStatus: DiscoveryStatusValue;

  /** User who owns this wizard session */
  createdBy: string;

  /** TTL — copied from parent source, auto-delete when parent expires */
  configExpiresAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const sourceConfigStateSchema = new Schema<ISourceConfigState>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    sourceId: { type: String, required: true },
    projectId: { type: String, required: true },

    discoveryState: { type: Schema.Types.Mixed, default: null },

    discoveryStatus: {
      type: String,
      enum: ['idle', 'running', 'complete', 'stopped'],
      default: 'idle',
    },

    createdBy: { type: String, required: true },

    configExpiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'source_config_states',
  },
);

// ─── Plugins ─────────────────────────────────────────────────────────────────

sourceConfigStateSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────────

// 1:1 with SearchSource — fast lookup + cascade delete
sourceConfigStateSchema.index({ sourceId: 1 }, { unique: true });

// Active discoveries cross-user (KB-level tracking)
sourceConfigStateSchema.index({ tenantId: 1, projectId: 1, discoveryStatus: 1 });

// TTL: auto-delete when parent source expires (same configExpiresAt timestamp)
sourceConfigStateSchema.index({ configExpiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ───────────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition(
  'SourceConfigState',
  sourceConfigStateSchema,
  'searchaicontent',
);

export const SourceConfigState =
  (mongoose.models.SourceConfigState as mongoose.Model<ISourceConfigState>) ||
  model<ISourceConfigState>('SourceConfigState', sourceConfigStateSchema);
