/**
 * Connector Recommendation Model
 *
 * Stores AI-generated recommendations for connector setup — resource scores,
 * sync strategy, permission mode, filter config, and cost estimates.
 * Records expire after 7 days via TTL index.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Embedded Sub-Schemas ───────────────────────────────────────────────

interface IResourceScoreDoc {
  resourceId: string;
  resourceName: string;
  overallScore: number;
  recommended: boolean;
  factors: {
    activityScore: number;
    sizeScore: number;
    contentScore: number;
    sensitivityPenalty: number;
  };
  reasoning: string;
}

interface ISyncStrategyDoc {
  syncMode: 'full_then_delta' | 'full_only';
  fullSyncSchedule: string;
  deltaSyncSchedule: string | null;
  enableWebhooks: boolean;
  reasoning: string;
  confidence: number;
}

interface IPermissionModeDoc {
  mode: 'full' | 'simplified' | 'disabled';
  reasoning: string;
  confidence: number;
}

interface IFilterConfigDoc {
  mode: 'include' | 'exclude';
  resourceIds: string[];
  contentTypes: string[];
  modifiedSince: Date | null;
  reasoning: string;
}

interface ICostEstimateDoc {
  estimatedDocuments: number;
  estimatedStorageBytes: number;
  estimatedSyncDurationSeconds: number;
  estimatedMonthlyApiCalls: number;
}

interface IUserDecisionDoc {
  action: 'accepted' | 'rejected' | 'modified';
  overrides: Record<string, unknown>;
  decidedAt: Date;
}

// ─── Document Interface ─────────────────────────────────────────────────

export interface IConnectorRecommendation {
  _id: string;
  tenantId: string;
  connectorId: string;
  discoveryId: string;
  status: 'pending' | 'generated' | 'accepted' | 'rejected' | 'expired';
  resourceScores: IResourceScoreDoc[];
  syncStrategy: ISyncStrategyDoc;
  permissionMode: IPermissionModeDoc;
  filterConfig: IFilterConfigDoc;
  costEstimate: ICostEstimateDoc;
  overallConfidence: number;
  userDecision: IUserDecisionDoc | null;
  generatedAt: Date;
  expiresAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const ResourceScoreSchema = new Schema(
  {
    resourceId: { type: String, required: true },
    resourceName: { type: String, required: true },
    overallScore: { type: Number, required: true },
    recommended: { type: Boolean, required: true },
    factors: {
      type: {
        activityScore: { type: Number, required: true },
        sizeScore: { type: Number, required: true },
        contentScore: { type: Number, required: true },
        sensitivityPenalty: { type: Number, required: true },
      },
      required: true,
    },
    reasoning: { type: String, required: true },
  },
  { _id: false },
);

const ConnectorRecommendationSchema = new Schema<IConnectorRecommendation>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectorId: { type: String, required: true },
    discoveryId: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'generated', 'accepted', 'rejected', 'expired'],
      default: 'pending',
    },
    resourceScores: { type: [ResourceScoreSchema], default: [] },
    syncStrategy: {
      type: {
        syncMode: { type: String, enum: ['full_then_delta', 'full_only'], required: true },
        fullSyncSchedule: { type: String, required: true },
        deltaSyncSchedule: { type: String, default: null },
        enableWebhooks: { type: Boolean, default: false },
        reasoning: { type: String, required: true },
        confidence: { type: Number, required: true },
      },
      required: true,
    },
    permissionMode: {
      type: {
        mode: { type: String, enum: ['full', 'simplified', 'disabled'], required: true },
        reasoning: { type: String, required: true },
        confidence: { type: Number, required: true },
      },
      required: true,
    },
    filterConfig: {
      type: {
        mode: { type: String, enum: ['include', 'exclude'], required: true },
        resourceIds: { type: [String], default: [] },
        contentTypes: { type: [String], default: [] },
        modifiedSince: { type: Date, default: null },
        reasoning: { type: String, required: true },
      },
      required: true,
    },
    costEstimate: {
      type: {
        estimatedDocuments: { type: Number, required: true },
        estimatedStorageBytes: { type: Number, required: true },
        estimatedSyncDurationSeconds: { type: Number, required: true },
        estimatedMonthlyApiCalls: { type: Number, required: true },
      },
      required: true,
    },
    overallConfidence: { type: Number, default: 0 },
    userDecision: {
      type: {
        action: { type: String, enum: ['accepted', 'rejected', 'modified'] },
        overrides: { type: Schema.Types.Mixed, default: {} },
        decidedAt: { type: Date },
      },
      default: null,
    },
    generatedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: () => new Date(Date.now() + SEVEN_DAYS_MS) },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_recommendations' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ConnectorRecommendationSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

// Primary lookup: latest recommendation by connector
ConnectorRecommendationSchema.index({ tenantId: 1, connectorId: 1 });

// Lookup by discovery
ConnectorRecommendationSchema.index({ tenantId: 1, discoveryId: 1 });

// TTL: auto-delete expired recommendations
ConnectorRecommendationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ──────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition(
  'ConnectorRecommendation',
  ConnectorRecommendationSchema,
  'platform',
);

export const ConnectorRecommendation =
  (mongoose.models.ConnectorRecommendation as mongoose.Model<IConnectorRecommendation>) ||
  model<IConnectorRecommendation>('ConnectorRecommendation', ConnectorRecommendationSchema);
