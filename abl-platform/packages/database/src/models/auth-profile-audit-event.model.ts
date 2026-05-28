/**
 * AuthProfileAuditEvent Model
 *
 * Domain-level audit events for the per-profile Activity tab.
 * Separate from the generic `audit_logs` collection (populated by the
 * auditTrailPlugin for CRUD writes). This collection stores lifecycle
 * events specific to ABLP-913: authorize, revoke, refresh, scope errors, etc.
 *
 * TTL: 365 days — events are automatically purged after one year.
 * Plugin: tenantIsolationPlugin only (NOT auditTrailPlugin — would create
 * a recursive write loop since this IS the audit collection).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Event Type Enum ────────────────────────────────────────────────────

export const AUTH_PROFILE_AUDIT_EVENT_TYPES = [
  'authorized',
  'authorize_failed',
  'token_refreshed',
  'token_refresh_failed',
  'profile_revoked',
  'tokens_revoked',
  'profile_updated',
  'sensitive_field_changed',
  'profile_deleted',
  'scope_insufficient_detected',
] as const;

export type AuthProfileAuditEventType = (typeof AUTH_PROFILE_AUDIT_EVENT_TYPES)[number];

// ─── Actor Context Interface ────────────────────────────────────────────

export interface IActorContext {
  source: 'profile' | 'integration_node' | 'tool_config' | 'session_init' | 'system';
  requestId?: string;
  sessionId?: string;
}

// ─── Document Interface ─────────────────────────────────────────────────

export interface IAuthProfileAuditEvent {
  _id: string;
  tenantId: string;
  projectId: string | null;
  profileId: string;
  eventType: AuthProfileAuditEventType;
  actorUserId: string | null;
  actorContext: IActorContext;
  eventPayload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const ActorContextSchema = new Schema<IActorContext>(
  {
    source: {
      type: String,
      enum: ['profile', 'integration_node', 'tool_config', 'session_init', 'system'],
      required: true,
    },
    requestId: { type: String },
    sessionId: { type: String },
  },
  { _id: false },
);

const AuthProfileAuditEventSchema = new Schema<IAuthProfileAuditEvent>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    profileId: { type: String, required: true },
    eventType: {
      type: String,
      enum: AUTH_PROFILE_AUDIT_EVENT_TYPES,
      required: true,
    },
    actorUserId: { type: String, default: null },
    actorContext: { type: ActorContextSchema, required: true },
    eventPayload: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'auth_profile_audit_events' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

AuthProfileAuditEventSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

// Primary query: activity tab for a specific profile, newest first
AuthProfileAuditEventSchema.index({
  tenantId: 1,
  projectId: 1,
  profileId: 1,
  createdAt: -1,
});

// Secondary query: filter by event type across profiles
AuthProfileAuditEventSchema.index({
  tenantId: 1,
  eventType: 1,
  createdAt: -1,
});

// TTL index: auto-expire after 365 days
AuthProfileAuditEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

// ─── Model ──────────────────────────────────────────────────────────────

export const AuthProfileAuditEvent =
  (mongoose.models.AuthProfileAuditEvent as any) ||
  model<IAuthProfileAuditEvent>('AuthProfileAuditEvent', AuthProfileAuditEventSchema);
