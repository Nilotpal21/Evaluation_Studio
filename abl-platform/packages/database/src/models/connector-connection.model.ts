/**
 * ConnectorConnection Model
 *
 * @deprecated ABLP-913 — This model will be superseded by the integration catalog
 * (packages/shared/src/services/auth-profile/integration-catalog.ts) and auth-profile-based
 * connector wiring. New connector integrations SHOULD use the auth profile + integration
 * catalog pattern instead of creating ConnectorConnection records directly.
 * Existing code MAY continue to reference this model during the migration period.
 *
 * Pure binding record that links a connector to an auth profile.
 * All credential storage, encryption, and token refresh is handled
 * exclusively by auth profiles — this model stores no credentials.
 *
 * Supports two ownership scopes:
 * - Tenant-level: Shared service connections
 * - User-level: Per end-user connections
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IConnectorConnection {
  _id: string;
  tenantId: string;
  projectId: string;
  connectorName: string;
  displayName: string;
  scope: 'tenant' | 'user';
  userId?: string;
  /** Required reference to an AuthProfile for credential resolution */
  authProfileId: string;
  /** Optional provider-specific connection settings (non-secret) */
  metadata?: Record<string, unknown> | null;
  status: 'active' | 'expired' | 'revoked';
  /**
   * Monthly extraction count for cost-capped connectors (Azure Document
   * Intelligence in LLD §3 Phase 3). Reset to 1 atomically by the
   * `azure-di-usage-counter` CAS helper at month boundary; otherwise
   * `$inc`-ed by 1 per successful extraction.
   */
  usageCount?: number;
  /**
   * UTC instant marking the start of the current usage-counter month window.
   * Used by the CAS reset path (`$or: [{usagePeriodStart: null}, {< current
   * month}]`) at increment time.
   */
  usagePeriodStart?: Date;
  /** Tenant-admin-configurable soft cap — alerts/warnings only. `null` means no soft cap. */
  usageSoftCap?: number | null;
  /** Tenant-admin-configurable hard cap — extractions reject with QUOTA_EXCEEDED. `null` means no hard cap. */
  usageHardCap?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ConnectorConnectionSchema = new Schema<IConnectorConnection>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    connectorName: { type: String, required: true },
    displayName: { type: String, required: true },
    scope: { type: String, enum: ['tenant', 'user'], required: true },
    userId: { type: String, default: null },
    authProfileId: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ['active', 'expired', 'revoked'],
      default: 'active',
    },
    // Cost-cap fields (LLD §3 Phase 3 Task 3.10). Optional, additive — populated
    // only for connectors that opt into per-month usage counting (Azure DI in v1).
    usageCount: { type: Number },
    usagePeriodStart: { type: Date },
    usageSoftCap: { type: Number, default: null },
    usageHardCap: { type: Number, default: null },
  },
  { timestamps: true, collection: 'connector_connections' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ConnectorConnectionSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// One connection per auth profile per connector per project
ConnectorConnectionSchema.index(
  { tenantId: 1, projectId: 1, connectorName: 1, authProfileId: 1 },
  { unique: true },
);
ConnectorConnectionSchema.index({ tenantId: 1, projectId: 1 });
// Covers list() query: filter by scope/userId + sort by createdAt
ConnectorConnectionSchema.index({ tenantId: 1, projectId: 1, scope: 1, userId: 1, createdAt: -1 });

// ─── Model ───────────────────────────────────────────────────────────────

export const ConnectorConnection =
  (mongoose.models.ConnectorConnection as any) ||
  model<IConnectorConnection>('ConnectorConnection', ConnectorConnectionSchema);
