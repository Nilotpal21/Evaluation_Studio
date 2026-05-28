/**
 * DEK Facade Factory Tests (FR-18)
 *
 * Validates: initDEKFacade creates the full DEK encryption stack
 * and wires it into the Mongoose encryption plugin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetKMSRegistryForTesting,
  isKMSProviderPoolAvailable,
  setKMSProviderPool,
} from '../kms/kms-registry.js';
import { initDEKFacade } from '../kms/dek-facade-factory.js';
import {
  isFacadeEncryptionAvailable,
  _resetEncryptionStateForTesting,
} from '../mongo/plugins/encryption.plugin.js';

const TEST_MASTER_KEY = 'a'.repeat(64);

describe('initDEKFacade (FR-18)', () => {
  beforeEach(() => {
    _resetKMSRegistryForTesting();
    _resetEncryptionStateForTesting();
  });

  afterEach(() => {
    _resetKMSRegistryForTesting();
    _resetEncryptionStateForTesting();
  });

  it('should initialize KMS provider pool, DEKManager, resolver, and inject facade', async () => {
    expect(isKMSProviderPoolAvailable()).toBe(false);
    expect(isFacadeEncryptionAvailable()).toBe(false);

    const result = await initDEKFacade({ masterKeyHex: TEST_MASTER_KEY });

    expect(result).not.toBeNull();
    expect(result!.facade).toBeDefined();
    expect(result!.dekManager).toBeDefined();
    expect(result!.resolver).toBeDefined();
    expect(result!.implicitLocalDekCheck).toEqual({
      checked: false,
      hasMatches: false,
      sample: null,
    });

    // Pool should now be available globally
    expect(isKMSProviderPoolAvailable()).toBe(true);

    // Facade should be injected into the encryption plugin
    expect(isFacadeEncryptionAvailable()).toBe(true);
  });

  it('should reuse existing KMS pool if already initialized', async () => {
    // Pre-initialize a pool
    const { KMSProviderPool } = await import('../kms/kms-provider-pool.js');
    const existingPool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await existingPool.initialize();
    setKMSProviderPool(existingPool);

    expect(isKMSProviderPoolAvailable()).toBe(true);
    const poolSizeBefore = existingPool.size;

    const result = await initDEKFacade({ masterKeyHex: TEST_MASTER_KEY });

    expect(result).not.toBeNull();
    expect(result!.implicitLocalDekCheck).toEqual({
      checked: false,
      hasMatches: false,
      sample: null,
    });
    // Pool size should not change — it reused the existing one
    expect(existingPool.size).toBe(poolSizeBefore);
  });

  it('should use custom defaultKekKeyId when provided', async () => {
    const result = await initDEKFacade({
      masterKeyHex: TEST_MASTER_KEY,
      defaultKekKeyId: 'custom-kek-id',
    });

    expect(result).not.toBeNull();
    expect(result!.implicitLocalDekCheck).toEqual({
      checked: false,
      hasMatches: false,
      sample: null,
    });
    // The facade was created — verify it's functional by checking availability
    expect(isFacadeEncryptionAvailable()).toBe(true);
  });
});
