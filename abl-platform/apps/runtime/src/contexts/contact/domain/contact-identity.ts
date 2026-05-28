/**
 * Contact Identity Value Object
 *
 * Represents a single identity attached to a Contact (e.g. email, phone, external CRM ID).
 * Values are stored encrypted (AES-256-GCM) with a deterministic blind index (HMAC-SHA256)
 * for searching without decryption.
 *
 * Domain layer: zero infrastructure imports.
 */

import type { VerificationMethod } from '@agent-platform/shared-auth';

// =============================================================================
// TYPES
// =============================================================================

/**
 * The kind of identity value.
 * - email: Email address (normalized: lowercase + trim)
 * - phone: Phone number (normalized: E.164)
 * - external: Externally-managed identifier (CRM ID, OAuth subject, etc.)
 */
export type ContactIdentityType = 'email' | 'phone' | 'external';

/**
 * A single identity attached to a Contact.
 *
 * The encryptedValue is AES-256-GCM(DEK[tenantId], plaintext).
 * The blindIndex is HMAC-SHA256(blindKey[tenantId], normalize(value)).
 * Verification state tracks whether this identity has been cryptographically proven.
 */
export interface ContactIdentity {
  type: ContactIdentityType;
  encryptedValue: string;
  blindIndex: string;
  verified: boolean;
  verifiedAt: Date | null;
  verifiedVia: VerificationMethod | null;
  channel: string | null;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Parameters for creating a ContactIdentity via the factory function.
 * Only type, encryptedValue, and blindIndex are required;
 * the rest default to unverified/null.
 */
export interface CreateContactIdentityParams {
  type: ContactIdentityType;
  encryptedValue: string;
  blindIndex: string;
  verified?: boolean;
  verifiedAt?: Date | null;
  verifiedVia?: VerificationMethod | null;
  channel?: string | null;
}

/**
 * Create a ContactIdentity value object with sensible defaults.
 * Unverified by default; supply verified/verifiedAt/verifiedVia to mark as verified.
 */
export function createContactIdentity(params: CreateContactIdentityParams): ContactIdentity {
  return {
    type: params.type,
    encryptedValue: params.encryptedValue,
    blindIndex: params.blindIndex,
    verified: params.verified ?? false,
    verifiedAt: params.verifiedAt ?? null,
    verifiedVia: params.verifiedVia ?? null,
    channel: params.channel ?? null,
  };
}
