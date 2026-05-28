/**
 * Re-exports from @agent-platform/shared-encryption for backward compatibility.
 */
export {
  // Engine
  EncryptionService,
  // Constants
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  KEY_LENGTH,
  MASTER_KEY_HEX_LENGTH,
  USER_KEY_DERIVATION_ITERATIONS,
  USER_KEY_DERIVATION_DIGEST,
  HKDF_HASH,
  // Errors
  masterKeyMissing,
  invalidFormat,
  contactSaltMissing,
  decompressionUnavailable,
  // Manifest
  CLICKHOUSE_ENCRYPTION_MANIFEST,
  REDIS_QUEUE_ENCRYPTION_MANIFEST,
  getClickHouseManifest,
  getRedisQueueManifest,
  // Master key resolver
  resolveMasterKey,
  // Field-level interceptor
  encryptFields,
  decryptFields,
  ENC_VALUE_PREFIX,
  // Secure queue wrappers
  wrapJobDataForEncrypt,
  unwrapJobDataForDecrypt,
  // Singleton
  getEncryptionService,
  isEncryptionAvailable,
  generateMasterKey,
  _resetEncryptionServiceForTesting,
  // DEK Encryption Facade
  TenantEncryptionFacade,
  // DEK-aware encrypt/decrypt helpers
  encryptForTenantAuto,
  decryptForTenantAuto,
  // Facade accessor
  getEncryptionFacade,
  isTenantEncryptionReady,
  setGlobalEncryptionFacade,
  clearGlobalEncryptionFacade,
  // Format detection
  isDEKEnvelopeFormat,
  // Registry
  isAlreadyEncrypted,
  ENCRYPTION_REGISTRY,
  getEntriesByScope,
  getEntriesWithNotes,
} from '@agent-platform/shared-encryption';

export type {
  EncryptionServiceConfig,
  EncryptionScope,
  StoreEncryptionConfig,
  VaultProvider,
  EncryptionPathEntry,
} from '@agent-platform/shared-encryption';
