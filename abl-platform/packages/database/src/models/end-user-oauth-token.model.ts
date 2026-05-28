/**
 * End User OAuth Token Model
 *
 * Stores encrypted OAuth tokens for reusable end-user or tenant-scoped
 * authorizations. Session-scoped SDK artifacts live in a separate model so
 * anonymous session principals are never persisted as durable user IDs here.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IEndUserOAuthToken {
  _id: string;
  tenantId: string;
  projectId: string | null;
  profileId: string | null;
  userId: string;
  provider: string;
  providerUserId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scope: string;
  expiresAt: Date | null;
  refreshedAt: Date | null;
  consentedAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const EndUserOAuthTokenSchema = new Schema<IEndUserOAuthToken>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: false, default: null },
    profileId: { type: String, required: false, default: null },
    userId: { type: String, required: true },
    provider: { type: String, required: true },
    providerUserId: { type: String, required: true },
    encryptedAccessToken: { type: String, required: true },
    encryptedRefreshToken: { type: String, default: null },
    scope: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    refreshedAt: { type: Date, default: null },
    consentedAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'end_user_oauth_tokens' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

EndUserOAuthTokenSchema.plugin(tenantIsolationPlugin);
EndUserOAuthTokenSchema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedAccessToken', 'encryptedRefreshToken'],
  scope: 'tenant',
  scopeFields: { tenantId: 'tenantId' },
});

// ─── Indexes ─────────────────────────────────────────────────────────────

// ABLP-913: Project-scoped partial unique index — only enforced when projectId is a string.
// Legacy rows with null projectId survive without violating the uniqueness constraint.
EndUserOAuthTokenSchema.index(
  { tenantId: 1, projectId: 1, userId: 1, provider: 1 },
  {
    unique: true,
    partialFilterExpression: { projectId: { $type: 'string' } },
  },
);

// ABLP-913: Profile-based lookup — partial index for non-null profileId
EndUserOAuthTokenSchema.index(
  { tenantId: 1, profileId: 1, userId: 1 },
  {
    partialFilterExpression: { profileId: { $type: 'string' } },
  },
);

// Tenant-level scoping
EndUserOAuthTokenSchema.index({ tenantId: 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('EndUserOAuthToken', EndUserOAuthTokenSchema, 'platform');

export const EndUserOAuthToken =
  (mongoose.models.EndUserOAuthToken as any) ||
  model<IEndUserOAuthToken>('EndUserOAuthToken', EndUserOAuthTokenSchema);
