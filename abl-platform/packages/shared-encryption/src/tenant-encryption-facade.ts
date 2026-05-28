/**
 * Tenant Encryption Facade
 *
 * Single interface for all tenant-scoped encryption across the platform.
 * Delegates to DEKManager for DEK-based envelope encryption only.
 *
 * One active DEK per scope (tenant+project+environment). On rotation, the active DEK
 * is marked decrypt_only and a new DEK is created. The DEK identifier is embedded in
 * the ciphertext header, so old data is still decryptable.
 *
 * Decrypt flow:
 * 1. Validate DEK envelope format
 * 2. Parse DEK ID from header → unwrapDEK(dekId, tenantId) → decrypt with DEK
 *    tenantId enforces cross-tenant isolation at both DB query and cache levels
 */
import * as dekCodec from './dek-codec.js';
import { encryptWithDEKPooled } from './dek-codec-pooled.js';
import { isDEKEnvelopeFormat } from './envelope-format.js';
import { createStderrLogger } from './stderr-logger.js';
import {
  buildTenantEncryptionAAD,
  buildTenantEncryptionAADCandidates,
  type TenantEncryptionAADContext,
} from './aad-context.js';
import { legacyCiphertextFormat } from './errors.js';

// Duck-typed interfaces to avoid circular import from database/kms
export interface DEKScope {
  tenantId: string;
  /** Required — Decision 1: greenfield, no default. Use '_tenant' for tenant-scoped models. */
  projectId: string;
  /** Required — Decision 1: greenfield, no default. Use '_shared' for no-env models (Decision 7). */
  environment: string;
}

export interface AcquiredDEK {
  plaintext: Buffer;
  /** Opaque DEK identifier embedded in ciphertext header (Decision 3). */
  dekId: string;
  kekKeyId: string;
  kekKeyVersion: number;
}

export interface DEKManagerLike {
  acquireDEK(scope: DEKScope, kekKeyId: string): Promise<AcquiredDEK>;
  /** Unwrap DEK by dekId. tenantId is required — enforces cross-tenant isolation in both DB query and cache. */
  unwrapDEK(dekId: string, tenantId: string): Promise<Buffer>;
  /** Sync cache lookup. When tenantId is provided, enforces tenant isolation on cache hit. */
  getCachedDEK?(dekId: string, tenantId?: string): Buffer | null;
  /** Get the active DEK identifier for sync encrypt paths. */
  getActiveDEKId?(scope?: DEKScope): string;
  /** Force-rotate DEKs for a scope (mark active → decrypt_only, clear cache). */
  forceRotateDEK?(scope: DEKScope): Promise<number>;
  /** Clear entire DEK cache. */
  clearCache?(): void;
}

const log = createStderrLogger('tenant-encryption-facade');

export class TenantEncryptionFacade {
  constructor(
    private dekManager: DEKManagerLike,
    private defaultKekKeyId = 'platform-default',
  ) {}

  /**
   * Encrypt plaintext using DEK-based envelope encryption.
   *
   * @param plaintext - UTF-8 string to encrypt
   * @param scope - DEKScope (tenantId + projectId + environment)
   * @returns Base64-encoded ciphertext with embedded DEK identifier
   */
  async encrypt(
    plaintext: string,
    scope: DEKScope,
    context?: TenantEncryptionAADContext,
  ): Promise<string> {
    // Guard against double encryption
    if (this.looksLikeEncrypted(plaintext)) {
      throw new Error('Double encryption detected: value is already in encrypted format');
    }

    // Acquire the active DEK for this scope
    const acquired = await this.dekManager.acquireDEK(scope, this.defaultKekKeyId);

    const aad = buildTenantEncryptionAAD(scope.tenantId, context);
    return encryptWithDEKPooled(plaintext, acquired.plaintext, acquired.dekId, aad);
  }

  /**
   * Decrypt DEK-envelope ciphertext.
   *
   * Decision 3: DEK decrypt uses dekId from ciphertext header — no scope needed.
   * @param ciphertext - Encrypted string (DEK envelope base64)
   * @param tenantId - Tenant ID used to enforce cross-tenant DEK isolation
   * @returns Decrypted plaintext
   */
  async decrypt(
    ciphertext: string,
    tenantId: string,
    context?: TenantEncryptionAADContext,
  ): Promise<string> {
    if (!isDEKEnvelopeFormat(ciphertext)) {
      throw legacyCiphertextFormat();
    }

    const combined = Buffer.from(ciphertext, 'base64');
    const idLen = combined[0];
    if (idLen === undefined || combined.length < 1 + idLen) {
      throw new Error('Invalid envelope ciphertext: corrupted DEK ID header');
    }
    const dekId = combined.subarray(1, 1 + idLen).toString('utf8');
    const dek = await this.dekManager.unwrapDEK(dekId, tenantId);
    const aadCandidates = buildTenantEncryptionAADCandidates(tenantId, context);
    let authTagError: unknown = null;

    for (let index = 0; index < aadCandidates.length; index += 1) {
      const aad = aadCandidates[index];
      try {
        const result = dekCodec.decryptWithDEK(ciphertext, dek, aad);
        if (index > 0) {
          log.warn('Tenant DEK decrypt succeeded via backward-compatible AAD fallback', {
            dekId,
            tenantId,
            ciphertextLength: ciphertext.length,
            fallbackMode: this.describeAADMode(aad, tenantId),
            primaryError: this.getErrorMessage(authTagError),
          });
        }
        return result.plaintext;
      } catch (error) {
        if (!this.isAuthTagMismatch(error)) {
          throw error;
        }
        authTagError = authTagError ?? error;
      }
    }

    log.warn('Tenant DEK decrypt failed for all AAD candidates', {
      dekId,
      tenantId,
      ciphertextLength: ciphertext.length,
      context,
      error: this.getErrorMessage(authTagError),
    });
    throw authTagError;
  }

  /**
   * Sync encrypt using cached DEK. Returns envelope ciphertext on cache hit, null on miss.
   */
  encryptSync(
    plaintext: string,
    scope: DEKScope,
    context?: TenantEncryptionAADContext,
  ): string | null {
    if (!this.dekManager.getCachedDEK || !this.dekManager.getActiveDEKId) return null;

    const dekId = this.dekManager.getActiveDEKId(scope);
    const dek = this.dekManager.getCachedDEK(dekId, scope.tenantId);
    if (!dek) return null;

    if (this.looksLikeEncrypted(plaintext)) {
      throw new Error('Double encryption detected: value is already in encrypted format');
    }

    const aad = buildTenantEncryptionAAD(scope.tenantId, context);
    return encryptWithDEKPooled(plaintext, dek, dekId, aad);
  }

  /**
   * Sync decrypt using cached DEK. Returns plaintext on cache hit, null on miss.
   * When tenantId is provided, enforces tenant isolation on cache lookup.
   */
  decryptSync(
    ciphertext: string,
    tenantId?: string,
    context?: TenantEncryptionAADContext,
  ): string | null {
    if (!isDEKEnvelopeFormat(ciphertext)) return null;

    // DEK envelope format — try sync cache lookup
    try {
      const combined = Buffer.from(ciphertext, 'base64');
      const idLen = combined[0];
      if (idLen === undefined || combined.length < 1 + idLen) return null;
      const dekId = combined.subarray(1, 1 + idLen).toString('utf8');

      if (!this.dekManager.getCachedDEK) return null;
      // Tenant isolation enforced on cache hit when tenantId provided
      const dek = this.dekManager.getCachedDEK(dekId, tenantId);
      if (!dek) return null;

      const aadCandidates = tenantId
        ? buildTenantEncryptionAADCandidates(tenantId, context)
        : [undefined];

      for (const aad of aadCandidates) {
        try {
          return dekCodec.decryptWithDEK(ciphertext, dek, aad).plaintext;
        } catch {
          // Try the next backward-compatible AAD candidate.
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Encrypt a JSON value.
   */
  async encryptJson(
    value: unknown,
    scope: DEKScope,
    context?: TenantEncryptionAADContext,
  ): Promise<string> {
    return this.encrypt(JSON.stringify(value), scope, context);
  }

  /**
   * Decrypt a JSON value.
   */
  async decryptJson<T = unknown>(
    ciphertext: string,
    tenantId: string,
    context?: TenantEncryptionAADContext,
  ): Promise<T> {
    const json = await this.decrypt(ciphertext, tenantId, context);
    return JSON.parse(json) as T;
  }

  /**
   * Check if a string looks like it's already encrypted.
   * Used to prevent double encryption.
   */
  private looksLikeEncrypted(value: string): boolean {
    return isDEKEnvelopeFormat(value);
  }

  private isAuthTagMismatch(error: unknown): boolean {
    return this.getErrorMessage(error).includes('Unsupported state or unable to authenticate data');
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private describeAADMode(aad: string | undefined, tenantId: string): string {
    if (!aad) {
      return 'legacy-none';
    }
    return aad === tenantId ? 'tenant' : 'tenant-resource-field';
  }

  /**
   * Force-rotate DEKs. Marks active DEKs as decrypt_only and clears the in-memory cache.
   * Next encrypt will generate fresh key material.
   *
   * @param tenantId - Tenant to rotate
   * @param projectId - Optional: scope to specific project (omit for tenant-wide)
   * @param environment - Optional: scope to specific environment (omit for all)
   */
  async forceRotate(tenantId: string, projectId?: string, environment?: string): Promise<number> {
    if (this.dekManager.forceRotateDEK) {
      return this.dekManager.forceRotateDEK({
        tenantId,
        // '_tenant' is the tenant-wide sentinel in DEKManager.forceRotateDEK —
        // it omits the field from the filter so ALL active DEKs for the tenant
        // are rotated. '_shared' is a real scope value (no-env models) and would
        // only rotate DEKs with environment='_shared'.
        projectId: projectId || '_tenant',
        environment: environment || '_tenant',
      });
    }
    return 0;
  }

  /**
   * Clear the DEK cache (for shutdown or cache invalidation).
   */
  clearCache(): void {
    if (this.dekManager.clearCache) {
      this.dekManager.clearCache();
    }
  }
}
