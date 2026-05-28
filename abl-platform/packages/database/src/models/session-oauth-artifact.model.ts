/**
 * Session OAuth Artifact Model
 *
 * Stores encrypted OAuth credentials that are intentionally bound to a
 * session-scoped principal rather than a reusable end-user identity.
 *
 * Runtime deletes these artifacts explicitly when the owning session ends.
 * The TTL index on `sessionExpiresAt` is only a safety net for abandoned data.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { ModelRegistry } from '../model-registry.js';

export interface ISessionOAuthArtifact {
  _id: string;
  tenantId: string;
  projectId: string;
  provider: string;
  sessionPrincipal: string;
  /**
   * Legacy persistence field name.
   * Runtime/service contracts expose this value as canonical `sessionId`.
   */
  runtimeSessionId: string;
  channelId: string | null;
  authProfileId: string | null;
  authProfileRef: string | null;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scope: string;
  expiresAt: Date | null;
  sessionExpiresAt: Date;
  refreshedAt: Date | null;
  consentedAt: Date;
  lastUsedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const SessionOAuthArtifactSchema = new Schema<ISessionOAuthArtifact>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    provider: { type: String, required: true },
    sessionPrincipal: { type: String, required: true },
    // Legacy storage field name retained for compatibility with existing rows.
    // Service-layer contracts treat this as canonical `sessionId`.
    runtimeSessionId: { type: String, required: true },
    channelId: { type: String, default: null },
    authProfileId: { type: String, default: null },
    authProfileRef: { type: String, default: null },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, default: null },
    scope: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    sessionExpiresAt: { type: Date, required: true },
    refreshedAt: { type: Date, default: null },
    consentedAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'session_oauth_artifacts' },
);

SessionOAuthArtifactSchema.plugin(tenantIsolationPlugin);
SessionOAuthArtifactSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedAccessToken', 'encryptedRefreshToken'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});

SessionOAuthArtifactSchema.index(
  { tenantId: 1, projectId: 1, sessionPrincipal: 1, provider: 1 },
  { unique: true },
);
SessionOAuthArtifactSchema.index({ runtimeSessionId: 1 });
SessionOAuthArtifactSchema.index({ sessionExpiresAt: 1 }, { expireAfterSeconds: 0 });

ModelRegistry.registerModelDefinition(
  'SessionOAuthArtifact',
  SessionOAuthArtifactSchema,
  'platform',
);

export const SessionOAuthArtifact =
  (mongoose.models.SessionOAuthArtifact as any) ||
  model<ISessionOAuthArtifact>('SessionOAuthArtifact', SessionOAuthArtifactSchema);
