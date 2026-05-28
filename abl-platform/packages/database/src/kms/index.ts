/**
 * KMS Module — Barrel Export
 *
 * Provides the KMS abstraction layer for external key management.
 */

// Types
export type {
  KMSProvider,
  GenerateDataKeyResult,
  WrapKeyResult,
  KMSKeyMetadata,
  KMSHealthStatus,
  KMSAADContext,
  KeyPurpose,
  KeyState,
  ProtectionLevel,
} from './types.js';
export { buildKMSAADBuffer } from './types.js';

// Local provider (dev/test default)
export { LocalKMSProvider } from './local-kms-provider.js';

// Registry (singleton + pool)
export {
  setPlatformKMSProvider,
  getPlatformKMSProvider,
  isPlatformKMSAvailable,
  setKMSProviderPool,
  getKMSProviderPool,
  isKMSProviderPoolAvailable,
  shutdownKMSRegistry,
  _resetKMSRegistryForTesting,
} from './kms-registry.js';

// Provider pool
export {
  KMSProviderPool,
  computeFingerprint,
  type KMSProviderPoolOptions,
} from './kms-provider-pool.js';
export { verifyProviderReadiness, type KMSReadinessStatus } from './provider-readiness.js';

// KMS Resolver (tenant → KMS config resolution)
export {
  KMSResolver,
  type ResolvedKMSConfig,
  type KMSResolverOptions,
  type InvalidationTransport,
} from './kms-resolver.js';

// KMS Resolver Accessor (typed globalThis bridge)
export {
  getGlobalKMSResolver,
  setGlobalKMSResolver,
  clearGlobalKMSResolver,
} from './kms-resolver-accessor.js';

// DEK Manager (per-tenant data encryption keys)
export {
  DEKManager,
  type DEKScope,
  type AcquiredDEK,
  type DEKManagerOptions,
} from './dek-manager.js';

// DEK Facade Factory (shared init for all server entry points)
export {
  initDEKFacade,
  type DEKFacadeInitResult,
  type DEKFacadeInitOptions,
} from './dek-facade-factory.js';

// Auth config crypto (platform-key encryption for tenant KMS credentials)
export { encryptAuthConfig, decryptAuthConfig } from './auth-config-crypto.js';

// Provider factory (value export) + type-only provider config re-exports
// Provider CLASS re-exports removed to prevent bundlers from pulling cloud SDKs
// (undici, @aws-sdk, @azure/*, @google-cloud/*) into lightweight consumers like Studio.
// Import provider classes directly: '@agent-platform/database/kms/providers/<name>'
export {
  createKMSProvider,
  type KMSProviderType,
  type KMSProviderConfig,
} from './providers/index.js';
export type { AWSKMSProviderConfig } from './providers/aws-kms-provider.js';
export type { AzureKeyVaultProviderConfig } from './providers/azure-keyvault-provider.js';
export type { GCPCloudKMSProviderConfig } from './providers/gcp-cloud-kms-provider.js';
export type {
  ExternalKMSProviderConfig,
  ExternalAuthMethod,
} from './providers/external-kms-provider.js';
