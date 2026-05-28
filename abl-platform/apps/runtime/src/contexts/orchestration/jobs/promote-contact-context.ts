/**
 * PromoteContactContext BullMQ Job Processor
 *
 * When a session ends with a promotable disposition (completed, escalated),
 * this job extracts dataValues and metadata from the session snapshot and
 * merges them into the contact's cross-session ContactContext.
 *
 * Follows the BullMQ worker pattern: exports a factory that accepts
 * dependency ports and returns a processor function.
 *
 * Queue config:
 *   name: promote-contact-context
 *   concurrency: 5
 *   retry: 3 attempts, exponential backoff
 *   removeOnComplete: { count: 500, age: 86400 }
 *   removeOnFail: { count: 1000, age: 604800 }
 */

import type { ContactContext } from '../../contact/domain/contact.js';

// =============================================================================
// CONSTANTS
// =============================================================================

export const PROMOTE_CONTEXT_QUEUE_NAME = 'promote-contact-context';

export const PROMOTE_CONTEXT_QUEUE_CONFIG = {
  concurrency: 5,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 1000 },
    removeOnComplete: { count: 500, age: 86400 },
    removeOnFail: { count: 1000, age: 604800 },
  },
} as const;

/** Dispositions that trigger context promotion */
const PROMOTABLE_DISPOSITIONS = ['completed', 'escalated'] as const;

// =============================================================================
// TYPES
// =============================================================================

/** JSON-serializable job data pushed to the BullMQ queue. */
export interface PromoteContextJobData {
  tenantId: string;
  contactId: string;
  sessionId: string;
  disposition: string;
  /**
   * Session dataValues captured at enqueue time (before endSession clears Redis).
   * Preferences are intentionally excluded — they are set by the contact record
   * itself and are not promoted from session data.
   */
  dataValues: Record<string, unknown>;
}

/** Session snapshot fields needed for promotion. */
interface SessionSnapshot {
  dataValues: Record<string, unknown>;
}

/**
 * Dependency ports — no concrete store imports.
 *
 * WIRING REQUIREMENT: `updateContactContext` must be wired through
 * `ContactContextService.update()` (not a raw Mongoose call) so that
 * the Redis cache is invalidated on promotion. Failing to do so will
 * cause stale contact context reads for up to CACHE_TTL_SECONDS (5min).
 */
export interface PromoteContextDeps {
  loadSessionSnapshot: (tenantId: string, sessionId: string) => Promise<SessionSnapshot | null>;
  getContactContext: (tenantId: string, contactId: string) => Promise<ContactContext | null>;
  updateContactContext: (
    tenantId: string,
    contactId: string,
    context: ContactContext,
  ) => Promise<void>;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a BullMQ-compatible job processor for promoting session context
 * to the contact's cross-session ContactContext.
 *
 * The returned function matches BullMQ's `Processor` signature:
 * `(job: Job<PromoteContextJobData>) => Promise<void>`
 */
export function createPromoteContextProcessor(
  deps: PromoteContextDeps,
): (job: { data: PromoteContextJobData }) => Promise<void> {
  return async (job) => {
    const { tenantId, contactId, sessionId, disposition } = job.data;

    // Gate: only promote on completable dispositions
    if (!(PROMOTABLE_DISPOSITIONS as readonly string[]).includes(disposition)) {
      return;
    }

    // 1. Load session snapshot from MongoDB
    const snapshot = await deps.loadSessionSnapshot(tenantId, sessionId);
    if (!snapshot) return;

    // 2. Load existing contact context (may be null for first session)
    const existing = await deps.getContactContext(tenantId, contactId);

    const now = new Date();

    // 3. Merge: session dataValues win (additive merge, session overwrites on conflict)
    const merged: ContactContext = {
      preferences: {
        ...(existing?.preferences ?? {}),
      },
      dataValues: {
        ...(existing?.dataValues ?? {}),
        ...snapshot.dataValues,
      },
      lastDisposition: disposition,
      lastInteraction: now,
      sessionCount: (existing?.sessionCount ?? 0) + 1,
      updatedAt: now,
    };

    // 4. Persist merged context (invalidates cache via ContactContextService)
    await deps.updateContactContext(tenantId, contactId, merged);
  };
}
