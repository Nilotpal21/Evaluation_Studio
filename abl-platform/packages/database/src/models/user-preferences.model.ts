/**
 * UserPreferences Model
 *
 * Stores per-user-per-tenant preferences such as pinned project IDs.
 * One document per (userId, tenantId) pair.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IUserPreferences {
  _id: string;
  userId: string;
  tenantId: string;
  pinnedProjectIds: string[];
  insightsAnalyticsFilters?: {
    version: number;
    byProject: Record<string, Record<string, unknown>>;
  };
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const UserPreferencesSchema = new Schema<IUserPreferences>(
  {
    _id: { type: String, default: uuidv7 },
    userId: { type: String, required: true },
    tenantId: { type: String, required: true },
    pinnedProjectIds: {
      type: [String],
      default: [],
      validate: [(v: string[]) => v.length <= 20, 'Maximum 20 pinned projects'],
    },
    insightsAnalyticsFilters: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'user_preferences' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

UserPreferencesSchema.plugin(tenantIsolationPlugin);
UserPreferencesSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

UserPreferencesSchema.index({ userId: 1, tenantId: 1 }, { unique: true });
UserPreferencesSchema.index({ tenantId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const UserPreferences =
  (mongoose.models.UserPreferences as mongoose.Model<IUserPreferences>) ||
  model<IUserPreferences>('UserPreferences', UserPreferencesSchema);
