/**
 * KMS Provider Interface & Types
 *
 * Defines the contract for all KMS providers (local, AWS, Azure, GCP, external).
 * Follows NIST SP 800-57 key hierarchy: PRK → TKEK → DEK → data.
 */

// =============================================================================
// KEY TYPES
// =============================================================================

export type KeyPurpose =
  | 'platform-root' // PRK — never leaves HSM
  | 'tenant-kek' // TKEK — wraps DEKs
  | 'data-encryption' // DEK — encrypts data
  | 'signing' // Digital signatures
  | 'hmac'; // HMAC operations

export type KeyState =
  | 'pre-active' // Generated but not yet activated
  | 'active' // Available for encrypt + decrypt
  | 'decrypt-only' // Past cryptoperiod — decrypt only, no new encrypts
  | 'deactivated' // Archived — needs explicit re-activation
  | 'compromised' // Emergency — trigger re-encryption
  | 'destroyed'; // Zeroized — unrecoverable

export type ProtectionLevel =
  | 'hsm' // FIPS 140-3 Level 3 (Azure Managed HSM, AWS CloudHSM, GCP HSM)
  | 'software-protected' // Cloud KMS software keys (Azure Key Vault, AWS KMS default, GCP SOFTWARE)
  | 'platform-shared' // Platform-managed shared key (multi-tenant)
  | 'local' // In-process (dev/test only)
  | 'ephemeral'; // In-memory, not persisted (unit tests)

// =============================================================================
// RESULT TYPES
// =============================================================================

export interface GenerateDataKeyResult {
  /** The plaintext DEK (caller must zero-fill after use) */
  plaintext: Buffer;
  /** The DEK wrapped/encrypted by the KEK */
  ciphertext: Buffer;
  /** KMS key ID that performed the wrapping */
  keyId: string;
  /** Version of the KMS key used (integer for local, monotonic) */
  keyVersion?: number;
  /** Provider-specific version identifier (e.g., Azure Key Vault hex version string).
   *  Used for version-pinned unwrap after KEK rotation. */
  keyVersionId?: string;
}

export interface WrapKeyResult {
  /** The wrapped (encrypted) key material */
  ciphertext: Buffer;
  /** KMS key ID that performed the wrapping */
  keyId: string;
  /** Version of the KMS key used (integer for local, monotonic) */
  keyVersion?: number;
  /** Provider-specific version identifier (e.g., Azure Key Vault hex version string).
   *  Used for version-pinned unwrap after KEK rotation. */
  keyVersionId?: string;
}

export interface KMSKeyMetadata {
  keyId: string;
  purpose: KeyPurpose;
  state: KeyState;
  protectionLevel: ProtectionLevel;
  algorithm: string;
  createdAt: Date;
  rotatedAt?: Date;
  expiresAt?: Date;
  /** Auto-rotation interval in days (0 = disabled) */
  rotationIntervalDays: number;
  /** Provider-specific metadata */
  providerMetadata?: Record<string, unknown>;
}

export interface KMSHealthStatus {
  healthy: boolean;
  providerType: string;
  latencyMs: number;
  message?: string;
}

export interface KMSAADContext {
  tenantId: string;
  resourceType: string;
  fieldName: string;
}

function requireNonEmptyAADValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`KMS AAD ${label} must be a non-empty string`);
  }
  return trimmed;
}

export function buildKMSAADBuffer(context?: KMSAADContext): Buffer | undefined {
  if (!context) {
    return undefined;
  }

  return Buffer.from(
    [
      requireNonEmptyAADValue('tenantId', context.tenantId),
      requireNonEmptyAADValue('resourceType', context.resourceType),
      requireNonEmptyAADValue('fieldName', context.fieldName),
    ].join(':'),
    'utf8',
  );
}

// =============================================================================
// KMS PROVIDER INTERFACE
// =============================================================================

export interface KMSProvider {
  /** Provider identifier (e.g., 'local', 'aws-kms', 'azure-keyvault') */
  readonly providerType: string;

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Initialize the provider (connect to KMS, validate credentials) */
  initialize(): Promise<void>;

  /** Shutdown the provider (zero-fill cached keys, close connections) */
  shutdown(): Promise<void>;

  /** Health check — validates connectivity and permissions */
  healthCheck(): Promise<KMSHealthStatus>;

  // ── Data Key Operations ──────────────────────────────────────────────

  /**
   * Generate a new data encryption key (DEK).
   * Returns both plaintext and wrapped forms.
   * The plaintext must be zero-filled by the caller after use.
   *
   * @param keyId - The KEK key ID to wrap the DEK with
   */
  generateDataKey(keyId: string): Promise<GenerateDataKeyResult>;

  /**
   * Wrap (encrypt) an existing key with a KEK.
   *
   * @param keyId - The KEK key ID to use for wrapping
   * @param plaintext - The key material to wrap
   */
  wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult>;

  /**
   * Unwrap (decrypt) a previously wrapped key.
   *
   * @param keyId - The KEK key ID that performed the wrapping
   * @param ciphertext - The wrapped key material
   * @param keyVersion - Optional: specific KEK version (integer, for rotation)
   * @param keyVersionId - Optional: provider-specific version identifier
   *   (e.g., Azure Key Vault hex version string). When present, the provider
   *   MUST use this to target the exact key version for unwrap.
   */
  unwrapKey(
    keyId: string,
    ciphertext: Buffer,
    keyVersion?: number,
    keyVersionId?: string,
  ): Promise<Buffer>;

  // ── Direct Encrypt/Decrypt ───────────────────────────────────────────

  /**
   * Encrypt data directly with a KMS key (small payloads only, ≤4KB).
   * For large data, use generateDataKey + local AES-GCM.
   */
  encrypt(keyId: string, plaintext: Buffer, aad?: KMSAADContext): Promise<Buffer>;

  /** Decrypt data previously encrypted with encrypt() */
  decrypt(keyId: string, ciphertext: Buffer, aad?: KMSAADContext): Promise<Buffer>;

  // ── Key Management ───────────────────────────────────────────────────

  /** Create a new KMS key for the given purpose */
  createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata>;

  /** Get metadata about an existing key */
  describeKey(keyId: string): Promise<KMSKeyMetadata>;

  /** Enable automatic key rotation */
  enableKeyRotation(keyId: string, intervalDays: number): Promise<void>;

  /** Schedule key for deletion (with pending window for recovery) */
  scheduleKeyDeletion(keyId: string, pendingWindowDays?: number): Promise<void>;

  // ── BYOK (optional) ──────────────────────────────────────────────────

  /**
   * Get the public wrapping key for BYOK import.
   * Only supported by cloud KMS providers.
   */
  getWrappingPublicKey?(keyId: string): Promise<Buffer>;

  /**
   * Import externally-generated key material (BYOK).
   * Key material must be wrapped with the provider's wrapping public key.
   */
  importKeyMaterial?(keyId: string, wrapped: Buffer): Promise<void>;
}
