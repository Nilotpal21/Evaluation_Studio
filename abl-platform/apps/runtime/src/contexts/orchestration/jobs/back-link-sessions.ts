/**
 * BackLinkSessions BullMQ Job Processor
 *
 * When a contact is newly created or a session is promoted, this job
 * back-links all existing sessions that share the same channel artifact
 * hash within a tenant to the contact. This ensures older anonymous
 * sessions get associated with the now-identified contact.
 *
 * Follows the BullMQ worker pattern: exports a factory that accepts
 * dependency ports and returns a processor function.
 *
 * Queue config:
 *   name: identity-back-link
 *   concurrency: 3
 *   retry: 3 attempts, exponential backoff
 *   removeOnComplete: { count: 500, age: 86400 }
 *   removeOnFail: { count: 1000, age: 604800 }
 */

// =============================================================================
// CONSTANTS
// =============================================================================

export const BACK_LINK_QUEUE_NAME = 'identity-back-link';

export const BACK_LINK_QUEUE_CONFIG = {
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
export interface BackLinkJobData {
  tenantId: string;
  contactId: string;
  channelArtifact: string;
}

/** Dependency ports -- no concrete store imports. */
export interface BackLinkDeps {
  findSessionsByArtifact: (
    tenantId: string,
    artifactHash: string,
  ) => Promise<Array<{ sessionId: string }>>;
  updateSessionContactId: (tenantId: string, sessionId: string, contactId: string) => Promise<void>;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a BullMQ-compatible job processor for back-linking sessions.
 *
 * The returned function matches BullMQ's `Processor` signature:
 * `(job: Job<BackLinkJobData>) => Promise<void>`
 */
export function createBackLinkProcessor(
  deps: BackLinkDeps,
): (job: { data: BackLinkJobData }) => Promise<void> {
  return async (job) => {
    const { tenantId, contactId, channelArtifact } = job.data;

    const sessions = await deps.findSessionsByArtifact(tenantId, channelArtifact);

    for (const session of sessions) {
      await deps.updateSessionContactId(tenantId, session.sessionId, contactId);
    }
  };
}
