import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { EncryptionService } from '../../encryption/engine.js';

const TEST_KEY = crypto.randomBytes(32).toString('hex');

describe('EncryptionService — contact PII encrypt/decrypt', () => {
  let engine: EncryptionService;

  beforeEach(() => {
    engine = new EncryptionService({ masterKeyHex: TEST_KEY });
  });

  it('encrypts and decrypts PII for a tenant', () => {
    const plaintext = 'user@example.com';
    const encrypted = engine.encryptContactPII('tenant-1', plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(engine.decryptContactPII('tenant-1', encrypted)).toBe(plaintext);
  });

  it('fails with wrong tenant', () => {
    const encrypted = engine.encryptContactPII('tenant-1', 'data');
    expect(() => engine.decryptContactPII('tenant-2', encrypted)).toThrow();
  });

  it('produces different ciphertext each time (random IV)', () => {
    const e1 = engine.encryptContactPII('tenant-1', 'same');
    const e2 = engine.encryptContactPII('tenant-1', 'same');
    expect(e1).not.toBe(e2);
  });
});

describe('EncryptionService — blind indexing', () => {
  let engine: EncryptionService;

  beforeEach(() => {
    engine = new EncryptionService({ masterKeyHex: TEST_KEY });
  });

  it('produces deterministic hex index', () => {
    const idx1 = engine.blindIndex('tenant-1', 'user@example.com');
    const idx2 = engine.blindIndex('tenant-1', 'user@example.com');
    expect(idx1).toBe(idx2);
    expect(/^[0-9a-f]{64}$/.test(idx1)).toBe(true);
  });

  it('different values produce different indexes', () => {
    const idx1 = engine.blindIndex('tenant-1', 'a@b.com');
    const idx2 = engine.blindIndex('tenant-1', 'c@d.com');
    expect(idx1).not.toBe(idx2);
  });

  it('different tenants produce different indexes for same value', () => {
    const idx1 = engine.blindIndex('tenant-1', 'user@example.com');
    const idx2 = engine.blindIndex('tenant-2', 'user@example.com');
    expect(idx1).not.toBe(idx2);
  });
});

describe('EncryptionService — backward compat with ContactEncryptor', () => {
  it('decrypts data encrypted by old ContactEncryptor', () => {
    const masterKey = Buffer.from(TEST_KEY, 'hex');
    const tenantId = 'tenant-1';
    const plaintext = 'old-contact-data';

    const key = Buffer.from(
      crypto.hkdfSync('sha256', masterKey, `tenant:${tenantId}`, 'encryption-key', 32),
    );
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const oldFormat = Buffer.concat([iv, tag, encrypted]).toString('base64');

    const engine = new EncryptionService({ masterKeyHex: TEST_KEY });
    expect(engine.decryptContactPII(tenantId, oldFormat)).toBe(plaintext);
  });

  it('produces same blind index as old ContactEncryptor', () => {
    const masterKey = Buffer.from(TEST_KEY, 'hex');
    const tenantId = 'tenant-1';
    const value = 'test@example.com';

    const blindKey = Buffer.from(
      crypto.hkdfSync('sha256', masterKey, `blind:${tenantId}`, 'blind-index-key', 32),
    );
    const expected = crypto.createHmac('sha256', blindKey).update(value).digest('hex');

    const engine = new EncryptionService({ masterKeyHex: TEST_KEY });
    expect(engine.blindIndex(tenantId, value)).toBe(expected);
  });
});
