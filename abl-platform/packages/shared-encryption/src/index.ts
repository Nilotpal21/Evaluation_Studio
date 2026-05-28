// Engine
export { EncryptionService } from './engine.js';

// DEK Envelope Encryption
export { TenantEncryptionFacade } from './tenant-encryption-facade.js';
export type { DEKScope, AcquiredDEK, DEKManagerLike } from './tenant-encryption-facade.js';
export { isDEKEnvelopeFormat } from './envelope-format.js';
export { buildTenantEncryptionAAD, buildTenantEncryptionAADCandidates } from './aad-context.js';
export type { TenantEncryptionAADContext } from './aad-context.js';

// Facade Accessor (typed globalThis bridge)
export {
  getEncryptionFacade,
  setGlobalEncryptionFacade,
  clearGlobalEncryptionFacade,
} from './facade-accessor.js';

// Encryption Context (AsyncLocalStorage for environment propagation — Decision 12)
export {
  encryptionContext,
  getEncryptionEnvironment,
  runWithEncryptionContext,
} from './encryption-context.js';
export type { EncryptionContext } from './encryption-context.js';

// Types
export type { EncryptionServiceConfig, EncryptionScope } from './types.js';

// Constants (for consumers who need them, e.g. database plugin)
export {
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  KEY_LENGTH,
  MASTER_KEY_HEX_LENGTH,
  USER_KEY_DERIVATION_ITERATIONS,
  USER_KEY_DERIVATION_DIGEST,
  HKDF_HASH,
} from './constants.js';

// Errors
export {
  masterKeyMissing,
  invalidFormat,
  contactSaltMissing,
  decompressionUnavailable,
  legacyCiphertextFormat,
  isLegacyCiphertextFormatError,
} from './errors.js';

// Manifest
export type { StoreEncryptionConfig } from './encryption-manifest.js';
export {
  CLICKHOUSE_ENCRYPTION_MANIFEST,
  REDIS_QUEUE_ENCRYPTION_MANIFEST,
  getClickHouseManifest,
  getRedisQueueManifest,
} from './encryption-manifest.js';

// Master key resolver
export { resolveMasterKey, type VaultProvider } from './master-key-resolver.js';

// Field-level interceptor
export {
  encryptFields,
  decryptFields,
  ENC_VALUE_PREFIX,
  type TenantFieldEncryptionService,
} from './field-interceptor.js';

// Secure queue wrappers
export { wrapJobDataForEncrypt, unwrapJobDataForDecrypt } from './secure-queue.js';

// Encryption registry & guards
export {
  isAlreadyEncrypted,
  ENCRYPTION_REGISTRY,
  getEntriesByScope,
  getEntriesWithNotes,
} from './encryption-registry.js';
export type {
  EncryptionPathEntry,
  EncryptionScope as RegistryScope,
} from './encryption-registry.js';

// ── Singleton ────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { EncryptionService } from './engine.js';
import { MASTER_KEY_HEX_LENGTH } from './constants.js';
import type { PreviousKeyConfig } from './types.js';
import { getEncryptionFacade } from './facade-accessor.js';

/**
 * Parse ENCRYPTION_PREVIOUS_MASTER_KEYS env var.
 * Format: "hexKey1:version1,hexKey2:version2"
 * The hex key is 64 chars ([0-9a-f]), version is a number.
 * Uses lastIndexOf(':') to split since hex keys don't contain ':'.
 */
function parsePreviousKeys(raw: string | undefined): PreviousKeyConfig[] {
  if (!raw) return [];
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const lastColon = entry.lastIndexOf(':');
      if (lastColon === -1) {
        throw new Error(
          `Invalid ENCRYPTION_PREVIOUS_MASTER_KEYS entry: missing version separator. ` +
            `Expected format "hexKey:version".`,
        );
      }
      const masterKeyHex = entry.substring(0, lastColon);
      const version = Number(entry.substring(lastColon + 1));
      if (!masterKeyHex || isNaN(version)) {
        throw new Error(
          `Invalid ENCRYPTION_PREVIOUS_MASTER_KEYS entry: masterKeyHex or version is invalid.`,
        );
      }
      return { masterKeyHex, version };
    });
}

let instance: EncryptionService | null = null;

/**
 * Get the singleton EncryptionService.
 * Reads ENCRYPTION_MASTER_KEY and ENCRYPTION_PREVIOUS_MASTER_KEYS from process.env on first call.
 */
export function getEncryptionService(): EncryptionService {
  if (!instance) {
    instance = new EncryptionService({
      masterKeyHex: process.env.ENCRYPTION_MASTER_KEY ?? '',
      previous: parsePreviousKeys(process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS),
    });
  }
  return instance;
}

/**
 * Check if encryption is available (master key is configured).
 */
export function isEncryptionAvailable(): boolean {
  if (process.env.ENCRYPTION_ENABLED === 'false') {
    return false;
  }
  const key = process.env.ENCRYPTION_MASTER_KEY;
  return !!key && key.length >= MASTER_KEY_HEX_LENGTH;
}

/**
 * Check if tenant-scoped DEK encryption is ready.
 *
 * This is the correct readiness gate for tenant secrets. It requires the
 * async TenantEncryptionFacade to be initialized, which in turn defaults to
 * platform-local KMS when no tenant/cloud provider is configured.
 */
export function isTenantEncryptionReady(): boolean {
  return getEncryptionFacade() !== undefined;
}

/**
 * Generate a new random master key.
 * Returns a 32-byte hex string suitable for ENCRYPTION_MASTER_KEY.
 */
export function generateMasterKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Reset the singleton (for testing only).
 */
export function _resetEncryptionServiceForTesting(): void {
  instance = null;
}

/**
 * Encrypt plaintext for a tenant — preferred entry point for all service code.
 *
 * Uses DEK envelope encryption via TenantEncryptionFacade.
 */
export async function encryptForTenantAuto(
  plaintext: string,
  tenantId: string,
  projectId = '_tenant',
  environment = '_shared',
  context?: import('./aad-context.js').TenantEncryptionAADContext,
): Promise<string> {
  const facade = getEncryptionFacade();
  if (!facade) {
    throw new Error('Tenant DEK facade is not initialized. Refusing legacy encryption fallback.');
  }
  return facade.encrypt(plaintext, { tenantId, projectId, environment }, context);
}

/**
 * Async decrypt — preferred entry point for all service code.
 *
 * Uses DEK encryption facade only.
 *
 * Decision 3: Only tenantId needed — DEK ID is extracted from ciphertext header.
 * tenantId is used to enforce cross-tenant DEK isolation.
 */
export async function decryptForTenantAuto(
  encrypted: string,
  tenantId: string,
  context?: import('./aad-context.js').TenantEncryptionAADContext,
): Promise<string> {
  const facade = getEncryptionFacade();
  if (!facade) {
    throw new Error('Tenant DEK facade is not initialized. Refusing legacy decryption fallback.');
  }
  return facade.decrypt(encrypted, tenantId, context);
}
