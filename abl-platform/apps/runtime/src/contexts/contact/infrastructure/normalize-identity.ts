/**
 * Normalize an identity value based on its type before encryption or indexing.
 *
 * - email: lowercase + trim whitespace
 * - phone: strip non-digit characters (keep leading +), prepend + if missing (E.164)
 * - external: returned unchanged
 */
export function normalizeIdentity(type: 'email' | 'phone' | 'external', value: string): string {
  switch (type) {
    case 'email':
      return value.toLowerCase().trim();
    case 'phone': {
      const digits = value.replace(/[^\d+]/g, '');
      return digits.startsWith('+') ? digits : `+${digits}`;
    }
    case 'external':
      return value;
  }
}
