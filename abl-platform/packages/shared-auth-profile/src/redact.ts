/**
 * Auth Profile Secret Redaction
 *
 * Strips secret fields from auth profile documents before returning them
 * in API responses. This prevents accidental leakage of encrypted secrets,
 * previous secrets, and encryption key metadata.
 */

/** Fields that are always stripped from API responses */
const SECRET_FIELDS = [
  'encryptedSecrets',
  'previousEncryptedSecrets',
  'encryptionKeyVersion',
] as const;

/**
 * Redacts secret fields from a single auth profile document.
 * Returns a shallow copy with secret fields removed — the original is never mutated.
 *
 * @param profile  A plain object (e.g. from `.lean()` or `.toObject()`)
 * @returns        A new object with secret fields absent
 */
export function redactAuthProfile<T extends Record<string, unknown>>(
  profile: T | null | undefined,
): Omit<T, (typeof SECRET_FIELDS)[number]> | null {
  if (profile == null) return null;

  const copy = { ...profile };
  for (const field of SECRET_FIELDS) {
    delete (copy as Record<string, unknown>)[field];
  }
  return copy as Omit<T, (typeof SECRET_FIELDS)[number]>;
}

/**
 * Redacts secret fields from an array of auth profile documents.
 * Returns a new array — the originals are never mutated.
 */
export function redactAuthProfileList<T extends Record<string, unknown>>(
  profiles: T[],
): Array<Omit<T, (typeof SECRET_FIELDS)[number]>> {
  return profiles.map((p) => redactAuthProfile(p) as Omit<T, (typeof SECRET_FIELDS)[number]>);
}
