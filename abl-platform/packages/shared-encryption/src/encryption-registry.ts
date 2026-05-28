/**
 * Centralized Encryption Registry
 *
 * Declares every encryption path in the platform: what data is encrypted,
 * which method/key scope is used, and where the encrypt/decrypt call sites live.
 *
 * This is the single source of truth for reviewing encryption correctness.
 * Any new encrypted field MUST be registered here. The registry is also used
 * by the `isAlreadyEncrypted()` guard to prevent double encryption.
 *
 * Key scopes:
 *   - tenant:  DEK envelope via TenantEncryptionFacade
 *   - user:    user-scoped master-key encryption (non-tenant secrets such as MFA)
 *   - contact: HKDF(masterKey, tenantId, "encryption-key") — GDPR shredding
 *
 * Encryption layers:
 *   - mongoose-plugin: Transparent pre-save/post-find via encryptionPlugin (DEK envelope only)
 *   - field-interceptor: ClickHouse/Redis field-level via encryptFields/decryptFields
 *   - direct: Explicit encryptForTenant/decryptForTenant calls in application code
 */

// ─── Encrypted Format Detection ─────────────────────────────────────────

import { isDEKEnvelopeFormat } from './envelope-format.js';

const HEX_3_PART_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;
const COMPRESSED_4_PART_RE = /^(Z1|N0):[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/**
 * Check if a value is already in an encrypted format.
 * Detects the currently supported runtime formats plus legacy markers so
 * double-encryption guards remain safe during cleanup:
 *   - user/master-key hex 3-part: iv:authTag:ciphertext
 *   - ENC:v3: prefix (field interceptor / queue wrapper marker)
 *   - compressed 4-part legacy marker: Z1|N0:iv:authTag:ciphertext
 *   - DEK envelope: base64(idLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)
 *
 * Use this as a guard before any encrypt call to prevent double encryption.
 */
export function isAlreadyEncrypted(value: string): boolean {
  if (value.startsWith('ENC:v3:')) return true;
  if (HEX_3_PART_RE.test(value)) return true;
  if (COMPRESSED_4_PART_RE.test(value)) return true;
  if (isDEKEnvelopeFormat(value)) return true;
  return false;
}

// ─── Registry Types ──────────────────────────────────────────────────────

export type EncryptionScope = 'tenant' | 'user' | 'contact';

export type EncryptionLayer =
  | 'mongoose-plugin' // Transparent via encryptionPlugin
  | 'field-interceptor' // ClickHouse/Redis field-level
  | 'secure-queue' // BullMQ job data wrapper
  | 'direct'; // Explicit encrypt/decrypt calls

export interface EncryptionPathEntry {
  /** Human-readable name for this encrypted data */
  readonly dataType: string;
  /** Key derivation scope */
  readonly scope: EncryptionScope;
  /** Which encryption layer handles it */
  readonly layer: EncryptionLayer;
  /** File path where encryption happens (for code review) */
  readonly encryptSite: string;
  /** File path where decryption happens (for code review) */
  readonly decryptSite: string;
  /** Notes about migration status, legacy paths, etc. */
  readonly notes?: string;
}

// ─── Registry ────────────────────────────────────────────────────────────

/**
 * Every encryption path in the platform. Add new entries when introducing
 * encrypted fields. Review this during security audits.
 */
export const ENCRYPTION_REGISTRY: readonly EncryptionPathEntry[] = [
  // ── Mongoose Plugin (tenant-scoped DEK envelope, transparent) ───────────
  {
    dataType: 'LLM credential API key',
    scope: 'tenant',
    layer: 'mongoose-plugin',
    encryptSite: 'packages/database/src/models/llm-credential.model.ts (pre-save hook)',
    decryptSite: 'packages/database/src/models/llm-credential.model.ts (post-find hook)',
    notes:
      'Fields: encryptedApiKey, encryptedEndpoint. Studio stores plaintext; plugin handles crypto.',
  },
  {
    dataType: 'Tool secret value',
    scope: 'tenant',
    layer: 'mongoose-plugin',
    encryptSite: 'packages/database/src/models/tool-secret.model.ts (pre-save hook)',
    decryptSite: 'packages/database/src/models/tool-secret.model.ts (post-find hook)',
  },
  {
    dataType: 'Auth profile secrets',
    scope: 'tenant',
    layer: 'mongoose-plugin',
    encryptSite: 'packages/database/src/models/auth-profile.model.ts (pre-save hook)',
    decryptSite: 'packages/database/src/models/auth-profile.model.ts (post-find hook)',
  },

  // ── Direct tenant-scoped encryption ────────────────────────────────
  {
    dataType: 'OAuth access/refresh tokens',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/runtime/src/services/tool-oauth-service.ts',
    decryptSite: 'apps/runtime/src/services/tool-oauth-service.ts',
  },
  {
    dataType: 'Session conversation history (Redis)',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/runtime/src/services/session/redis-session-store.ts',
    decryptSite: 'apps/runtime/src/services/session/redis-session-store.ts',
  },
  {
    dataType: 'Channel connection credentials',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/runtime/src/channels/connection-resolver.ts',
    decryptSite: 'apps/runtime/src/channels/connection-resolver.ts',
  },
  {
    dataType: 'Connection encryptedApiKey (direct on connection)',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/studio/src/lib/connection-service.ts',
    decryptSite: 'apps/runtime/src/services/llm/model-resolution.ts',
  },
  {
    dataType: 'Secrets provider (env vars, tool secrets)',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/runtime/src/services/secrets-provider.ts',
    decryptSite: 'apps/runtime/src/services/secrets-provider.ts',
  },
  {
    dataType: 'SSO config',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/studio/src/app/api/sso/config/route.ts',
    decryptSite: 'apps/studio/src/lib/sso-helpers.ts',
  },
  {
    dataType: 'Git credential secret',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/studio/src/lib/git-credentials.ts',
    decryptSite: 'apps/studio/src/lib/git-credentials.ts',
  },
  {
    dataType: 'PIIVault serialization',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'packages/compiler/src/platform/security/encrypted-vault.ts',
    decryptSite: 'packages/compiler/src/platform/security/encrypted-vault.ts',
  },
  {
    dataType: 'Durable PII token originals',
    scope: 'tenant',
    layer: 'mongoose-plugin',
    encryptSite: 'packages/database/src/models/pii-token-vault.model.ts (pre-save hook)',
    decryptSite: 'packages/database/src/models/pii-token-vault.model.ts (post-find hook)',
    notes:
      'Field: encryptedOriginalValue. This is the only durable raw-value source for audited reveal; messages and traces remain redacted/tokenized.',
  },
  {
    dataType: 'Session metadata/providerData (agent transfer)',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'packages/agent-transfer/src/security/session-field-encryption.ts',
    decryptSite: 'packages/agent-transfer/src/security/session-field-encryption.ts',
  },
  {
    dataType: 'Webhook delivery subscription secret',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/runtime/src/services/queues/delivery-worker.ts',
    decryptSite: 'apps/runtime/src/services/queues/delivery-worker.ts',
  },
  {
    dataType: 'Workflow engine secrets callbacks',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'apps/workflow-engine/src/index.ts',
    decryptSite: 'apps/workflow-engine/src/index.ts',
  },

  // ── ClickHouse field-level encryption ──────────────────────────────
  {
    dataType: 'ClickHouse messages.content',
    scope: 'tenant',
    layer: 'field-interceptor',
    encryptSite:
      'packages/shared-encryption/src/encryption-manifest.ts (CLICKHOUSE_ENCRYPTION_MANIFEST)',
    decryptSite: 'packages/database/src/clickhouse-encryption-interceptor.ts',
  },
  {
    dataType: 'ClickHouse traces.data',
    scope: 'tenant',
    layer: 'field-interceptor',
    encryptSite:
      'packages/shared-encryption/src/encryption-manifest.ts (CLICKHOUSE_ENCRYPTION_MANIFEST)',
    decryptSite: 'packages/database/src/clickhouse-encryption-interceptor.ts',
  },
  {
    dataType: 'ClickHouse platform_events.data',
    scope: 'tenant',
    layer: 'field-interceptor',
    encryptSite:
      'packages/shared-encryption/src/encryption-manifest.ts (CLICKHOUSE_ENCRYPTION_MANIFEST)',
    decryptSite: 'packages/database/src/clickhouse-encryption-interceptor.ts',
  },
  {
    dataType: 'ClickHouse audit_events.metadata/old_value/new_value',
    scope: 'tenant',
    layer: 'field-interceptor',
    encryptSite:
      'packages/shared-encryption/src/encryption-manifest.ts (CLICKHOUSE_ENCRYPTION_MANIFEST)',
    decryptSite: 'packages/database/src/clickhouse-encryption-interceptor.ts',
  },
  {
    dataType: 'ClickHouse insight_results.dimensions',
    scope: 'tenant',
    layer: 'field-interceptor',
    encryptSite:
      'packages/shared-encryption/src/encryption-manifest.ts (CLICKHOUSE_ENCRYPTION_MANIFEST)',
    decryptSite: 'packages/database/src/clickhouse-encryption-interceptor.ts',
  },

  // ── Redis queue encryption ─────────────────────────────────────────
  {
    dataType: 'BullMQ llm-requests.message',
    scope: 'tenant',
    layer: 'secure-queue',
    encryptSite:
      'packages/shared-encryption/src/encryption-manifest.ts (REDIS_QUEUE_ENCRYPTION_MANIFEST)',
    decryptSite: 'packages/shared-encryption/src/secure-queue.ts',
  },
  {
    dataType: 'BullMQ message-persistence.content',
    scope: 'tenant',
    layer: 'secure-queue',
    encryptSite: 'apps/runtime/src/services/message-persistence-queue.ts',
    decryptSite: 'apps/runtime/src/services/message-persistence-queue.ts',
  },

  // ── Contact PII (GDPR crypto-shredding) ────────────────────────────
  {
    dataType: 'Contact identity (email, phone)',
    scope: 'contact',
    layer: 'direct',
    encryptSite: 'apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts',
    decryptSite: 'apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts',
  },

  // ── User-scoped (LEGACY — migrate to tenant) ──────────────────────
  {
    dataType: 'MFA TOTP secret',
    scope: 'user',
    layer: 'direct',
    encryptSite: 'apps/studio/src/services/auth/mfa-service.ts',
    decryptSite: 'apps/studio/src/services/auth/mfa-service.ts',
    notes: 'User-scoped is correct here: TOTP is per-user, not per-tenant.',
  },
  {
    dataType: 'Webhook clientState (SharePoint)',
    scope: 'tenant',
    layer: 'direct',
    encryptSite: 'packages/connectors/sharepoint/src/webhooks/webhook-manager.ts',
    decryptSite: 'apps/search-ai/src/routes/webhooks.ts',
    notes: 'Migrated from user-scoped .encrypt() to tenant-scoped .encryptForTenant().',
  },
] as const;

// ─── Validation Helpers ──────────────────────────────────────────────────

/**
 * Get all registry entries that use a specific scope.
 * Useful for auditing: `getEntriesByScope('user')` shows all legacy paths.
 */
export function getEntriesByScope(scope: EncryptionScope): readonly EncryptionPathEntry[] {
  return ENCRYPTION_REGISTRY.filter((e) => e.scope === scope);
}

/**
 * Get all registry entries with notes (typically bugs or migration items).
 */
export function getEntriesWithNotes(): readonly EncryptionPathEntry[] {
  return ENCRYPTION_REGISTRY.filter((e) => e.notes);
}
