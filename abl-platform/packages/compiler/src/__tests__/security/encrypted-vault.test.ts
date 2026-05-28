/**
 * Encrypted Vault Tests
 *
 * Tests for PIIVault serialization/deserialization and encrypted vault operations.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { PIIVault } from '../../platform/security/pii-vault.js';
import {
  encryptVault,
  decryptVault,
  type VaultEncryptionService,
} from '../../platform/security/encrypted-vault.js';

const mockEncryption: VaultEncryptionService = {
  encryptForTenant: async (plaintext, tenantId) =>
    Buffer.from(`${tenantId}:${plaintext}`).toString('base64'),
  decryptForTenant: async (encrypted, tenantId) => {
    const decoded = Buffer.from(encrypted, 'base64').toString();
    const prefix = `${tenantId}:`;
    if (!decoded.startsWith(prefix)) throw new Error('Wrong tenant');
    return decoded.slice(prefix.length);
  },
};

describe('PIIVault serialization', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  test('serialize() produces valid JSON with all tokens', () => {
    vault.tokenize('Call me at 555-123-4567 or email user@test.com');
    const json = vault.serialize();
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0][1]).toHaveProperty('type');
    expect(parsed[0][1]).toHaveProperty('original');
    expect(parsed[0][1]).toHaveProperty('token');
    expect(parsed[0][1]).toHaveProperty('id');
  });

  test('deserialize() restores vault with all tokens functional', () => {
    const result = vault.tokenize('Email me at user@example.com');
    const json = vault.serialize();
    const restored = PIIVault.deserialize(json);
    expect(restored.detokenize(result.text)).toBe('Email me at user@example.com');
  });

  test('round-trip: tokenize → serialize → deserialize → detokenize recovers originals', () => {
    const input = 'SSN 123-45-6789 phone 555-867-5309 email a@b.com';
    const result = vault.tokenize(input);
    const json = vault.serialize();
    const restored = PIIVault.deserialize(json);
    expect(restored.detokenize(result.text)).toBe(input);
  });

  test('round-trip: tokenize → serialize → deserialize → renderForConsumer works for all 4 consumers', () => {
    const result = vault.tokenize('Call 555-123-4567');
    const json = vault.serialize();
    const restored = PIIVault.deserialize(json);

    // LLM sees the token unchanged
    expect(restored.renderForConsumer(result.text, 'llm')).toBe(result.text);
    // Tools sees redacted values by default
    expect(restored.renderForConsumer(result.text, 'tools')).toContain('[REDACTED_PHONE]');
    // User sees masked
    expect(restored.renderForConsumer(result.text, 'user')).toContain('***');
    // Logs sees redacted label
    expect(restored.renderForConsumer(result.text, 'logs')).toContain('[REDACTED_PHONE]');
  });

  test('deserialize() creates a fresh vault (no leftover data)', () => {
    vault.tokenize('Email me at user@example.com');
    const json = vault.serialize();
    const restored = PIIVault.deserialize(json);
    // The restored vault should have exactly the tokens from the JSON, nothing more
    expect(restored.getTokenCount()).toBe(1);
  });

  test('serialize() on empty vault returns empty array JSON', () => {
    expect(vault.serialize()).toBe('[]');
  });

  test('isEmpty() returns true for new vault', () => {
    expect(vault.isEmpty()).toBe(true);
  });

  test('isEmpty() returns false after tokenize', () => {
    vault.tokenize('Email me at user@example.com');
    expect(vault.isEmpty()).toBe(false);
  });
});

describe('encryptVault / decryptVault', () => {
  const tenantId = 'tenant-abc';
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  test('encryptVault returns null for empty vault', async () => {
    await expect(encryptVault(vault, tenantId, mockEncryption)).resolves.toBeNull();
  });

  test('encryptVault returns encrypted string for non-empty vault', async () => {
    vault.tokenize('Email me at user@example.com');
    const encrypted = await encryptVault(vault, tenantId, mockEncryption);
    expect(encrypted).toBeTypeOf('string');
    expect(encrypted!.length).toBeGreaterThan(0);
    // Should be base64 — not readable JSON
    expect(() => JSON.parse(encrypted!)).toThrow();
  });

  test('decryptVault restores functional vault', async () => {
    const result = vault.tokenize('Email me at user@example.com');
    const encrypted = (await encryptVault(vault, tenantId, mockEncryption))!;
    const restored = await decryptVault(encrypted, tenantId, mockEncryption);
    expect(restored).not.toBeNull();
    expect(restored!.detokenize(result.text)).toBe('Email me at user@example.com');
  });

  test('full round-trip: tokenize → encryptVault → decryptVault → detokenize', async () => {
    const input = 'SSN 123-45-6789 and card 4111-1111-1111-1111';
    const result = vault.tokenize(input);
    const encrypted = (await encryptVault(vault, tenantId, mockEncryption))!;
    const restored = (await decryptVault(encrypted, tenantId, mockEncryption))!;
    expect(restored.detokenize(result.text)).toBe(input);
  });

  test('encryptVault handles encryption failure gracefully (returns null)', async () => {
    vault.tokenize('Email me at user@example.com');
    const failingService: VaultEncryptionService = {
      encryptForTenant: async () => {
        throw new Error('HSM unavailable');
      },
      decryptForTenant: async () => {
        throw new Error('HSM unavailable');
      },
    };
    await expect(encryptVault(vault, tenantId, failingService)).resolves.toBeNull();
  });

  test('decryptVault handles decryption failure gracefully (returns null)', async () => {
    const failingService: VaultEncryptionService = {
      encryptForTenant: mockEncryption.encryptForTenant,
      decryptForTenant: async () => {
        throw new Error('Key rotated');
      },
    };
    vault.tokenize('Email me at user@example.com');
    const encrypted = (await encryptVault(vault, tenantId, mockEncryption))!;
    await expect(decryptVault(encrypted, tenantId, failingService)).resolves.toBeNull();
  });

  test('decryptVault handles corrupted JSON gracefully (returns null)', async () => {
    const corruptService: VaultEncryptionService = {
      encryptForTenant: mockEncryption.encryptForTenant,
      decryptForTenant: async () => '{not valid json[[[',
    };
    vault.tokenize('Email me at user@example.com');
    const encrypted = (await encryptVault(vault, tenantId, mockEncryption))!;
    await expect(decryptVault(encrypted, tenantId, corruptService)).resolves.toBeNull();
  });

  test('vault max size preserved across serialize/deserialize', async () => {
    // Add several tokens and verify count is preserved
    vault.tokenize('Email a@b.com and phone 555-111-2222 and SSN 123-45-6789');
    const count = vault.getTokenCount();
    const encrypted = (await encryptVault(vault, tenantId, mockEncryption))!;
    const restored = (await decryptVault(encrypted, tenantId, mockEncryption))!;
    expect(restored.getTokenCount()).toBe(count);
  });

  test('decryptVault with wrong tenant returns null', async () => {
    vault.tokenize('Email me at user@example.com');
    const encrypted = (await encryptVault(vault, tenantId, mockEncryption))!;
    await expect(decryptVault(encrypted, 'wrong-tenant', mockEncryption)).resolves.toBeNull();
  });
});
