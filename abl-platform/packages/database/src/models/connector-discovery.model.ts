/**
 * Connector Discovery Model
 *
 * Stores auto-discovery results for connectors — discovered resources and
 * content profiles. Records expire after 7 days via TTL index.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Embedded Sub-Schemas ───────────────────────────────────────────────

interface IDiscoveredResourceDoc {
  id: string;
  name: string;
  displayName: string;
  url: string;
  resourceType: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
}

interface IContentProfileDoc {
  resourceId: string;
  totalDocuments: number;
  totalSizeBytes: number;
  fileTypeDistribution: Record<string, number>;
  dateRange: {
    earliest: Date | null;
    latest: Date | null;
  };
  averageDocumentSizeBytes: number;
  updateFrequency: 'daily' | 'weekly' | 'monthly' | 'rarely';
  sensitivityIndicators: string[];
  sampleDocumentCount: number;
}

// ─── Document Interface ─────────────────────────────────────────────────

export interface IConnectorDiscovery {
  _id: string;
  tenantId: string;
  connectorId: string;
  status: 'pending' | 'discovering' | 'profiling' | 'completed' | 'failed';
  resources: IDiscoveredResourceDoc[];
  profiles: IContentProfileDoc[];
  totalResources: number;
  discoveredAt: Date | null;
  durationMs: number;
  error: string | null;
  jobId: string | null;
  expiresAt: Date;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const DiscoveredResourceSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    url: { type: String, required: true },
    resourceType: { type: String, required: true },
    parentId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const ContentProfileSchema = new Schema(
  {
    resourceId: { type: String, required: true },
    totalDocuments: { type: Number, required: true },
    totalSizeBytes: { type: Number, required: true },
    fileTypeDistribution: { type: Schema.Types.Mixed, default: {} },
    dateRange: {
      type: {
        earliest: { type: Date, default: null },
        latest: { type: Date, default: null },
      },
      default: () => ({ earliest: null, latest: null }),
    },
    averageDocumentSizeBytes: { type: Number, default: 0 },
    updateFrequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'rarely'],
      default: 'rarely',
    },
    sensitivityIndicators: { type: [String], default: [] },
    sampleDocumentCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const ConnectorDiscoverySchema = new Schema<IConnectorDiscovery>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    connectorId: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'discovering', 'profiling', 'completed', 'failed'],
      default: 'pending',
    },
    resources: { type: [DiscoveredResourceSchema], default: [] },
    profiles: { type: [ContentProfileSchema], default: [] },
    totalResources: { type: Number, default: 0 },
    discoveredAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
    error: { type: String, default: null },
    jobId: { type: String, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + SEVEN_DAYS_MS) },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_discoveries' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ConnectorDiscoverySchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

// Primary lookup: latest discovery by connector
ConnectorDiscoverySchema.index({ tenantId: 1, connectorId: 1 });

// TTL: auto-delete expired discovery records
ConnectorDiscoverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ─── Model ──────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('ConnectorDiscovery', ConnectorDiscoverySchema, 'platform');

export const ConnectorDiscovery =
  (mongoose.models.ConnectorDiscovery as mongoose.Model<IConnectorDiscovery>) ||
  model<IConnectorDiscovery>('ConnectorDiscovery', ConnectorDiscoverySchema);
