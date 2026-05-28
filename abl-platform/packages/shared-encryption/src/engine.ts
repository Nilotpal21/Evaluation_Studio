import crypto from 'node:crypto';
import {
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  KEY_LENGTH,
  MASTER_KEY_HEX_LENGTH,
  HKDF_HASH,
  USER_KEY_DERIVATION_DIGEST,
  USER_KEY_DERIVATION_ITERATIONS,
} from './constants.js';
import { masterKeyMissing, invalidFormat, legacyCiphertextFormat } from './errors.js';
import { isAlreadyEncrypted } from './encryption-registry.js';
import { isDEKEnvelopeFormat } from './envelope-format.js';
import type { EncryptionServiceConfig } from './types.js';

import { getEncryptionFacade } from './facade-accessor.js';
/** Bounded TTL cache for derived keys — avoids repeated hkdfSync/pbkdf2Sync calls */
class DerivedKeyCache {
  private readonly cache = new Map<string, { key: Buffer; expiresAt: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 500, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(id: string): Buffer | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(id);
      return null;
    }
    return entry.key;
  }

  set(id: string, key: Buffer): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first inserted)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(id, { key, expiresAt: Date.now() + this.ttlMs });
  }

  /** Zero-fill all cached keys on shutdown */
  clear(): void {
    for (const entry of this.cache.values()) {
      entry.key.fill(0);
    }
    this.cache.clear();
  }
}

export class EncryptionService {
  private readonly masterKey: Buffer;
  private readonly previousKeys: Array<{ version: number; masterKey: Buffer }>;
  private readonly contactKeyCache = new DerivedKeyCache();
  private readonly blindIndexKeyCache = new DerivedKeyCache();
  private readonly userKeyCache = new DerivedKeyCache();

  constructor(config: EncryptionServiceConfig) {
    const hex = config.masterKeyHex;
    if (!hex || hex.length < MASTER_KEY_HEX_LENGTH) {
      throw masterKeyMissing();
    }
    this.masterKey = Buffer.from(hex, 'hex');
    this.previousKeys = (config.previous ?? []).map((p) => ({
      version: p.version,
      masterKey: Buffer.from(p.masterKeyHex, 'hex'),
    }));
  }

  // ── User-Scoped ──────────────────────────────────────────────────────

  encrypt(plaintext: string, userId: string): string {
    if (isAlreadyEncrypted(plaintext)) {
      throw new Error('Double encryption detected: value is already in encrypted format');
    }
    const key = this.deriveUserKey(userId);
    return this.encryptToHex3Part(plaintext, key);
  }

  decrypt(encryptedData: string, userId: string): string {
    const key = this.deriveUserKey(userId);
    return this.decryptFromHex3Part(encryptedData, key);
  }

  // ── Tenant-Scoped ────────────────────────────────────────────────────

  encryptForTenant(
    plaintext: string,
    tenantId: string,
    projectId = '_tenant',
    environment = '_shared',
  ): string {
    if (isAlreadyEncrypted(plaintext)) {
      throw new Error('Double encryption detected: value is already in encrypted format');
    }

    // Try DEK sync path (cache hit) — zero async overhead
    const facade = getEncryptionFacade();
    if (facade) {
      const dekResult = facade.encryptSync(plaintext, { tenantId, projectId, environment });
      if (dekResult !== null) return dekResult;
    }

    throw new Error(
      'Tenant encryption requires the async DEK path. Use encryptForTenantAuto() instead of encryptForTenant().',
    );
  }

  decryptForTenant(encryptedData: string, tenantId: string): string {
    // Try DEK sync path (cache hit) — zero async overhead
    // tenantId enforces cross-tenant isolation on cache lookup
    const facade = getEncryptionFacade();
    if (facade) {
      const dekResult = facade.decryptSync(encryptedData, tenantId);
      if (dekResult !== null) return dekResult;
    }

    if (isDEKEnvelopeFormat(encryptedData)) {
      throw new Error(
        'DEK envelope data requires async decryption (cache cold). ' +
          'Use decryptForTenantAuto() instead of decryptForTenant().',
      );
    }

    throw legacyCiphertextFormat();
  }

  // ── Contact-Scoped (HKDF — derived directly from the master key) ──

  encryptContactPII(tenantId: string, plaintext: string): string {
    if (isAlreadyEncrypted(plaintext)) {
      throw new Error('Double encryption detected: value is already in encrypted format');
    }
    const key = this.deriveContactEncryptionKey(tenantId);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decryptContactPII(tenantId: string, ciphertext: string): string {
    const key = this.deriveContactEncryptionKey(tenantId);
    const buf = Buffer.from(ciphertext, 'base64');
    // Detect IV length for backward compat: legacy used 16-byte IVs, current uses 12-byte.
    // Binary format: iv + tag(16) + encrypted. Total = ivLen + 16 + encLen.
    // Try current IV_LENGTH first; if that fails, try legacy 16-byte IV.
    const LEGACY_IV_LENGTH = 16;
    try {
      const iv = buf.subarray(0, IV_LENGTH);
      const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(encrypted) + decipher.final('utf8');
    } catch {
      // Fallback: try legacy 16-byte IV
      const iv = buf.subarray(0, LEGACY_IV_LENGTH);
      const tag = buf.subarray(LEGACY_IV_LENGTH, LEGACY_IV_LENGTH + AUTH_TAG_LENGTH);
      const encrypted = buf.subarray(LEGACY_IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(encrypted) + decipher.final('utf8');
    }
  }

  blindIndex(tenantId: string, value: string): string {
    const key = this.deriveBlindIndexKey(tenantId);
    return crypto.createHmac('sha256', key).update(value).digest('hex');
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private deriveContactEncryptionKey(tenantId: string): Buffer {
    const cacheKey = `contact:${tenantId}`;
    const cached = this.contactKeyCache.get(cacheKey);
    if (cached) return cached;

    const key = Buffer.from(
      crypto.hkdfSync(
        HKDF_HASH,
        this.masterKey,
        `tenant:${tenantId}`,
        'encryption-key',
        KEY_LENGTH,
      ),
    );
    this.contactKeyCache.set(cacheKey, key);
    return key;
  }

  private deriveUserKey(userId: string): Buffer {
    const cached = this.userKeyCache.get(userId);
    if (cached) return cached;

    const key = crypto.pbkdf2Sync(
      this.masterKey,
      userId,
      USER_KEY_DERIVATION_ITERATIONS,
      KEY_LENGTH,
      USER_KEY_DERIVATION_DIGEST,
    );
    this.userKeyCache.set(userId, key);
    return key;
  }

  private deriveBlindIndexKey(tenantId: string): Buffer {
    const cacheKey = `blind:${tenantId}`;
    const cached = this.blindIndexKeyCache.get(cacheKey);
    if (cached) return cached;

    const key = Buffer.from(
      crypto.hkdfSync(
        HKDF_HASH,
        this.masterKey,
        `blind:${tenantId}`,
        'blind-index-key',
        KEY_LENGTH,
      ),
    );
    this.blindIndexKeyCache.set(cacheKey, key);
    return key;
  }

  private encryptToHex3Part(plaintext: string, key: Buffer): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  private decryptFromHex3Part(encryptedData: string, key: Buffer): string {
    if (typeof encryptedData !== 'string') {
      throw invalidFormat(`Expected encrypted string, got ${typeof encryptedData}`);
    }
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw invalidFormat();
    }

    const [ivHex, authTagHex, ciphertext] = parts;
    // Accept both 12-byte (current) and 16-byte (legacy) IVs for backward compat
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Zero-fill key material on graceful shutdown.
   */
  shutdown(): void {
    this.masterKey.fill(0);
    for (const prev of this.previousKeys) {
      prev.masterKey.fill(0);
    }
    this.contactKeyCache.clear();
    this.blindIndexKeyCache.clear();
    this.userKeyCache.clear();
  }
}
