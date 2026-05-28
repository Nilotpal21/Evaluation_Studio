import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KMSProviderPool } from '../kms/kms-provider-pool.js';
import type { IResolvedProviderRef } from '../models/materialized-kms-config.model.js';

const TEST_MASTER_KEY = 'a'.repeat(64);

const localConfig: IResolvedProviderRef = {
  providerType: 'local',
  keyId: 'platform-default',
  region: null,
  vaultUrl: null,
  externalEndpoint: null,
  authMethod: null,
  authConfigEncrypted: null,
};

const awsConfig: IResolvedProviderRef = {
  providerType: 'local', // Use local to simulate — real AWS needs creds
  keyId: 'aws-test-key',
  region: 'us-east-1',
  vaultUrl: null,
  externalEndpoint: null,
  authMethod: null,
  authConfigEncrypted: null,
};

describe('KMSProviderPool', () => {
  let pool: KMSProviderPool;

  beforeEach(async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY, maxSize: 5 });
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('getLocalProvider returns initialized local provider', () => {
    const local = pool.getLocalProvider();
    expect(local).toBeDefined();
    expect(local.providerType).toBe('local');
  });

  it('getProvider returns local provider for local config', async () => {
    const provider = await pool.getProvider(localConfig);
    expect(provider.providerType).toBe('local');
  });

  it('same fingerprint returns same instance', async () => {
    const p1 = await pool.getProvider(localConfig);
    const p2 = await pool.getProvider(localConfig);
    expect(p1).toBe(p2);
  });

  it('different fingerprints return different instances', async () => {
    const p1 = await pool.getProvider(localConfig);
    const p2 = await pool.getProvider(awsConfig);
    expect(p1).not.toBe(p2);
  });

  it('evict removes provider from pool', async () => {
    await pool.getProvider(awsConfig);
    expect(pool.size).toBe(2); // local + aws
    await pool.evict('local:aws-test-key');
    expect(pool.size).toBe(1);
  });

  it('shutdown clears all providers', async () => {
    await pool.getProvider(awsConfig);
    await pool.shutdown();
    expect(pool.size).toBe(0);
  });

  describe('FR-14: auth fail-closed on per-tenant decrypt failure', () => {
    it('should throw (not fall back to env vars) when authConfigEncrypted decrypt fails', async () => {
      const perTenantConfig: IResolvedProviderRef = {
        providerType: 'aws-kms',
        keyId: 'tenant-kek-id',
        region: 'us-east-1',
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        // Invalid encrypted blob — will fail to decrypt
        authConfigEncrypted: 'this-is-invalid-encrypted-data',
      };

      // This should throw because decryption of authConfigEncrypted fails.
      // It must NOT fall through to platform env var credentials (privilege escalation).
      await expect(pool.getProvider(perTenantConfig)).rejects.toThrow(
        /Failed to decrypt per-tenant authConfigEncrypted/,
      );
    });

    it('should use platform env vars when authConfigEncrypted is null (platform default path)', async () => {
      // No authConfigEncrypted — this is the platform default path, should not throw
      const platformConfig: IResolvedProviderRef = {
        providerType: 'local',
        keyId: 'platform-key',
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      };

      // Local provider path succeeds without any auth config
      const provider = await pool.getProvider(platformConfig);
      expect(provider).toBeDefined();
    });
  });

  it('evicts LRU when pool is full', async () => {
    // Pool maxSize=5, local takes 1 slot
    for (let i = 0; i < 4; i++) {
      await pool.getProvider({
        ...localConfig,
        keyId: `key-${i}`,
      });
    }
    // 5th different config should evict LRU (not throw)
    const p = await pool.getProvider({ ...localConfig, keyId: 'key-overflow' });
    expect(p).toBeDefined();
    expect(pool.size).toBeLessThanOrEqual(5);
  });
});
