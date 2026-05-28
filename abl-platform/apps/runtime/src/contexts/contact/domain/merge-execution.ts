/**
 * Merge Execution Domain Type
 *
 * Records the outcome of a contact merge operation. Captures which
 * identities and sessions were moved from the secondary contact to
 * the primary contact, for audit and rollback purposes.
 *
 * Domain layer: zero infrastructure imports.
 */

import type { ContactIdentity } from './contact-identity.js';

/**
 * Record of a completed merge operation between two contacts.
 *
 * The primaryContactId is the surviving contact that received identities
 * and sessions. The secondaryContactId is the merged-away contact.
 * mergedBy can be a userId, 'system', or 'self'.
 */
export interface MergeExecution {
  id: string;
  tenantId: string;
  primaryContactId: string;
  secondaryContactId: string;
  /** Identities that were moved from secondary to primary. */
  identitiesMoved: ContactIdentity[];
  /** Session IDs that were reassigned from secondary to primary. */
  sessionsMoved: string[];
  mergedAt: Date;
  /** userId, 'system', or 'self'. */
  mergedBy: string;
  /** Link back to the MergeSuggestion that triggered this merge, if applicable. */
  suggestionId: string | null;
}
