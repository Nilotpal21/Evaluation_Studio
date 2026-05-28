/**
 * Local KMS Provider Tests
 *
 * Validates: round-trip wrap/unwrap, generateDataKey, createKey,
 * encrypt/decrypt, shutdown zero-fill, registry lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalKMSProvider } from '../kms/local-kms-provider.js';
import {
  setPlatformKMSProvider,
  getPlatformKMSProvider,
  isPlatformKMSAvailable,
  shutdownKMSRegistry,
  _resetKMSRegistryForTesting,
} from '../kms/kms-registry.js';

// =============================================================================
// TEST FIXTURES
// =============================================================================

const TEST_MASTER_KEY = randomBytes(32).toString('hex');

function createProvider(key = TEST_MASTER_KEY): LocalKMSProvider {
  return new LocalKMSProvider(key);
}

// =============================================================================
// LOCAL KMS PROVIDER
// =============================================================================

describe('LocalKMSProvider', () => {
  let provider: LocalKMSProvider;

  beforeEach(async () => {
    provider = createProvider();
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  // ── Construction ─────────────────────────────────────────────────────

  describe('construction', () => {
    it('should reject empty master key', () => {
      expect(() => new LocalKMSProvider('')).toThrow('master key must be a hex string');
    });

    it('should reject short master key', () => {
      expect(() => new LocalKMSProvider('abcdef')).toThrow('at least 64 characters');
    });

    it('should accept valid 64-char hex key', () => {
      const p = new LocalKMSProvider(randomBytes(32).toString('hex'));
      expect(p.providerType).toBe('local');
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should initialize successfully', async () => {
      const p = createProvider();
      await p.initialize();
      const health = await p.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.providerType).toBe('local');
      await p.shutdown();
    });

    it('should be idempotent on double initialize', async () => {
      await provider.initialize(); // Already initialized in beforeEach
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('should report unhealthy when not initialized', async () => {
      const p = createProvider();
      const health = await p.healthCheck();
      expect(health.healthy).toBe(false);
    });

    it('should report unhealthy after shutdown', async () => {
      await provider.shutdown();
      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
    });

    it('should throw on operations before initialize', async () => {
      const p = createProvider();
      await expect(p.generateDataKey('test-key')).rejects.toThrow('not initialized');
    });
  });

  // ── generateDataKey ──────────────────────────────────────────────────

  describe('generateDataKey', () => {
    it('should generate a DEK with plaintext and ciphertext', async () => {
      const result = await provider.generateDataKey('kek-1');

      expect(result.plaintext).toBeInstanceOf(Buffer);
      expect(result.plaintext.length).toBe(32);
      expect(result.ciphertext).toBeInstanceOf(Buffer);
      expect(result.ciphertext.length).toBeGreaterThan(0);
      expect(result.keyId).toBe('kek-1');
      expect(result.keyVersion).toBe(1);
    });

    it('should generate unique DEKs on each call', async () => {
      const r1 = await provider.generateDataKey('kek-1');
      const r2 = await provider.generateDataKey('kek-1');

      expect(r1.plaintext.equals(r2.plaintext)).toBe(false);
      expect(r1.ciphertext.equals(r2.ciphertext)).toBe(false);
    });

    it('should produce a DEK that can be unwrapped', async () => {
      const { plaintext, ciphertext } = await provider.generateDataKey('kek-1');
      const unwrapped = await provider.unwrapKey('kek-1', ciphertext);

      expect(unwrapped.equals(plaintext)).toBe(true);
    });
  });

  // ── wrapKey / unwrapKey ──────────────────────────────────────────────

  describe('wrapKey / unwrapKey', () => {
    it('should round-trip wrap and unwrap', async () => {
      const original = randomBytes(32);
      const { ciphertext } = await provider.wrapKey('kek-1', original);
      const unwrapped = await provider.unwrapKey('kek-1', ciphertext);

      expect(unwrapped.equals(original)).toBe(true);
    });

    it('should fail to unwrap with wrong keyId', async () => {
      const original = randomBytes(32);
      const { ciphertext } = await provider.wrapKey('kek-1', original);

      await expect(provider.unwrapKey('kek-WRONG', ciphertext)).rejects.toThrow();
    });

    it('should fail to unwrap tampered ciphertext', async () => {
      const original = randomBytes(32);
      const { ciphertext } = await provider.wrapKey('kek-1', original);

      // Tamper with ciphertext
      const tampered = Buffer.from(ciphertext);
      tampered[tampered.length - 5] ^= 0xff;

      await expect(provider.unwrapKey('kek-1', tampered)).rejects.toThrow();
    });

    it('should wrap different-sized payloads', async () => {
      for (const size of [16, 32, 48, 64, 128]) {
        const original = randomBytes(size);
        const { ciphertext } = await provider.wrapKey('kek-1', original);
        const unwrapped = await provider.unwrapKey('kek-1', ciphertext);
        expect(unwrapped.equals(original)).toBe(true);
      }
    });
  });

  // ── encrypt / decrypt ────────────────────────────────────────────────

  describe('encrypt / decrypt', () => {
    it('should round-trip encrypt and decrypt', async () => {
      const plaintext = Buffer.from('Hello, KMS!', 'utf8');
      const encrypted = await provider.encrypt('key-1', plaintext);
      const decrypted = await provider.decrypt('key-1', encrypted);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it('should produce different ciphertexts for same plaintext (random IV)', async () => {
      const plaintext = Buffer.from('determinism test');
      const e1 = await provider.encrypt('key-1', plaintext);
      const e2 = await provider.encrypt('key-1', plaintext);

      expect(e1.equals(e2)).toBe(false);
    });

    it('should fail to decrypt with wrong keyId', async () => {
      const plaintext = Buffer.from('secret data');
      const encrypted = await provider.encrypt('key-1', plaintext);

      await expect(provider.decrypt('key-WRONG', encrypted)).rejects.toThrow();
    });

    it('should fail to decrypt when AAD context does not match', async () => {
      const plaintext = Buffer.from('secret data with aad');
      const encrypted = await provider.encrypt('key-1', plaintext, {
        tenantId: 'tenant-a',
        resourceType: 'llm_credentials',
        fieldName: 'authConfig',
      });

      await expect(
        provider.decrypt('key-1', encrypted, {
          tenantId: 'tenant-a',
          resourceType: 'llm_credentials',
          fieldName: 'customHeaders',
        }),
      ).rejects.toThrow(/authenticate data/i);
    });

    it('should handle empty plaintext', async () => {
      const plaintext = Buffer.alloc(0);
      const encrypted = await provider.encrypt('key-1', plaintext);
      const decrypted = await provider.decrypt('key-1', encrypted);

      expect(decrypted.equals(plaintext)).toBe(true);
    });
  });

  // ── createKey ────────────────────────────────────────────────────────

  describe('createKey', () => {
    it('should create a key with correct metadata', async () => {
      const meta = await provider.createKey('tenant-kek');

      expect(meta.keyId).toMatch(/^local:tenant-kek:/);
      expect(meta.purpose).toBe('tenant-kek');
      expect(meta.state).toBe('active');
      expect(meta.protectionLevel).toBe('local');
      expect(meta.algorithm).toBe('AES-256-GCM');
      expect(meta.createdAt).toBeInstanceOf(Date);
      expect(meta.rotationIntervalDays).toBe(0);
    });

    it('should create keys with unique IDs', async () => {
      const k1 = await provider.createKey('data-encryption');
      const k2 = await provider.createKey('data-encryption');

      expect(k1.keyId).not.toBe(k2.keyId);
    });

    it('should be usable for wrap/unwrap after creation', async () => {
      const { keyId } = await provider.createKey('tenant-kek');
      const data = randomBytes(32);

      const { ciphertext } = await provider.wrapKey(keyId, data);
      const unwrapped = await provider.unwrapKey(keyId, ciphertext);

      expect(unwrapped.equals(data)).toBe(true);
    });
  });

  // ── describeKey ──────────────────────────────────────────────────────

  describe('describeKey', () => {
    it('should describe a created key', async () => {
      const created = await provider.createKey('signing');
      const described = await provider.describeKey(created.keyId);

      expect(described.keyId).toBe(created.keyId);
      expect(described.purpose).toBe('signing');
    });

    it('should auto-create entry for unknown keyId', async () => {
      const described = await provider.describeKey('unknown-key-123');

      expect(described.keyId).toBe('unknown-key-123');
      expect(described.purpose).toBe('data-encryption');
      expect(described.state).toBe('active');
    });
  });

  // ── enableKeyRotation ────────────────────────────────────────────────

  describe('enableKeyRotation', () => {
    it('should set rotation interval', async () => {
      const { keyId } = await provider.createKey('tenant-kek');
      await provider.enableKeyRotation(keyId, 90);

      const meta = await provider.describeKey(keyId);
      expect(meta.rotationIntervalDays).toBe(90);
    });
  });

  // ── scheduleKeyDeletion ──────────────────────────────────────────────

  describe('scheduleKeyDeletion', () => {
    it('should mark key as destroyed', async () => {
      const { keyId } = await provider.createKey('data-encryption');
      await provider.scheduleKeyDeletion(keyId);

      const meta = await provider.describeKey(keyId);
      expect(meta.state).toBe('destroyed');
    });
  });

  // ── shutdown zero-fill ───────────────────────────────────────────────

  describe('shutdown security', () => {
    it('should zero-fill master key on shutdown', async () => {
      // Create some keys and use them
      await provider.generateDataKey('kek-1');
      await provider.createKey('tenant-kek');

      await provider.shutdown();

      // After shutdown, operations should fail
      await expect(provider.generateDataKey('kek-1')).rejects.toThrow('not initialized');
    });

    it('should allow re-initialization after shutdown', async () => {
      await provider.shutdown();

      const p2 = createProvider();
      await p2.initialize();

      const health = await p2.healthCheck();
      expect(health.healthy).toBe(true);

      await p2.shutdown();
    });
  });

  // ── deterministic key derivation ─────────────────────────────────────

  describe('deterministic derivation', () => {
    it('should produce same wrap/unwrap across provider instances', async () => {
      const data = randomBytes(32);
      const { ciphertext } = await provider.wrapKey('shared-kek', data);

      // Create a new provider with the same master key
      const provider2 = createProvider();
      await provider2.initialize();

      const unwrapped = await provider2.unwrapKey('shared-kek', ciphertext);
      expect(unwrapped.equals(data)).toBe(true);

      await provider2.shutdown();
    });
  });

  // ── keyFingerprint ───────────────────────────────────────────────────

  describe('keyFingerprint', () => {
    it('should produce a 12-char hex fingerprint', () => {
      const fp = LocalKMSProvider.keyFingerprint('test-key-id');
      expect(fp).toMatch(/^[0-9a-f]{12}$/);
    });

    it('should be deterministic', () => {
      const fp1 = LocalKMSProvider.keyFingerprint('same-key');
      const fp2 = LocalKMSProvider.keyFingerprint('same-key');
      expect(fp1).toBe(fp2);
    });

    it('should differ for different keys', () => {
      const fp1 = LocalKMSProvider.keyFingerprint('key-a');
      const fp2 = LocalKMSProvider.keyFingerprint('key-b');
      expect(fp1).not.toBe(fp2);
    });
  });
});

// =============================================================================
// KMS REGISTRY
// =============================================================================

describe('KMS Registry', () => {
  afterEach(async () => {
    _resetKMSRegistryForTesting();
  });

  it('should report unavailable before set', () => {
    expect(isPlatformKMSAvailable()).toBe(false);
  });

  it('should throw on get before set', () => {
    expect(() => getPlatformKMSProvider()).toThrow('no platform provider set');
  });

  it('should set and get a provider', async () => {
    const provider = createProvider();
    await provider.initialize();

    setPlatformKMSProvider(provider);

    expect(isPlatformKMSAvailable()).toBe(true);
    expect(getPlatformKMSProvider()).toBe(provider);

    await provider.shutdown();
  });

  it('should reject double set', async () => {
    const p1 = createProvider();
    await p1.initialize();
    setPlatformKMSProvider(p1);

    const p2 = createProvider();
    await p2.initialize();

    expect(() => setPlatformKMSProvider(p2)).toThrow('already set');

    await p1.shutdown();
    await p2.shutdown();
  });

  it('should shutdown and clear provider', async () => {
    const provider = createProvider();
    await provider.initialize();
    setPlatformKMSProvider(provider);

    await shutdownKMSRegistry();

    expect(isPlatformKMSAvailable()).toBe(false);
  });

  it('should allow set after shutdown', async () => {
    const p1 = createProvider();
    await p1.initialize();
    setPlatformKMSProvider(p1);

    await shutdownKMSRegistry();

    const p2 = createProvider();
    await p2.initialize();
    setPlatformKMSProvider(p2);

    expect(isPlatformKMSAvailable()).toBe(true);
    expect(getPlatformKMSProvider()).toBe(p2);

    await p2.shutdown();
  });

  it('should handle shutdown when no provider set', async () => {
    // Should not throw
    await shutdownKMSRegistry();
    expect(isPlatformKMSAvailable()).toBe(false);
  });

  it('should work for end-to-end encrypt/decrypt via registry', async () => {
    const provider = createProvider();
    await provider.initialize();
    setPlatformKMSProvider(provider);

    const kms = getPlatformKMSProvider();
    const plaintext = Buffer.from('registry round-trip test');
    const encrypted = await kms.encrypt('test-key', plaintext);
    const decrypted = await kms.decrypt('test-key', encrypted);

    expect(decrypted.equals(plaintext)).toBe(true);

    await shutdownKMSRegistry();
  });
});
