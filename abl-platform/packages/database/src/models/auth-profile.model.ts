/**
 * AuthProfile Model
 *
 * Unified authentication credential store. Phase 1+2+3 supports 17 auth types:
 * none, api_key, bearer, oauth2_app, oauth2_token, oauth2_client_credentials,
 * basic, custom_header, aws_iam, azure_ad, mtls, ssh_key,
 * digest, kerberos, saml, hawk, ws_security.
 *
 * Scoping: tenant-level (projectId: null) or project-level.
 * Visibility: shared (anyone in scope) or personal (creator only).
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { auditTrailPlugin } from '../mongo/plugins/audit-trail.plugin.js';

// ─── Auth Type Enum ──────────────────────────────────────────────────────

export const AUTH_PROFILE_AUTH_TYPES = [
  'none',
  'api_key',
  'bearer',
  'oauth2_app',
  'oauth2_token',
  'oauth2_client_credentials',
  // Phase 2 types:
  'basic',
  'custom_header',
  'aws_iam',
  'azure_ad',
  'mtls',
  'ssh_key',
  // Phase 3 types:
  'digest',
  'kerberos',
  'saml',
  'hawk',
  'ws_security',
] as const;

export type AuthProfileAuthType = (typeof AUTH_PROFILE_AUTH_TYPES)[number];

export const AUTH_PROFILE_STATUSES = [
  'active',
  'expired',
  'revoked',
  'invalid',
  'pending_authorization',
] as const;
export type AuthProfileStatus = (typeof AUTH_PROFILE_STATUSES)[number];

export const AUTH_PROFILE_SCOPES = ['tenant', 'project'] as const;
export type AuthProfileScope = (typeof AUTH_PROFILE_SCOPES)[number];

export const AUTH_PROFILE_VISIBILITIES = ['shared', 'personal'] as const;
export type AuthProfileVisibility = (typeof AUTH_PROFILE_VISIBILITIES)[number];

export const AUTH_PROFILE_CONNECTION_MODES = ['shared', 'per_user'] as const;
export type AuthProfileConnectionMode = (typeof AUTH_PROFILE_CONNECTION_MODES)[number];

export const AUTH_PROFILE_PROFILE_TYPES = ['integration', 'custom'] as const;
export type AuthProfileProfileType = (typeof AUTH_PROFILE_PROFILE_TYPES)[number];

export const AUTH_PROFILE_USAGE_MODES = [
  'preconfigured',
  'user_token',
  'jit',
  'preflight',
] as const;
export type AuthProfileUsageMode = (typeof AUTH_PROFILE_USAGE_MODES)[number];

function getDefaultUsageModeForAuthType(authType: string | undefined): AuthProfileUsageMode {
  if (authType === 'oauth2_token') {
    return 'user_token';
  }

  return 'preconfigured';
}

// ─── Document Interface ──────────────────────────────────────────────────

export interface IAuthProfile {
  _id: string;
  name: string;
  description?: string;
  tenantId: string;
  projectId: string | null;
  scope: AuthProfileScope;
  usageMode?: AuthProfileUsageMode;
  environment: string | null;
  visibility: AuthProfileVisibility;
  connectionMode: AuthProfileConnectionMode;
  createdBy: string;
  authType: AuthProfileAuthType;
  config: Record<string, unknown>;
  encryptedSecrets: string;
  encryptionKeyVersion: number;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
  status: AuthProfileStatus;
  /**
   * Soft enable/disable flag. When false, the runtime resolver rejects this
   * profile with AUTH_PROFILE_DISABLED before secrets are decrypted, so
   * workflows / agents / MCP tools using it fail fast with a clear error.
   * Distinct from `status` (which tracks credential health); a profile can be
   * `status: active` but `enabled: false` if an admin paused it.
   */
  enabled: boolean;
  expiresAt?: Date;
  lastValidatedAt?: Date;
  lastUsedAt?: Date;
  rotationPolicy?: Record<string, unknown>;
  previousEncryptedSecrets?: string;
  rotationGracePeriodMs?: number;
  // ABLP-913 fields
  profileType: AuthProfileProfileType;
  lastAuthorizedAt?: Date | null;
  lastAuthorizedBy?: string | null;
  inlineHostedTool?: { toolId: string; fieldKey: string } | null;
  // Phase 2 fields
  groupId?: string | null;
  migrationStatus?: 'active' | 'migrating' | 'migrated';
  // Addon mechanisms (present in schema, not active in Phase 1)
  signing?: Record<string, unknown>;
  webhookVerification?: Record<string, unknown>;
  proxy?: Record<string, unknown>;
  // Phase 3 addon mechanisms
  certificatePinning?: Record<string, unknown>;
  jwtWrapping?: Record<string, unknown>;
  // Schema version (BaseDocument convention — see base-document.ts)
  _v: number;
  /**
   * Monotonic integer bumped on every config or encryptedSecrets write. Used
   * by the credential cache (CK-1 contract) so that a profile mutation
   * invalidates downstream caches without requiring an explicit eviction call.
   * Distinct from `_v` which tracks BaseDocument schema migrations.
   */
  profileVersion: number;
  // Audit
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const AuthProfileSchema = new Schema<IAuthProfile>(
  {
    _id: { type: String, default: uuidv7 },
    name: { type: String, required: true, trim: true, maxlength: 255 },
    description: { type: String, maxlength: 1000 },
    tenantId: { type: String, required: true },
    projectId: { type: String, default: null },
    scope: {
      type: String,
      enum: AUTH_PROFILE_SCOPES,
      required: true,
      default: 'project',
    },
    usageMode: {
      type: String,
      enum: AUTH_PROFILE_USAGE_MODES,
      default: function (this: { authType?: string }) {
        return getDefaultUsageModeForAuthType(this.authType);
      },
    },
    environment: { type: String, default: null },
    visibility: {
      type: String,
      enum: AUTH_PROFILE_VISIBILITIES,
      required: true,
      default: 'shared',
    },
    connectionMode: {
      type: String,
      enum: AUTH_PROFILE_CONNECTION_MODES,
      default: 'shared',
    },
    createdBy: { type: String, required: true, immutable: true },
    authType: {
      type: String,
      enum: AUTH_PROFILE_AUTH_TYPES,
      required: true,
    },
    config: { type: Schema.Types.Mixed, default: {} },
    encryptedSecrets: { type: String, required: true },
    encryptionKeyVersion: { type: Number, required: true, default: 1 },
    linkedAppProfileId: { type: String },
    connector: { type: String },
    profileType: {
      type: String,
      enum: AUTH_PROFILE_PROFILE_TYPES,
      default: 'custom',
    },
    lastAuthorizedAt: { type: Date, default: null },
    lastAuthorizedBy: { type: String, default: null },
    inlineHostedTool: {
      type: new Schema(
        {
          toolId: { type: String, required: true },
          fieldKey: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    category: { type: String },
    tags: { type: [String] },
    status: {
      type: String,
      enum: AUTH_PROFILE_STATUSES,
      required: true,
      default: 'active',
    },
    enabled: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date },
    lastValidatedAt: { type: Date },
    lastUsedAt: { type: Date },
    rotationPolicy: { type: Schema.Types.Mixed },
    previousEncryptedSecrets: { type: String },
    rotationGracePeriodMs: { type: Number },
    // Phase 2 fields
    groupId: { type: String, default: null },
    migrationStatus: {
      type: String,
      enum: ['active', 'migrating', 'migrated'],
      default: 'active',
    },
    // Addon mechanisms (schema presence for forward-compat, inert in Phase 1)
    signing: { type: Schema.Types.Mixed },
    webhookVerification: { type: Schema.Types.Mixed },
    proxy: { type: Schema.Types.Mixed },
    // Phase 3 addon mechanisms
    certificatePinning: { type: Schema.Types.Mixed },
    jwtWrapping: { type: Schema.Types.Mixed },
    _v: { type: Number, default: 1 },
    profileVersion: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'auth_profiles' },
);

// ─── Pre-Save Hook (CK-1 contract) ───────────────────────────────────────
//
// Bump `profileVersion` whenever `config` or `encryptedSecrets` changes so
// downstream credential caches keyed on `{tenantId, profileId,
// profileVersion, scopeHash}` self-invalidate without an explicit eviction
// call. Idempotent on `lastUsedAt`/`lastValidatedAt` writes.
//
// MUST register BEFORE the encryptionPlugin so `isModified('encryptedSecrets')`
// reflects the caller's intent, not the plugin's internal re-encryption.
// Inline (not a plugin) because the rule is auth-profile-specific and would
// not be reused elsewhere.

AuthProfileSchema.pre('save', function (next) {
  if (this.isNew) {
    if (this.profileVersion === undefined || this.profileVersion === null) {
      this.profileVersion = 1;
    }
    return next();
  }
  if (
    this.isModified('config') ||
    this.isModified('encryptedSecrets') ||
    // Status flips (active → revoked / expired / invalid, or back to active)
    // must also bump the version so pod-local credential caches keyed on
    // `{tenantId, profileId, profileVersion}` re-read instead of serving
    // stale secrets after a revoke / activate.
    this.isModified('status') ||
    // `enabled: false` gates resolution at the runtime resolver; bumping
    // here ensures cached secrets are dropped on disable as well.
    this.isModified('enabled')
  ) {
    const current = typeof this.profileVersion === 'number' ? this.profileVersion : 1;
    this.profileVersion = current + 1;
  }
  next();
});

// ─── Plugins ─────────────────────────────────────────────────────────────

AuthProfileSchema.plugin(tenantIsolationPlugin);
AuthProfileSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedSecrets', 'previousEncryptedSecrets'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});
AuthProfileSchema.plugin(auditTrailPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Query indexes (9 from design)
AuthProfileSchema.index({ tenantId: 1, scope: 1 });
AuthProfileSchema.index({ tenantId: 1, projectId: 1, scope: 1 });
AuthProfileSchema.index({ tenantId: 1, projectId: 1, connector: 1, authType: 1 });
AuthProfileSchema.index({ tenantId: 1, projectId: 1, visibility: 1, createdBy: 1 });
AuthProfileSchema.index({
  tenantId: 1,
  projectId: 1,
  connector: 1,
  visibility: 1,
  createdBy: 1,
});
AuthProfileSchema.index({ tenantId: 1, projectId: 1, category: 1 });
AuthProfileSchema.index({ linkedAppProfileId: 1 });
AuthProfileSchema.index({ status: 1, expiresAt: 1, authType: 1 });
AuthProfileSchema.index({ groupId: 1 });
// ABLP-913: Integrations tab query — filter by profileType + connector
AuthProfileSchema.index({ tenantId: 1, projectId: 1, profileType: 1, connector: 1 });
// Covers resolveByName() hot path: name-based lookup with status + project + environment
AuthProfileSchema.index({ tenantId: 1, name: 1, status: 1, projectId: 1, environment: 1 });

// Unique constraints — shared and personal namespaces are isolated.
// Shared names are unique per scope/environment. Personal names are unique
// per owner within the same scope/environment.
AuthProfileSchema.index(
  { tenantId: 1, name: 1, environment: 1 },
  {
    unique: true,
    partialFilterExpression: { projectId: null, visibility: 'shared' },
  },
);
AuthProfileSchema.index(
  { tenantId: 1, projectId: 1, name: 1, environment: 1 },
  {
    unique: true,
    // Mongo rejects {$ne: null} in partial indexes on some server versions.
    // Project-scoped auth profiles always persist projectId as a string, so
    // this keeps the intended uniqueness semantics while remaining portable.
    partialFilterExpression: { projectId: { $type: 'string' }, visibility: 'shared' },
  },
);
AuthProfileSchema.index(
  { tenantId: 1, createdBy: 1, name: 1, environment: 1 },
  {
    unique: true,
    partialFilterExpression: { projectId: null, visibility: 'personal' },
  },
);
AuthProfileSchema.index(
  { tenantId: 1, projectId: 1, createdBy: 1, name: 1, environment: 1 },
  {
    unique: true,
    partialFilterExpression: { projectId: { $type: 'string' }, visibility: 'personal' },
  },
);

// ─── Model ───────────────────────────────────────────────────────────────

export const AuthProfile =
  (mongoose.models.AuthProfile as any) || model<IAuthProfile>('AuthProfile', AuthProfileSchema);
