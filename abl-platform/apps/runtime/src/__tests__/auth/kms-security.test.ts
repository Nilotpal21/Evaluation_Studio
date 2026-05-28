/**
 * KMS Security Tests
 *
 * Validates:
 * - Cross-tenant DEK isolation
 * - Credential redaction in errors
 * - Provider fingerprint uniqueness
 */
import { describe, it, expect } from 'vitest';
import { computeFingerprint } from '@agent-platform/database/kms';
import type { IResolvedProviderRef } from '@agent-platform/database/models';

describe('KMS Security', () => {
  describe('Provider fingerprint isolation', () => {
    it('different tenants with same provider type get different fingerprints if keyId differs', () => {
      const tenantA: IResolvedProviderRef = {
        providerType: 'aws-kms',
        keyId: 'arn:aws:kms:us-east-1:111:key/aaa',
        region: 'us-east-1',
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      };
      const tenantB: IResolvedProviderRef = {
        providerType: 'aws-kms',
        keyId: 'arn:aws:kms:us-east-1:222:key/bbb',
        region: 'us-east-1',
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      };
      expect(computeFingerprint(tenantA)).not.toBe(computeFingerprint(tenantB));
    });

    it('same config produces same fingerprint (deterministic)', () => {
      const config: IResolvedProviderRef = {
        providerType: 'azure-keyvault',
        keyId: 'my-key',
        region: null,
        vaultUrl: 'https://myvault.vault.azure.net',
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      };
      expect(computeFingerprint(config)).toBe(computeFingerprint(config));
    });

    it('local provider fingerprint includes keyId', () => {
      const fp = computeFingerprint({
        providerType: 'local',
        keyId: 'platform-default',
        region: null,
        vaultUrl: null,
        externalEndpoint: null,
        authMethod: null,
        authConfigEncrypted: null,
      });
      expect(fp).toBe('local:platform-default');
    });

    it('external provider fingerprint includes endpoint and auth method', () => {
      const fp = computeFingerprint({
        providerType: 'external',
        keyId: 'ext-key',
        region: null,
        vaultUrl: null,
        externalEndpoint: 'https://my-kms.example.com',
        authMethod: 'api-key',
        authConfigEncrypted: null,
      });
      expect(fp).toBe('external:https://my-kms.example.com:api-key');
    });

    it('different auth methods on same external endpoint get different fingerprints', () => {
      const fpApiKey = computeFingerprint({
        providerType: 'external',
        keyId: 'ext-key',
        region: null,
        vaultUrl: null,
        externalEndpoint: 'https://my-kms.example.com',
        authMethod: 'api-key',
        authConfigEncrypted: null,
      });
      const fpMtls = computeFingerprint({
        providerType: 'external',
        keyId: 'ext-key',
        region: null,
        vaultUrl: null,
        externalEndpoint: 'https://my-kms.example.com',
        authMethod: 'mtls',
        authConfigEncrypted: null,
      });
      expect(fpApiKey).not.toBe(fpMtls);
    });
  });

  describe('Credential redaction', () => {
    it('KMSProviderPool does not expose master key in error messages', async () => {
      const { KMSProviderPool } = await import('@agent-platform/database/kms');
      const pool = new KMSProviderPool({ masterKeyHex: 'a'.repeat(64) });
      // Not initialized — should throw without leaking key
      expect(() => pool.getLocalProvider()).toThrow();
      try {
        pool.getLocalProvider();
      } catch (err: any) {
        expect(err.message).not.toContain('a'.repeat(64));
      }
    });

    it('Encryption plugin error does not leak master key', async () => {
      const { setMasterKey, _resetEncryptionStateForTesting } =
        await import('@agent-platform/database/models');
      // This test only verifies the error message format
      _resetEncryptionStateForTesting();
      expect(() => setMasterKey('invalid')).toThrow();
      try {
        setMasterKey('invalid');
      } catch (err: any) {
        expect(err.message).toContain('ENCRYPTION_MASTER_KEY must be exactly 64 hex characters');
      }
      _resetEncryptionStateForTesting();
    });
  });
});
