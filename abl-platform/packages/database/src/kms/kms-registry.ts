/**
 * KMS Registry — Singleton + Pool
 *
 * Global registry for the platform KMS provider and provider pool.
 * Follows the HybridCircuitBreakerRegistry singleton pattern.
 *
 * Usage:
 *   // At startup (server.ts) — preferred pool-based approach:
 *   const pool = new KMSProviderPool({ masterKeyHex });
 *   await pool.initialize();
 *   setKMSProviderPool(pool);
 *
 *   // Legacy singleton approach (still supported):
 *   const provider = new LocalKMSProvider(masterKeyHex);
 *   await provider.initialize();
 *   setPlatformKMSProvider(provider);
 *
 *   // In services:
 *   const kms = getPlatformKMSProvider();
 *   const { plaintext, ciphertext } = await kms.generateDataKey(keyId);
 *
 *   // At shutdown:
 *   await shutdownKMSRegistry();
 */

import type { KMSProvider } from './types.js';
import type { KMSProviderPool } from './kms-provider-pool.js';

// =============================================================================
// SINGLETON STATE
// =============================================================================

let platformProvider: KMSProvider | null = null;
let providerPool: KMSProviderPool | null = null;

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Set the platform-wide KMS provider.
 * Called once at server startup after provider initialization.
 *
 * @throws if a provider is already set (prevents accidental overwrites)
 */
export function setPlatformKMSProvider(provider: KMSProvider): void {
  if (platformProvider) {
    throw new Error(
      `KMS Registry: platform provider already set (type: ${platformProvider.providerType}). ` +
        'Call shutdownKMSRegistry() first to replace.',
    );
  }
  platformProvider = provider;
}

/**
 * Get the platform-wide KMS provider.
 *
 * @throws if no provider has been set
 */
export function getPlatformKMSProvider(): KMSProvider {
  if (!platformProvider) {
    throw new Error(
      'KMS Registry: no platform provider set. ' + 'Call setPlatformKMSProvider() at startup.',
    );
  }
  return platformProvider;
}

/**
 * Check if a platform KMS provider is available.
 * Safe to call at any time — never throws.
 */
export function isPlatformKMSAvailable(): boolean {
  return platformProvider !== null;
}

/**
 * Set the KMS provider pool.
 * Also sets platformProvider for backward compatibility.
 */
export function setKMSProviderPool(pool: KMSProviderPool): void {
  providerPool = pool;
  // Also set platformProvider for backward compat
  platformProvider = pool.getLocalProvider();
}

/**
 * Get the KMS provider pool.
 *
 * @throws if no pool has been set
 */
export function getKMSProviderPool(): KMSProviderPool {
  if (!providerPool) {
    throw new Error('KMS Registry: no provider pool set. Call setKMSProviderPool() at startup.');
  }
  return providerPool;
}

/**
 * Check if a KMS provider pool is available.
 * Safe to call at any time — never throws.
 */
export function isKMSProviderPoolAvailable(): boolean {
  return providerPool !== null;
}

/**
 * Shutdown the KMS registry.
 * Calls shutdown() on the current pool/provider and clears the singleton.
 * Should be called during server shutdown before database disconnect.
 */
export async function shutdownKMSRegistry(): Promise<void> {
  if (providerPool) {
    const pool = providerPool;
    providerPool = null;
    platformProvider = null;
    await pool.shutdown();
  } else if (platformProvider) {
    const provider = platformProvider;
    platformProvider = null;
    await provider.shutdown();
  }
}

/**
 * Reset the KMS registry without calling shutdown.
 * For testing only — allows replacing the provider in tests.
 */
export function _resetKMSRegistryForTesting(): void {
  platformProvider = null;
  providerPool = null;
}
