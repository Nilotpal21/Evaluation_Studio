/**
 * Local KMS Provider
 *
 * In-process AES-256-GCM provider that wraps the current master key behavior.
 * Used for development, testing, and as the default when no cloud KMS is configured.
 *
 * Key hierarchy:
 *   Master Key (from ENCRYPTION_MASTER_KEY env var)
 *     └── Derived KEK (deterministic per keyId)
 *           └── DEK (AES-256-GCM wrapped)
 *
 * NOT suitable for production use with compliance requirements (PCI DSS, FIPS).
 * Use cloud KMS providers for production deployments.
 */

import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  KMSAADContext,
  KMSProvider,
  GenerateDataKeyResult,
  WrapKeyResult,
  KMSKeyMetadata,
  KMSHealthStatus,
  KeyPurpose,
  KeyState,
} from './types.js';
import { buildKMSAADBuffer as buildAADBuffer } from './types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const KEY_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';
const pbkdf2Async = promisify(pbkdf2);

// =============================================================================
// LOCAL KMS PROVIDER
// =============================================================================

export class LocalKMSProvider implements KMSProvider {
  readonly providerType = 'local' as const;

  private masterKey: Buffer | null = null;
  private keys = new Map<string, LocalKeyEntry>();
  private derivedKeyCache = new Map<string, Buffer>();
  private initialized = false;

  constructor(private readonly masterKeyHex: string) {
    if (!masterKeyHex || masterKeyHex.length < 64) {
      throw new Error(
        'LocalKMSProvider: master key must be a hex string of at least 64 characters (32 bytes)',
      );
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.masterKey = Buffer.from(this.masterKeyHex, 'hex');
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    // Zero-fill all key material
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    for (const entry of this.keys.values()) {
      entry.derivedKey.fill(0);
    }
    this.keys.clear();
    for (const buf of this.derivedKeyCache.values()) {
      buf.fill(0);
    }
    this.derivedKeyCache.clear();
    this.initialized = false;
  }

  async healthCheck(): Promise<KMSHealthStatus> {
    const start = Date.now();
    const healthy = this.initialized && this.masterKey !== null;
    return {
      healthy,
      providerType: this.providerType,
      latencyMs: Date.now() - start,
      message: healthy ? 'Local KMS provider is healthy' : 'Not initialized',
    };
  }

  // ── Data Key Operations ────────────────────────────────────────────────

  async generateDataKey(keyId: string): Promise<GenerateDataKeyResult> {
    this.assertInitialized();

    const dekPlaintext = randomBytes(KEY_LENGTH);
    const kek = await this.deriveKey(keyId);

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, kek, iv);
    const encrypted = Buffer.concat([cipher.update(dekPlaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Wire format: iv + ciphertext + authTag
    const ciphertext = Buffer.concat([iv, encrypted, authTag]);

    return {
      plaintext: dekPlaintext,
      ciphertext,
      keyId,
      keyVersion: (await this.getOrCreateKeyEntry(keyId)).version,
    };
  }

  async wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult> {
    this.assertInitialized();

    const kek = await this.deriveKey(keyId);

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, kek, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const ciphertext = Buffer.concat([iv, encrypted, authTag]);

    return {
      ciphertext,
      keyId,
      keyVersion: (await this.getOrCreateKeyEntry(keyId)).version,
    };
  }

  async unwrapKey(
    keyId: string,
    ciphertext: Buffer,
    _keyVersion?: number,
    _keyVersionId?: string,
  ): Promise<Buffer> {
    this.assertInitialized();

    const kek = await this.deriveKey(keyId);

    const iv = ciphertext.subarray(0, IV_LENGTH);
    const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH);
    const encrypted = ciphertext.subarray(IV_LENGTH, ciphertext.length - AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, kek, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  // ── Direct Encrypt/Decrypt ─────────────────────────────────────────────

  async encrypt(keyId: string, plaintext: Buffer, aad?: KMSAADContext): Promise<Buffer> {
    this.assertInitialized();

    const key = await this.deriveKey(keyId);

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const aadBuffer = buildAADBuffer(aad);
    if (aadBuffer) {
      cipher.setAAD(aadBuffer);
    }
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([iv, encrypted, authTag]);
  }

  async decrypt(keyId: string, ciphertext: Buffer, aad?: KMSAADContext): Promise<Buffer> {
    this.assertInitialized();

    const key = await this.deriveKey(keyId);

    const iv = ciphertext.subarray(0, IV_LENGTH);
    const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH);
    const encrypted = ciphertext.subarray(IV_LENGTH, ciphertext.length - AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const aadBuffer = buildAADBuffer(aad);
    if (aadBuffer) {
      decipher.setAAD(aadBuffer);
    }
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  // ── Key Management ─────────────────────────────────────────────────────

  async createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata> {
    this.assertInitialized();

    const keyId = `local:${purpose}:${randomBytes(8).toString('hex')}`;
    const entry: LocalKeyEntry = {
      keyId,
      purpose,
      state: 'active',
      version: 1,
      createdAt: new Date(),
      derivedKey: await this.deriveKey(keyId),
      rotationIntervalDays: 0,
    };
    this.keys.set(keyId, entry);

    return this.entryToMetadata(entry);
  }

  async describeKey(keyId: string): Promise<KMSKeyMetadata> {
    const entry = this.keys.get(keyId) || (await this.getOrCreateKeyEntry(keyId));
    return this.entryToMetadata(entry);
  }

  async enableKeyRotation(keyId: string, intervalDays: number): Promise<void> {
    const entry = await this.getOrCreateKeyEntry(keyId);
    entry.rotationIntervalDays = intervalDays;
  }

  async scheduleKeyDeletion(keyId: string, _pendingWindowDays?: number): Promise<void> {
    const entry = this.keys.get(keyId);
    if (entry) {
      entry.state = 'destroyed';
      entry.derivedKey.fill(0);
    }
  }

  // ── Internal Helpers ───────────────────────────────────────────────────

  private assertInitialized(): void {
    if (!this.initialized || !this.masterKey) {
      throw new Error('LocalKMSProvider is not initialized. Call initialize() first.');
    }
  }

  /**
   * Derive a key from the master key using the provider's deterministic KDF.
   * Deterministic: same keyId always produces the same derived key.
   */
  private async deriveKey(keyId: string): Promise<Buffer> {
    const existing = this.keys.get(keyId);
    if (existing) return existing.derivedKey;

    const cached = this.derivedKeyCache.get(keyId);
    if (cached) return cached;

    const derived = await pbkdf2Async(
      this.masterKey!,
      `kms:${keyId}`,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST,
    );

    // LRU eviction: if cache is at capacity, evict the oldest entry
    const MAX_DERIVED_KEY_CACHE = 100;
    if (this.derivedKeyCache.size >= MAX_DERIVED_KEY_CACHE) {
      const oldestKey = this.derivedKeyCache.keys().next().value!;
      const evicted = this.derivedKeyCache.get(oldestKey)!;
      evicted.fill(0);
      this.derivedKeyCache.delete(oldestKey);
    }

    this.derivedKeyCache.set(keyId, derived);
    return derived;
  }

  private async getOrCreateKeyEntry(keyId: string): Promise<LocalKeyEntry> {
    let entry = this.keys.get(keyId);
    if (!entry) {
      entry = {
        keyId,
        purpose: 'data-encryption',
        state: 'active',
        version: 1,
        createdAt: new Date(),
        derivedKey: await this.deriveKey(keyId),
        rotationIntervalDays: 0,
      };
      this.keys.set(keyId, entry);
    }
    return entry;
  }

  private entryToMetadata(entry: LocalKeyEntry): KMSKeyMetadata {
    return {
      keyId: entry.keyId,
      purpose: entry.purpose,
      state: entry.state,
      protectionLevel: 'local',
      algorithm: 'AES-256-GCM',
      createdAt: entry.createdAt,
      rotationIntervalDays: entry.rotationIntervalDays,
    };
  }

  /**
   * Compute a deterministic key fingerprint for logging (never log actual key material).
   */
  static keyFingerprint(keyId: string): string {
    return createHash('sha256').update(keyId).digest('hex').slice(0, 12);
  }
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

interface LocalKeyEntry {
  keyId: string;
  purpose: KeyPurpose;
  state: KeyState;
  version: number;
  createdAt: Date;
  derivedKey: Buffer;
  rotationIntervalDays: number;
}
