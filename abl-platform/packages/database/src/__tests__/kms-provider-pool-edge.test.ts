import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeFingerprint, KMSProviderPool } from '../kms/kms-provider-pool.js';
import type { IResolvedProviderRef } from '../models/materialized-kms-config.model.js';
import {
  setKMSProviderPool,
  getKMSProviderPool,
  isPlatformKMSAvailable,
  setPlatformKMSProvider,
  shutdownKMSRegistry,
  _resetKMSRegistryForTesting,
} from '../kms/kms-registry.js';
import { LocalKMSProvider } from '../kms/local-kms-provider.js';

const TEST_MASTER_KEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeRef(overrides: Partial<IResolvedProviderRef> = {}): IResolvedProviderRef {
  return {
    providerType: 'local',
    keyId: 'platform-default',
    region: null,
    vaultUrl: null,
    externalEndpoint: null,
    authMethod: null,
    authConfigEncrypted: null,
    ...overrides,
  };
}

// ===========================================================================
// computeFingerprint edge cases
// ===========================================================================

describe('computeFingerprint edge cases', () => {
  it('aws-kms includes region and keyId', () => {
    const fp = computeFingerprint(
      makeRef({ providerType: 'aws-kms', region: 'us-east-1', keyId: 'key-id' }),
    );
    expect(fp).toBe('aws-kms:us-east-1:key-id');
  });

  it('azure-keyvault uses vaultUrl and keyId', () => {
    const fp = computeFingerprint(
      makeRef({
        providerType: 'azure-keyvault',
        vaultUrl: 'https://my-vault.vault.azure.net',
        keyId: 'ignored',
      }),
    );
    expect(fp).toBe('azure-keyvault:https://my-vault.vault.azure.net:ignored');
  });

  it('azure-managed-hsm uses vaultUrl and keyId', () => {
    const fp = computeFingerprint(
      makeRef({
        providerType: 'azure-managed-hsm',
        vaultUrl: 'https://my-hsm.managedhsm.azure.net',
        keyId: 'ignored',
      }),
    );
    expect(fp).toBe('azure-managed-hsm:https://my-hsm.managedhsm.azure.net:ignored');
  });

  it('gcp-cloud-kms includes region and keyId', () => {
    const fp = computeFingerprint(
      makeRef({ providerType: 'gcp-cloud-kms', region: 'us-central1', keyId: 'gcp-key' }),
    );
    expect(fp).toBe('gcp-cloud-kms:us-central1:gcp-key');
  });

  it('external without authMethod omits auth part', () => {
    const fp = computeFingerprint(
      makeRef({
        providerType: 'external',
        externalEndpoint: 'https://endpoint',
        authMethod: null,
        keyId: 'ignored',
      }),
    );
    expect(fp).toBe('external:https://endpoint');
  });

  it('external with authMethod includes it', () => {
    const fp = computeFingerprint(
      makeRef({
        providerType: 'external',
        externalEndpoint: 'https://endpoint',
        authMethod: 'api-key',
        keyId: 'ignored',
      }),
    );
    expect(fp).toBe('external:https://endpoint:api-key');
  });

  it('unknown provider type uses providerType:keyId', () => {
    const fp = computeFingerprint(makeRef({ providerType: 'some-future-kms', keyId: 'my-key' }));
    expect(fp).toBe('some-future-kms:my-key');
  });
});

// ===========================================================================
// KMSProviderPool edge cases
// ===========================================================================

describe('KMSProviderPool edge cases', () => {
  let pool: KMSProviderPool;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown().catch(() => {});
    }
  });

  it('getLocalProvider throws before initialize', () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    expect(() => pool.getLocalProvider()).toThrow('KMSProviderPool not initialized');
  });

  it('getProvider before initialize still works for local type', async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    // getProvider calls computeFingerprint then looks up providers map;
    // for a local config it will create a new LocalKMSProvider (no throw on map miss).
    // The pool itself doesn't gate on initialized — the real guard is getLocalProvider.
    const provider = await pool.getProvider(
      makeRef({ providerType: 'local', keyId: 'uninitialized-key' }),
    );
    expect(provider).toBeDefined();
    expect(provider.providerType).toBe('local');
  });

  it('double initialize is idempotent', async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();
    await pool.initialize();
    const local = pool.getLocalProvider();
    expect(local).toBeDefined();
    expect(local.providerType).toBe('local');
  });

  it('evict never evicts the default local provider', async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();
    const sizeBefore = pool.size;
    await pool.evict('local:platform-default');
    expect(pool.size).toBe(sizeBefore);
  });

  it('evict non-existent fingerprint is no-op', async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();
    const sizeBefore = pool.size;
    await pool.evict('nonexistent');
    expect(pool.size).toBe(sizeBefore);
  });

  it('shutdown then getLocalProvider throws', async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();
    await pool.shutdown();
    expect(() => pool.getLocalProvider()).toThrow('KMSProviderPool not initialized');
  });

  it('concurrent getProvider for same fingerprint returns same instance', async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();

    // Pre-populate the provider so concurrent lookups hit the cache path
    const config = makeRef({ providerType: 'local', keyId: 'concurrent-key' });
    await pool.getProvider(config);

    const [p1, p2] = await Promise.all([pool.getProvider(config), pool.getProvider(config)]);
    expect(p1).toBe(p2);
  });

  it('LRU eviction preserves local provider', async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY, maxSize: 2 });
    await pool.initialize();

    // Pool has 1 slot used (local:platform-default). maxSize=2.
    // Add two more local providers to force eviction.
    await pool.getProvider(makeRef({ providerType: 'local', keyId: 'extra-1' }));
    await pool.getProvider(makeRef({ providerType: 'local', keyId: 'extra-2' }));

    // Local provider must still be accessible after eviction cycles
    const local = pool.getLocalProvider();
    expect(local).toBeDefined();
    expect(local.providerType).toBe('local');
  });
});

// ===========================================================================
// KMS Registry edge cases
// ===========================================================================

describe('KMS Registry edge cases', () => {
  beforeEach(() => {
    _resetKMSRegistryForTesting();
  });

  afterEach(() => {
    _resetKMSRegistryForTesting();
  });

  it('setKMSProviderPool sets platformProvider for backward compat', async () => {
    const pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();

    setKMSProviderPool(pool);
    expect(isPlatformKMSAvailable()).toBe(true);

    await pool.shutdown();
  });

  it('getKMSProviderPool throws when not set', () => {
    expect(() => getKMSProviderPool()).toThrow('no provider pool set');
  });

  it('shutdownKMSRegistry clears both pool and provider', async () => {
    const pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();
    setKMSProviderPool(pool);

    await shutdownKMSRegistry();

    expect(isPlatformKMSAvailable()).toBe(false);
    expect(() => getKMSProviderPool()).toThrow();
  });

  it('shutdownKMSRegistry falls back to provider shutdown when no pool', async () => {
    const provider = new LocalKMSProvider(TEST_MASTER_KEY);
    await provider.initialize();
    setPlatformKMSProvider(provider);

    expect(isPlatformKMSAvailable()).toBe(true);

    await shutdownKMSRegistry();

    expect(isPlatformKMSAvailable()).toBe(false);
  });

  it('_resetKMSRegistryForTesting clears without calling shutdown', async () => {
    const pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY });
    await pool.initialize();
    setKMSProviderPool(pool);

    _resetKMSRegistryForTesting();

    expect(isPlatformKMSAvailable()).toBe(false);
    expect(() => getKMSProviderPool()).toThrow();

    // Clean up the pool manually since reset didn't call shutdown
    await pool.shutdown();
  });
});
