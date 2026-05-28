/**
 * Auth Config Crypto
 *
 * Encrypts/decrypts per-tenant KMS auth credential JSON blobs
 * using the platform's LocalKMSProvider.
 *
 * Design: Per-tenant cloud KMS credentials are encrypted with the *platform*
 * key (via LocalKMSProvider.encrypt), not the tenant's own cloud KMS.
 * This avoids the chicken-and-egg problem: we need the credentials to
 * connect to the tenant's KMS, so those credentials must be protected
 * by a key we already have (the platform key).
 */

import type { KMSAADContext, KMSProvider } from './types.js';

function isAuthTagMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('authenticate data');
}

/**
 * Encrypt a plain auth config object into a base64 string.
 */
export async function encryptAuthConfig(
  config: Record<string, string | undefined>,
  provider: KMSProvider,
  keyId: string,
  aad?: KMSAADContext,
): Promise<string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined) clean[k] = v;
  }
  const plaintext = Buffer.from(JSON.stringify(clean), 'utf8');
  const ciphertext = await provider.encrypt(keyId, plaintext, aad);
  return ciphertext.toString('base64');
}

/**
 * Decrypt a base64-encoded auth config blob back to a plain JSON object.
 */
export async function decryptAuthConfig(
  encrypted: string | null | undefined,
  provider: KMSProvider,
  keyId: string,
  aad?: KMSAADContext,
): Promise<Record<string, string | undefined>> {
  if (!encrypted) return {};
  const ciphertext = Buffer.from(encrypted, 'base64');
  try {
    const plaintext = await provider.decrypt(keyId, ciphertext, aad);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    if (!aad || !isAuthTagMismatch(error)) {
      throw error;
    }

    // Migration backward-compat: blobs written before AAD was introduced lack the
    // auth tag binding, so decryption fails with an auth-tag mismatch.  Retry
    // without AAD to keep those entries readable during the migration window.
    //
    // REMOVAL: once all existing authConfigEncrypted rows have been re-encrypted
    // with AAD (run the KMS auth-config migration job), delete this fallback block
    // and the isAuthTagMismatch helper above to restore strict AAD binding.
    const plaintext = await provider.decrypt(keyId, ciphertext);
    return JSON.parse(plaintext.toString('utf8'));
  }
}
