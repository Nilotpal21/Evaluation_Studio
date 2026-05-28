import {
  getEncryptionFacade,
  isAlreadyEncrypted,
  type TenantEncryptionAADContext,
} from '@agent-platform/shared-encryption';

export interface ResolveTenantPlaintextValueOptions {
  /**
   * When true, the caller already knows the Mongoose encryption plugin left
   * ciphertext in place (for example via `_decryptionFailed`).
   */
  decryptionFailed?: boolean;
  /** Optional field-aware AAD binding for plugin-managed secrets. */
  aadContext?: TenantEncryptionAADContext;
}

/**
 * Resolve a tenant-scoped secret to plaintext.
 *
 * Plugin-managed fields are normally already plaintext on read, but some
 * callers still need a safe fallback when the post-find hook leaves
 * ciphertext in place. The decision is made per field so a document-level
 * `_decryptionFailed` flag on a sibling field does not force a second
 * decrypt of an already-plaintext value.
 */
export async function resolveTenantPlaintextValue(
  value: string | null | undefined,
  tenantId: string,
  _options: ResolveTenantPlaintextValueOptions = {},
): Promise<string | null> {
  if (!value) {
    return null;
  }

  const looksEncrypted = isAlreadyEncrypted(value);
  if (!looksEncrypted) {
    return value;
  }

  const facade = getEncryptionFacade();
  if (!facade) {
    throw new Error(
      'Tenant encryption facade is not initialized; cannot resolve plaintext tenant secret.',
    );
  }

  return facade.decrypt(value, tenantId, _options.aadContext);
}
