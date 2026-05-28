/**
 * Merge Suggestion Domain Type
 *
 * Represents a suggestion to merge two contacts that share overlapping
 * identities. Created by the merge detection logic and resolved by
 * an admin, the system (auto-merge), or the contact themselves (self).
 *
 * Domain layer: zero infrastructure imports.
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Confidence level of a merge suggestion based on identity overlap strength.
 */
export type MergeSuggestionConfidence = 'high' | 'medium' | 'low';

/**
 * Lifecycle status of a merge suggestion.
 * - pending: Awaiting resolution
 * - accepted: Approved and merge executed
 * - rejected: Dismissed by reviewer
 * - auto_merged: System auto-merged (high confidence threshold)
 */
export type MergeSuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'auto_merged';

/**
 * An overlapping identity between two contacts.
 * Uses the blind index (not the encrypted value) so the suggestion
 * can be evaluated without decrypting PII.
 */
export interface OverlapIdentity {
  type: string;
  blindIndex: string;
}

/**
 * A suggestion to merge two contacts based on overlapping identities.
 *
 * The primaryContactId is the surviving contact; the secondaryContactId
 * will be merged into it. resolvedBy can be a userId, 'system', or 'self'.
 */
export interface MergeSuggestion {
  id: string;
  tenantId: string;
  primaryContactId: string;
  secondaryContactId: string;
  overlapIdentities: OverlapIdentity[];
  confidence: MergeSuggestionConfidence;
  status: MergeSuggestionStatus;
  suggestedAt: Date;
  resolvedAt: Date | null;
  /** userId, 'system', or 'self'. */
  resolvedBy: string | null;
}
