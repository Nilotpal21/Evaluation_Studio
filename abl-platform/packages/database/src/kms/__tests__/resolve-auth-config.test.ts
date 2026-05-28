/**
 * Tests for KMSProviderPool.resolveAuthConfig (Phase 2)
 *
 * Verifies that per-tenant encrypted auth config blobs are decrypted
 * and passed to the provider factory, and that env var fallback works
 * when authConfigEncrypted is null.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { IResolvedProviderRef } from '../../models/materialized-kms-config.model.js';
import { LocalKMSProvider } from '../local-kms-provider.js';
import { encryptAuthConfig } from '../auth-config-crypto.js';

const MASTER_KEY_HEX = 'a'.repeat(64);
const PLATFORM_KEY_ID = 'platform-default';

// ---------------------------------------------------------------------------
// Mock the provider factory to capture what auth config is passed
// ---------------------------------------------------------------------------

const capturedConfigs: Record<string, unknown>[] = [];

vi.mock('../providers/index.js', () => ({
  createKMSProvider: async (config: Record<string, unknown>) => {
    capturedConfigs.push(config);
    return {
      providerType: config.providerType,
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
      generateDataKey: vi.fn(),
      wrapKey: vi.fn().mockImplementation(async (keyId: string, plaintext: Buffer) => ({
        ciphertext: Buffer.from(plaintext),
        keyId,
        keyVersion: 1,
      })),
      unwrapKey: vi
        .fn()
        .mockImplementation(async (_keyId: string, ciphertext: Buffer) => Buffer.from(ciphertext)),
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      createKey: vi.fn(),
      describeKey: vi.fn(),
      enableKeyRotation: vi.fn(),
      scheduleKeyDeletion: vi.fn(),
    };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRef(overrides: Partial<IResolvedProviderRef> = {}): IResolvedProviderRef {
  return {
    providerType: 'aws-kms',
    keyId: 'arn:aws:kms:us-east-1:123456789:key/test-key',
    region: 'us-east-1',
    vaultUrl: null,
    externalEndpoint: null,
    authMethod: null,
    authConfigEncrypted: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('KMSProviderPool.resolveAuthConfig (per-tenant decryption)', () => {
  let localProvider: LocalKMSProvider;

  beforeAll(async () => {
    localProvider = new LocalKMSProvider(MASTER_KEY_HEX);
    await localProvider.initialize();
  });

  afterAll(async () => {
    await localProvider.shutdown();
  });

  // Import pool dynamically after mock is set up
  async function createPool() {
    const { KMSProviderPool } = await import('../kms-provider-pool.js');
    const pool = new KMSProviderPool({ masterKeyHex: MASTER_KEY_HEX });
    await pool.initialize();
    return pool;
  }

  it('decrypts authConfigEncrypted for aws-kms tenant config', async () => {
    const awsCreds = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    };
    const encrypted = await encryptAuthConfig(awsCreds, localProvider, PLATFORM_KEY_ID);

    capturedConfigs.length = 0;
    const pool = await createPool();
    try {
      await pool.getProvider(
        makeRef({
          providerType: 'aws-kms',
          keyId: 'arn:aws:kms:us-east-1:123456789:key/test-key',
          region: 'us-east-1',
          authConfigEncrypted: encrypted,
        }),
      );

      expect(capturedConfigs.length).toBe(1);
      const passed = capturedConfigs[0];
      expect(passed.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
      expect(passed.secretAccessKey).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(passed.providerType).toBe('aws-kms');
    } finally {
      await pool.shutdown();
    }
  });

  it('decrypts authConfigEncrypted for azure-keyvault tenant config', async () => {
    const azureCreds = {
      tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      clientId: '11111111-2222-3333-4444-555555555555',
      clientSecret: 'my-azure-client-secret',
    };
    const encrypted = await encryptAuthConfig(azureCreds, localProvider, PLATFORM_KEY_ID);

    capturedConfigs.length = 0;
    const pool = await createPool();
    try {
      await pool.getProvider(
        makeRef({
          providerType: 'azure-keyvault',
          keyId: 'my-key',
          vaultUrl: 'https://my-vault.vault.azure.net',
          authConfigEncrypted: encrypted,
        }),
      );

      expect(capturedConfigs.length).toBe(1);
      const passed = capturedConfigs[0];
      expect(passed.tenantId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(passed.clientId).toBe('11111111-2222-3333-4444-555555555555');
      expect(passed.clientSecret).toBe('my-azure-client-secret');
      expect(passed.providerType).toBe('azure-keyvault');
    } finally {
      await pool.shutdown();
    }
  });

  it('falls back to env vars when authConfigEncrypted is null', async () => {
    // Set env vars for the fallback path
    const originalAccessKey = process.env.KMS_AWS_ACCESS_KEY_ID;
    const originalSecretKey = process.env.KMS_AWS_SECRET_ACCESS_KEY;
    process.env.KMS_AWS_ACCESS_KEY_ID = 'ENV_ACCESS_KEY';
    process.env.KMS_AWS_SECRET_ACCESS_KEY = 'ENV_SECRET_KEY';

    capturedConfigs.length = 0;
    const pool = await createPool();
    try {
      await pool.getProvider(
        makeRef({
          providerType: 'aws-kms',
          keyId: 'arn:aws:kms:us-east-1:123456789:key/env-key',
          region: 'us-east-1',
          authConfigEncrypted: null,
        }),
      );

      expect(capturedConfigs.length).toBe(1);
      const passed = capturedConfigs[0];
      expect(passed.accessKeyId).toBe('ENV_ACCESS_KEY');
      expect(passed.secretAccessKey).toBe('ENV_SECRET_KEY');
    } finally {
      await pool.shutdown();
      // Restore env
      if (originalAccessKey === undefined) delete process.env.KMS_AWS_ACCESS_KEY_ID;
      else process.env.KMS_AWS_ACCESS_KEY_ID = originalAccessKey;
      if (originalSecretKey === undefined) delete process.env.KMS_AWS_SECRET_ACCESS_KEY;
      else process.env.KMS_AWS_SECRET_ACCESS_KEY = originalSecretKey;
    }
  });

  it('decrypts authConfigEncrypted for external BYOP config', async () => {
    const externalCreds = {
      externalApiKey: 'byop-api-key-1234',
    };
    const encrypted = await encryptAuthConfig(externalCreds, localProvider, PLATFORM_KEY_ID);

    capturedConfigs.length = 0;
    const pool = await createPool();
    try {
      await pool.getProvider(
        makeRef({
          providerType: 'external',
          keyId: 'ext-key',
          externalEndpoint: 'https://my-kms.example.com',
          authMethod: 'api-key',
          authConfigEncrypted: encrypted,
        }),
      );

      expect(capturedConfigs.length).toBe(1);
      const passed = capturedConfigs[0];
      expect(passed.externalApiKey).toBe('byop-api-key-1234');
      expect(passed.providerType).toBe('external');
    } finally {
      await pool.shutdown();
    }
  });

  it('throws (fail-closed) when decryption fails on tampered blob — never falls back to env vars', async () => {
    const pool = await createPool();
    try {
      // FR-14: per-tenant authConfigEncrypted decrypt failure must throw,
      // not silently fall back to platform env var credentials (privilege escalation).
      await expect(
        pool.getProvider(
          makeRef({
            providerType: 'aws-kms',
            keyId: 'arn:aws:kms:us-east-1:123456789:key/tampered-key',
            region: 'us-east-1',
            authConfigEncrypted: 'INVALIDBASE64CIPHERTEXT',
          }),
        ),
      ).rejects.toThrow(/Failed to decrypt per-tenant authConfigEncrypted/);
    } finally {
      await pool.shutdown();
    }
  });
});
