/**
 * DetectMergeCandidates BullMQ Job Processor
 *
 * After a contact is linked or identities are added, this job checks
 * whether the contact shares blind indexes with any other contacts in
 * the same tenant. For each overlap, it creates a MergeSuggestion for
 * admin review or auto-merge.
 *
 * Follows the BullMQ worker pattern: exports a factory that accepts
 * dependency ports and returns a processor function.
 *
 * Queue config:
 *   name: merge-detection
 *   concurrency: 3
 *   retry: 3 attempts, exponential backoff
 *   removeOnComplete: { count: 500, age: 86400 }
 *   removeOnFail: { count: 1000, age: 604800 }
 */

import type { ContactRepository } from '../../contact/domain/contact-repository.js';
import type { MergeSuggestion, OverlapIdentity } from '../../contact/domain/merge-suggestion.js';
import type { Contact } from '../../contact/domain/contact.js';

// =============================================================================
// CONSTANTS
// =============================================================================

export const MERGE_DETECTION_QUEUE_NAME = 'merge-detection';

export const MERGE_DETECTION_QUEUE_CONFIG = {
  concurrency: 3,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 1000 },
    removeOnComplete: { count: 500, age: 86400 },
    removeOnFail: { count: 1000, age: 604800 },
  },
} as const;

// =============================================================================
// TYPES
// =============================================================================

/** JSON-serializable job data pushed to the BullMQ queue. */
export interface MergeDetectionJobData {
  tenantId: string;
  contactId: string;
}

/** Dependency ports -- no concrete store imports. */
export interface MergeDetectionDeps {
  contactRepository: ContactRepository;
  saveMergeSuggestion: (suggestion: MergeSuggestion) => Promise<void>;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Compute overlap identities between the source contact and a candidate.
 * Returns blind indexes that appear in both contacts' identities.
 */
function computeOverlap(source: Contact, candidate: Contact): OverlapIdentity[] {
  const sourceIndexes = new Map(source.identities.map((i) => [i.blindIndex, i.type]));
  const overlaps: OverlapIdentity[] = [];

  for (const identity of candidate.identities) {
    if (sourceIndexes.has(identity.blindIndex)) {
      overlaps.push({ type: identity.type, blindIndex: identity.blindIndex });
    }
  }

  return overlaps;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a BullMQ-compatible job processor for merge detection.
 *
 * The returned function matches BullMQ's `Processor` signature:
 * `(job: Job<MergeDetectionJobData>) => Promise<void>`
 */
export function createMergeDetectionProcessor(
  deps: MergeDetectionDeps,
): (job: { data: MergeDetectionJobData }) => Promise<void> {
  return async (job) => {
    const { tenantId, contactId } = job.data;

    const contact = await deps.contactRepository.findById(tenantId, contactId);
    if (!contact) {
      return;
    }

    const blindIndexes = contact.identities.map((i) => i.blindIndex);
    if (blindIndexes.length === 0) {
      return;
    }

    const candidates = await deps.contactRepository.findMergeCandidates(tenantId, blindIndexes);

    // Filter out the source contact itself
    const otherContacts = candidates.filter((c) => c.id !== contactId);

    for (const candidate of otherContacts) {
      const overlapIdentities = computeOverlap(contact, candidate);

      const suggestion: MergeSuggestion = {
        id: `merge-${contactId}-${candidate.id}`,
        tenantId,
        primaryContactId: contactId,
        secondaryContactId: candidate.id,
        overlapIdentities,
        confidence: overlapIdentities.length >= 2 ? 'high' : 'medium',
        status: 'pending',
        suggestedAt: new Date(),
        resolvedAt: null,
        resolvedBy: null,
      };

      await deps.saveMergeSuggestion(suggestion);
    }
  };
}
