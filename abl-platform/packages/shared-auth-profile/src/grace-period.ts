/**
 * Grace Period Fallback for Auth Profile Credential Resolution
 *
 * During key rotation, primaryEncryptedSecrets may temporarily fail to decrypt
 * (e.g., if a pod has stale key material). This module falls back to
 * previousEncryptedSecrets within the configured grace period.
 */

export interface GracePeriodProfile {
  encryptedSecrets: string;
  previousEncryptedSecrets?: string;
  rotationGracePeriodMs?: number;
  updatedAt: Date;
}

/**
 * Resolve credentials with grace period fallback.
 *
 * 1. Try to decrypt encryptedSecrets (primary)
 * 2. If that fails AND previousEncryptedSecrets exists AND we are within the grace period,
 *    try to decrypt previousEncryptedSecrets
 * 3. Otherwise, re-throw the primary error
 *
 * @param profile - The auth profile document (with encrypted fields)
 * @param decrypt - Decryption function (e.g., from EncryptionService)
 * @returns Parsed secrets as a record
 */
export async function resolveWithGracePeriod(
  profile: GracePeriodProfile,
  decrypt: (cipher: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  try {
    const decrypted = await decrypt(profile.encryptedSecrets);
    return JSON.parse(decrypted) as Record<string, unknown>;
  } catch (primaryErr) {
    // Check if grace period is active
    if (
      profile.previousEncryptedSecrets &&
      profile.rotationGracePeriodMs &&
      Date.now() - profile.updatedAt.getTime() < profile.rotationGracePeriodMs
    ) {
      const decrypted = await decrypt(profile.previousEncryptedSecrets);
      return JSON.parse(decrypted) as Record<string, unknown>;
    }
    throw primaryErr;
  }
}
