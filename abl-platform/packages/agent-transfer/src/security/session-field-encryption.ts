/**
 * Session Field-Level Encryption
 *
 * Encrypts sensitive session fields (metadata, providerData) before
 * storing in Redis. Supports per-tenant key scoping and backward-compatible
 * reads of unencrypted data.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('session-field-encryption');

const ENCRYPTED_PREFIX = 'enc:v1:';

/**
 * Interface for encrypting/decrypting individual session fields.
 * Implementations may scope keys per tenant for isolation.
 */
export interface SessionFieldEncryptor {
  encryptField(plaintext: string, tenantId: string): Promise<string>;
  decryptField(ciphertext: string, tenantId: string): Promise<string>;
  isEncrypted(value: string): boolean;
}

/**
 * Wraps an existing EncryptionService to provide field-level encryption
 * scoped per tenant.
 */
export class TenantScopedSessionEncryptor implements SessionFieldEncryptor {
  private readonly encryptionService: {
    encryptForTenant(plaintext: string, tenantId: string): Promise<string>;
    decryptForTenant(ciphertext: string, tenantId: string): Promise<string>;
  };

  constructor(encryptionService: {
    encryptForTenant(plaintext: string, tenantId: string): Promise<string>;
    decryptForTenant(ciphertext: string, tenantId: string): Promise<string>;
  }) {
    this.encryptionService = encryptionService;
  }

  async encryptField(plaintext: string, tenantId: string): Promise<string> {
    try {
      const encrypted = await this.encryptionService.encryptForTenant(plaintext, tenantId);
      return `${ENCRYPTED_PREFIX}${encrypted}`;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error('ENCRYPTION_FAILURE: session field encryption failed', {
        tenantId,
        error: errorMessage,
        metric: 'session_encryption_failure',
        severity: 'critical',
      });
      throw err instanceof Error ? err : new Error(errorMessage);
    }
  }

  async decryptField(ciphertext: string, tenantId: string): Promise<string> {
    if (!this.isEncrypted(ciphertext)) {
      return ciphertext;
    }

    try {
      const encrypted = ciphertext.slice(ENCRYPTED_PREFIX.length);
      return await this.encryptionService.decryptForTenant(encrypted, tenantId);
    } catch (err) {
      log.error('DECRYPTION_FAILURE: session field unreadable', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
        metric: 'session_decryption_failure',
        severity: 'critical',
      });
      // Return empty JSON object string — callers parse metadata/providerData
      // as JSON, so '{}' is safer than returning raw ciphertext which would
      // fail JSON.parse and potentially leak encrypted data to logs.
      return '{}';
    }
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTED_PREFIX);
  }
}

/**
 * No-op encryptor for backward compatibility.
 * Used when encryption is not configured.
 */
export class NullSessionEncryptor implements SessionFieldEncryptor {
  async encryptField(plaintext: string): Promise<string> {
    return plaintext;
  }

  async decryptField(ciphertext: string): Promise<string> {
    return ciphertext;
  }

  isEncrypted(): boolean {
    return false;
  }
}
