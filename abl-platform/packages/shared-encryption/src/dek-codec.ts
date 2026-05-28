/**
 * Encryption Codec
 *
 * Raw AES-256-GCM encrypt/decrypt with DEK identifier embedding.
 * Wire format: base64(id_len[1] + dekId[N] + iv[12] + authTag[16] + ciphertext[...])
 *
 * The DEK identifier is embedded so decryption can look up the correct key.
 *
 * AAD (Additional Authenticated Data): When provided, the caller-supplied
 * tenant / resource / field context is bound into the GCM authentication tag.
 * This makes ciphertext swapping across tenants or fields cryptographically
 * impossible even if the correct DEK is used.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — NIST SP 800-38D recommended
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

function normalizeAAD(aad?: string | Buffer): Buffer | undefined {
  if (!aad) {
    return undefined;
  }
  return Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8');
}

/**
 * Encrypt plaintext with DEK and embed the DEK identifier in the ciphertext header.
 *
 * @param plaintext - UTF-8 string to encrypt
 * @param dek - 32-byte data encryption key
 * @param dekId - DEK identifier (e.g., "active", "active:R1")
 * @param aad - Additional Authenticated Data — bound into the GCM auth tag
 * @returns Base64-encoded ciphertext with embedded DEK identifier
 */
export function encryptWithDEK(
  plaintext: string,
  dek: Buffer,
  dekId: string,
  aad?: string | Buffer,
): string {
  if (dek.length !== KEY_LENGTH) {
    throw new Error(`DEK must be exactly ${KEY_LENGTH} bytes, got ${dek.length}`);
  }

  if (dekId.length > 255) {
    throw new Error(`DEK identifier must be ≤255 characters, got ${dekId.length}`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dek, iv);

  const aadBuffer = normalizeAAD(aad);
  if (aadBuffer) {
    cipher.setAAD(aadBuffer);
  }

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Wire format: id_len[1] + dekId[N] + iv[12] + authTag[16] + ciphertext
  const idBuf = Buffer.from(dekId, 'utf8');
  const idLenBuf = Buffer.from([idBuf.length]);
  const combined = Buffer.concat([idLenBuf, idBuf, iv, authTag, encrypted]);

  return combined.toString('base64');
}

/**
 * Decrypt ciphertext with DEK, extracting the embedded DEK identifier.
 *
 * @param ciphertext - Base64-encoded ciphertext with DEK ID header
 * @param dek - 32-byte data encryption key
 * @param aad - Additional Authenticated Data — must match what was used during encryption
 * @returns Object with plaintext and dekId
 */
export function decryptWithDEK(
  ciphertext: string,
  dek: Buffer,
  aad?: string | Buffer,
): { plaintext: string; dekId: string } {
  if (dek.length !== KEY_LENGTH) {
    throw new Error(`DEK must be exactly ${KEY_LENGTH} bytes, got ${dek.length}`);
  }

  const combined = Buffer.from(ciphertext, 'base64');

  // Parse wire format
  const idLen = combined[0];
  if (idLen === undefined || combined.length < 1 + idLen + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid ciphertext format: too short or corrupted header');
  }

  const dekId = combined.subarray(1, 1 + idLen).toString('utf8');
  const iv = combined.subarray(1 + idLen, 1 + idLen + IV_LENGTH);
  const authTag = combined.subarray(1 + idLen + IV_LENGTH, 1 + idLen + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(1 + idLen + IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, dek, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const aadBuffer = normalizeAAD(aad);
  if (aadBuffer) {
    decipher.setAAD(aadBuffer);
  }

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return {
    plaintext: decrypted.toString('utf8'),
    dekId,
  };
}
