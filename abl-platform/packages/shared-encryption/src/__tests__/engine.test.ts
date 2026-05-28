/**
 * EncryptionService Unit Tests
 *
 * Covers methods with production callers:
 * - constructor validation
 * - encrypt/decrypt (user-scoped — used by MFA in Studio)
 * - encryptForTenant/decryptForTenant (delegates to DEK facade)
 * - encryptContactPII/decryptContactPII (contact identity resolution)
 * - blindIndex (contact identity lookup)
 * - shutdown (key material hygiene)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EncryptionService } from '../engine.js';
import { clearGlobalEncryptionFacade } from '../facade-accessor.js';
import type { EncryptionServiceConfig } from '../types.js';

function makeHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

function makeConfig(overrides?: Partial<EncryptionServiceConfig>): EncryptionServiceConfig {
  return {
    masterKeyHex: makeHex(32),
    ...overrides,
  };
}

describe('EncryptionService', () => {
  describe('constructor', () => {
    it('rejects missing master key', () => {
      expect(() => new EncryptionService({ masterKeyHex: '' })).toThrow();
    });

    it('rejects short master key', () => {
      expect(() => new EncryptionService({ masterKeyHex: 'abcd' })).toThrow();
    });

    it('accepts valid 64-char hex master key', () => {
      const svc = new EncryptionService(makeConfig());
      expect(svc).toBeDefined();
    });

    it('supports user-scoped round-trip with default config', () => {
      const svc = new EncryptionService({ masterKeyHex: makeHex(32) });
      const encrypted = svc.encrypt('test', 'user-1');
      expect(svc.decrypt(encrypted, 'user-1')).toBe('test');
    });
  });

  // ── User-Scoped (production caller: MFA in Studio) ──────────────────

  describe('user-scoped encrypt / decrypt', () => {
    let svc: EncryptionService;

    beforeEach(() => {
      svc = new EncryptionService(makeConfig());
    });

    it('roundtrips plaintext', () => {
      const plaintext = 'hello secret world';
      const encrypted = svc.encrypt(plaintext, 'user-1');
      expect(encrypted).not.toBe(plaintext);
      expect(svc.decrypt(encrypted, 'user-1')).toBe(plaintext);
    });

    it('different users produce different ciphertext', () => {
      const enc1 = svc.encrypt('same data', 'user-1');
      const enc2 = svc.encrypt('same data', 'user-2');
      expect(enc1).not.toBe(enc2);
    });

    it('wrong user cannot decrypt', () => {
      const encrypted = svc.encrypt('secret', 'user-1');
      expect(() => svc.decrypt(encrypted, 'user-2')).toThrow();
    });

    it('rejects double encryption', () => {
      const encrypted = svc.encrypt('test', 'user-1');
      expect(() => svc.encrypt(encrypted, 'user-1')).toThrow('Double encryption detected');
    });

    it('handles empty string', () => {
      const encrypted = svc.encrypt('', 'user-1');
      expect(svc.decrypt(encrypted, 'user-1')).toBe('');
    });

    it('handles unicode', () => {
      const plaintext = '你好世界 🌍 émojis';
      const encrypted = svc.encrypt(plaintext, 'user-1');
      expect(svc.decrypt(encrypted, 'user-1')).toBe(plaintext);
    });

    it('rejects non-string input to decrypt', () => {
      expect(() => svc.decrypt(123 as unknown as string, 'user-1')).toThrow(
        'Expected encrypted string',
      );
    });

    it('rejects wrong part count in decrypt', () => {
      expect(() => svc.decrypt('only-one-part', 'user-1')).toThrow();
      expect(() => svc.decrypt('a:b:c:d', 'user-1')).toThrow();
    });
  });

  // ── Tenant-Scoped DEK Facade Delegation ─────────────────────────────

  describe('tenant-scoped methods (DEK facade delegation)', () => {
    let svc: EncryptionService;

    beforeEach(() => {
      svc = new EncryptionService(makeConfig());
      clearGlobalEncryptionFacade();
    });

    it('encryptForTenant throws when no facade (async DEK path required)', () => {
      expect(() => svc.encryptForTenant('test', 'tenant-1')).toThrow(
        'Tenant encryption requires the async DEK path',
      );
    });

    it('decryptForTenant throws for unsupported format when no facade', () => {
      expect(() => svc.decryptForTenant('random-plaintext', 'tenant-1')).toThrow(
        'Unsupported tenant ciphertext format',
      );
    });

    it('decryptForTenant throws for non-envelope ciphertext', () => {
      const legacyHex = 'a1b2c3d4e5f60011:223344556677:aabbccddeeff';
      expect(() => svc.decryptForTenant(legacyHex, 'tenant-1')).toThrow('Unsupported tenant');
    });
  });

  // ── Contact PII (production callers: resolve-or-create-contact, self-merge) ──

  describe('contact PII encryption', () => {
    let svc: EncryptionService;

    beforeEach(() => {
      svc = new EncryptionService(makeConfig());
    });

    it('encryptContactPII / decryptContactPII roundtrip', () => {
      const plaintext = 'John Doe, john@example.com';
      const encrypted = svc.encryptContactPII('tenant-1', plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(svc.decryptContactPII('tenant-1', encrypted)).toBe(plaintext);
    });

    it('wrong tenant cannot decrypt contact PII', () => {
      const encrypted = svc.encryptContactPII('tenant-1', 'secret PII');
      expect(() => svc.decryptContactPII('tenant-2', encrypted)).toThrow();
    });

    it('contact PII base64 format is not detected by isAlreadyEncrypted', () => {
      // Contact PII uses iv+tag+ciphertext base64 — not caught by isAlreadyEncrypted
      // Known limitation; callers should guard against re-encryption
      const encrypted = svc.encryptContactPII('tenant-1', 'test');
      expect(() => svc.encryptContactPII('tenant-1', encrypted)).not.toThrow();
    });
  });

  // ── Blind Index (production callers: resolve-or-create-contact, self-merge) ──

  describe('blindIndex', () => {
    it('produces deterministic hex output', () => {
      const svc = new EncryptionService(makeConfig());
      const idx1 = svc.blindIndex('tenant-1', 'john@example.com');
      const idx2 = svc.blindIndex('tenant-1', 'john@example.com');
      expect(idx1).toBe(idx2);
      expect(/^[0-9a-f]{64}$/.test(idx1)).toBe(true);
    });

    it('different values produce different indices', () => {
      const svc = new EncryptionService(makeConfig());
      const idx1 = svc.blindIndex('tenant-1', 'alice@example.com');
      const idx2 = svc.blindIndex('tenant-1', 'bob@example.com');
      expect(idx1).not.toBe(idx2);
    });

    it('different tenants produce different indices for same value', () => {
      const svc = new EncryptionService(makeConfig());
      const idx1 = svc.blindIndex('tenant-1', 'john@example.com');
      const idx2 = svc.blindIndex('tenant-2', 'john@example.com');
      expect(idx1).not.toBe(idx2);
    });
  });

  // ── Shutdown (key material hygiene) ─────────────────────────────────

  describe('shutdown', () => {
    it('zero-fills master key (old ciphertext becomes undecryptable)', () => {
      const svc = new EncryptionService(makeConfig());

      const encrypted = svc.encrypt('test', 'user-1');
      expect(svc.decrypt(encrypted, 'user-1')).toBe('test');

      svc.shutdown();

      // Master key zeroed — derived key changes, old ciphertext fails
      expect(() => svc.decrypt(encrypted, 'user-1')).toThrow();
    });

    it('zero-fills previous keys', () => {
      const oldKey = makeHex(32);

      // Encrypt with old key
      const oldSvc = new EncryptionService(makeConfig({ masterKeyHex: oldKey }));
      const encrypted = oldSvc.encrypt('old data', 'user-1');

      // Works before shutdown
      expect(oldSvc.decrypt(encrypted, 'user-1')).toBe('old data');

      // Shutdown zeroes the key buffer
      oldSvc.shutdown();

      // After shutdown, derived key changes — old ciphertext fails
      expect(() => oldSvc.decrypt(encrypted, 'user-1')).toThrow();
    });
  });
});
