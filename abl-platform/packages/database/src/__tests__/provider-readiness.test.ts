import { describe, it, expect } from 'vitest';
import { LocalKMSProvider } from '../kms/local-kms-provider.js';
import { verifyProviderReadiness } from '../kms/provider-readiness.js';
import type {
  GenerateDataKeyResult,
  KMSHealthStatus,
  KMSKeyMetadata,
  KMSProvider,
  KeyPurpose,
  WrapKeyResult,
} from '../kms/types.js';

const MASTER_KEY = 'a'.repeat(64);

class FailingCryptoProbeProvider implements KMSProvider {
  readonly providerType = 'test-provider';

  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}

  async healthCheck(): Promise<KMSHealthStatus> {
    return {
      healthy: true,
      providerType: this.providerType,
      latencyMs: 5,
    };
  }

  async generateDataKey(_keyId: string): Promise<GenerateDataKeyResult> {
    throw new Error('not implemented');
  }

  async wrapKey(_keyId: string, plaintext: Buffer): Promise<WrapKeyResult> {
    return { ciphertext: Buffer.from(plaintext), keyId: 'test-key' };
  }

  async unwrapKey(_keyId: string, _ciphertext: Buffer, _keyVersion?: number): Promise<Buffer> {
    return Buffer.from('wrong-key-material');
  }

  async encrypt(_keyId: string, _plaintext: Buffer): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async decrypt(_keyId: string, _ciphertext: Buffer): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async createKey(_purpose: KeyPurpose): Promise<KMSKeyMetadata> {
    throw new Error('not implemented');
  }

  async describeKey(_keyId: string): Promise<KMSKeyMetadata> {
    throw new Error('not implemented');
  }

  async enableKeyRotation(_keyId: string, _intervalDays: number): Promise<void> {}
  async scheduleKeyDeletion(_keyId: string, _pendingWindowDays?: number): Promise<void> {}
}

describe('verifyProviderReadiness', () => {
  it('passes for a healthy provider that can wrap and unwrap key material', async () => {
    const provider = new LocalKMSProvider(MASTER_KEY);
    await provider.initialize();

    try {
      const readiness = await verifyProviderReadiness(provider, 'platform-default');

      expect(readiness.healthy).toBe(true);
      expect(readiness.cryptoVerified).toBe(true);
      expect(readiness.checkedKeyId).toBe('platform-default');
    } finally {
      await provider.shutdown();
    }
  });

  it('fails when the crypto probe does not round-trip cleanly', async () => {
    const provider = new FailingCryptoProbeProvider();

    const readiness = await verifyProviderReadiness(provider, 'test-key');

    expect(readiness.healthy).toBe(false);
    expect(readiness.cryptoVerified).toBe(false);
    expect(readiness.message).toContain('round-trip');
  });
});
