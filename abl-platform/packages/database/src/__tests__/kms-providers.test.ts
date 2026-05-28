/**
 * KMS Provider Factory & Cloud Provider Tests
 *
 * Validates: factory validation, provider construction, uninitialized guards,
 * provider type assignment, and class inheritance (AzureManagedHSM extends AzureKeyVault).
 *
 * Cloud SDKs are NOT installed (optional peer dependencies), so we only test:
 *   - Factory config validation (missing required params)
 *   - Provider class construction (no SDK needed)
 *   - Uninitialized provider guard errors
 *   - Factory returns correct type for 'local'
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createKMSProvider } from '../kms/providers/index.js';
import { AWSKMSProvider } from '../kms/providers/aws-kms-provider.js';
import { AzureKeyVaultProvider } from '../kms/providers/azure-keyvault-provider.js';
import { AzureManagedHSMProvider } from '../kms/providers/azure-managed-hsm-provider.js';
import { GCPCloudKMSProvider } from '../kms/providers/gcp-cloud-kms-provider.js';
import { LocalKMSProvider } from '../kms/local-kms-provider.js';

// =============================================================================
// FACTORY: createKMSProvider
// =============================================================================

describe('createKMSProvider factory', () => {
  it('returns a LocalKMSProvider for providerType "local" with valid masterKeyHex', async () => {
    const masterKeyHex = randomBytes(32).toString('hex');
    const provider = await createKMSProvider({
      providerType: 'local',
      masterKeyHex,
    });

    expect(provider).toBeInstanceOf(LocalKMSProvider);
    expect(provider.providerType).toBe('local');
  });

  it('throws when providerType is "local" but masterKeyHex is missing', async () => {
    await expect(createKMSProvider({ providerType: 'local' })).rejects.toThrow(
      'requires masterKeyHex',
    );
  });

  it('throws when providerType is "aws-kms" but region and keyId are missing', async () => {
    await expect(createKMSProvider({ providerType: 'aws-kms' })).rejects.toThrow(
      'requires region and keyId',
    );
  });

  it('throws when providerType is "aws-kms" with region but missing keyId', async () => {
    await expect(
      createKMSProvider({ providerType: 'aws-kms', region: 'us-east-1' }),
    ).rejects.toThrow('requires region and keyId');
  });

  it('throws when providerType is "aws-kms" with keyId but missing region', async () => {
    await expect(
      createKMSProvider({ providerType: 'aws-kms', keyId: 'arn:aws:kms:...' }),
    ).rejects.toThrow('requires region and keyId');
  });

  it('throws when providerType is "azure-keyvault" but vaultUrl and keyName are missing', async () => {
    await expect(createKMSProvider({ providerType: 'azure-keyvault' })).rejects.toThrow(
      'requires vaultUrl and keyName',
    );
  });

  it('throws when providerType is "azure-keyvault" with vaultUrl but missing keyName', async () => {
    await expect(
      createKMSProvider({
        providerType: 'azure-keyvault',
        vaultUrl: 'https://myvault.vault.azure.net',
      }),
    ).rejects.toThrow('requires vaultUrl and keyName');
  });

  it('throws when providerType is "azure-managed-hsm" but vaultUrl and keyName are missing', async () => {
    await expect(createKMSProvider({ providerType: 'azure-managed-hsm' })).rejects.toThrow(
      'requires vaultUrl and keyName',
    );
  });

  it('throws when providerType is "azure-managed-hsm" with vaultUrl but missing keyName', async () => {
    await expect(
      createKMSProvider({
        providerType: 'azure-managed-hsm',
        vaultUrl: 'https://myhsm.managedhsm.azure.net',
      }),
    ).rejects.toThrow('requires vaultUrl and keyName');
  });

  it('throws when providerType is "gcp-cloud-kms" but required fields are missing', async () => {
    await expect(createKMSProvider({ providerType: 'gcp-cloud-kms' })).rejects.toThrow(
      'requires projectId, location, keyRing, and keyName',
    );
  });

  it('throws when providerType is "gcp-cloud-kms" with partial config (missing keyRing)', async () => {
    await expect(
      createKMSProvider({
        providerType: 'gcp-cloud-kms',
        projectId: 'my-project',
        location: 'us-east1',
        keyName: 'my-key',
      }),
    ).rejects.toThrow('requires projectId, location, keyRing, and keyName');
  });

  it('throws for unknown provider type', async () => {
    await expect(createKMSProvider({ providerType: 'unknown' as any })).rejects.toThrow(
      'Unknown KMS provider type',
    );
  });
});

// =============================================================================
// AWS KMS PROVIDER
// =============================================================================

describe('AWSKMSProvider', () => {
  const config = {
    region: 'us-east-1',
    keyId: 'arn:aws:kms:us-east-1:123456789012:key/test-key-id',
  };

  it('sets providerType to "aws-kms"', () => {
    const provider = new AWSKMSProvider(config);
    expect(provider.providerType).toBe('aws-kms');
  });

  it('throws "not initialized" when calling generateDataKey before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    await expect(provider.generateDataKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling wrapKey before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    await expect(provider.wrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling unwrapKey before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    await expect(provider.unwrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling createKey before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    await expect(provider.createKey('data-encryption')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling describeKey before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    await expect(provider.describeKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling healthCheck before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    // healthCheck catches the error and returns unhealthy status
    const status = await provider.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.providerType).toBe('aws-kms');
    expect(status.message).toMatch(/not initialized/);
  });

  it('throws "not initialized" when calling enableKeyRotation before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    await expect(provider.enableKeyRotation('test-key', 90)).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling scheduleKeyDeletion before initialize()', async () => {
    const provider = new AWSKMSProvider(config);
    await expect(provider.scheduleKeyDeletion('test-key')).rejects.toThrow('not initialized');
  });

  it('accepts optional credentials in config', () => {
    const providerWithCreds = new AWSKMSProvider({
      ...config,
      credentials: {
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret',
      },
    });
    expect(providerWithCreds.providerType).toBe('aws-kms');
  });

  it('accepts optional endpoint in config', () => {
    const providerWithEndpoint = new AWSKMSProvider({
      ...config,
      endpoint: 'https://kms.us-east-1.amazonaws.com',
    });
    expect(providerWithEndpoint.providerType).toBe('aws-kms');
  });
});

// =============================================================================
// AZURE KEY VAULT PROVIDER
// =============================================================================

describe('AzureKeyVaultProvider', () => {
  const config = {
    vaultUrl: 'https://myvault.vault.azure.net',
    keyName: 'my-encryption-key',
  };

  it('sets providerType to "azure-keyvault"', () => {
    const provider = new AzureKeyVaultProvider(config);
    expect(provider.providerType).toBe('azure-keyvault');
  });

  it('throws "not initialized" when calling generateDataKey before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.generateDataKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling wrapKey before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.wrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling unwrapKey before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.unwrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling encrypt before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.encrypt('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling decrypt before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.decrypt('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling createKey before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.createKey('data-encryption')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling describeKey before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.describeKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling healthCheck before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    const status = await provider.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.providerType).toBe('azure-keyvault');
    expect(status.message).toMatch(/not initialized/);
  });

  it('throws "not initialized" when calling enableKeyRotation before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.enableKeyRotation('test-key', 90)).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling scheduleKeyDeletion before initialize()', async () => {
    const provider = new AzureKeyVaultProvider(config);
    await expect(provider.scheduleKeyDeletion('test-key')).rejects.toThrow('not initialized');
  });

  it('accepts optional keyVersion in config', () => {
    const provider = new AzureKeyVaultProvider({
      ...config,
      keyVersion: 'abc123',
    });
    expect(provider.providerType).toBe('azure-keyvault');
  });

  it('accepts optional service principal credentials in config', () => {
    const provider = new AzureKeyVaultProvider({
      ...config,
      tenantId: 'tenant-id',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    expect(provider.providerType).toBe('azure-keyvault');
  });
});

// =============================================================================
// AZURE MANAGED HSM PROVIDER
// =============================================================================

describe('AzureManagedHSMProvider', () => {
  const config = {
    vaultUrl: 'https://myhsm.managedhsm.azure.net',
    keyName: 'my-hsm-key',
  };

  it('sets providerType to "azure-managed-hsm"', () => {
    const provider = new AzureManagedHSMProvider(config);
    expect(provider.providerType).toBe('azure-managed-hsm');
  });

  it('extends AzureKeyVaultProvider', () => {
    const provider = new AzureManagedHSMProvider(config);
    expect(provider).toBeInstanceOf(AzureKeyVaultProvider);
  });

  it('throws "not initialized" when calling generateDataKey before initialize()', async () => {
    const provider = new AzureManagedHSMProvider(config);
    await expect(provider.generateDataKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling wrapKey before initialize()', async () => {
    const provider = new AzureManagedHSMProvider(config);
    await expect(provider.wrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling unwrapKey before initialize()', async () => {
    const provider = new AzureManagedHSMProvider(config);
    await expect(provider.unwrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling createKey before initialize()', async () => {
    const provider = new AzureManagedHSMProvider(config);
    await expect(provider.createKey('data-encryption')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling describeKey before initialize()', async () => {
    const provider = new AzureManagedHSMProvider(config);
    await expect(provider.describeKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling healthCheck before initialize()', async () => {
    const provider = new AzureManagedHSMProvider(config);
    const status = await provider.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.providerType).toBe('azure-managed-hsm');
    expect(status.message).toMatch(/not initialized/);
  });
});

// =============================================================================
// GCP CLOUD KMS PROVIDER
// =============================================================================

describe('GCPCloudKMSProvider', () => {
  const config = {
    projectId: 'my-gcp-project',
    location: 'us-east1',
    keyRing: 'my-key-ring',
    keyName: 'my-crypto-key',
  };

  it('sets providerType to "gcp-cloud-kms"', () => {
    const provider = new GCPCloudKMSProvider(config);
    expect(provider.providerType).toBe('gcp-cloud-kms');
  });

  it('throws "not initialized" when calling generateDataKey before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    await expect(provider.generateDataKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling wrapKey before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    await expect(provider.wrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling unwrapKey before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    await expect(provider.unwrapKey('test-key', Buffer.from('data'))).rejects.toThrow(
      'not initialized',
    );
  });

  it('throws "not initialized" when calling createKey before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    await expect(provider.createKey('data-encryption')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling describeKey before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    await expect(provider.describeKey('test-key')).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling healthCheck before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    const status = await provider.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.providerType).toBe('gcp-cloud-kms');
    expect(status.message).toMatch(/not initialized/);
  });

  it('throws "not initialized" when calling enableKeyRotation before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    await expect(provider.enableKeyRotation('test-key', 90)).rejects.toThrow('not initialized');
  });

  it('throws "not initialized" when calling scheduleKeyDeletion before initialize()', async () => {
    const provider = new GCPCloudKMSProvider(config);
    await expect(provider.scheduleKeyDeletion('test-key')).rejects.toThrow('not initialized');
  });

  it('accepts optional keyVersion in config', () => {
    const provider = new GCPCloudKMSProvider({
      ...config,
      keyVersion: '2',
    });
    expect(provider.providerType).toBe('gcp-cloud-kms');
  });

  it('accepts optional credentialsPath in config', () => {
    const provider = new GCPCloudKMSProvider({
      ...config,
      credentialsPath: '/path/to/service-account.json',
    });
    expect(provider.providerType).toBe('gcp-cloud-kms');
  });
});
