/**
 * Event GDPR service interface.
 *
 * Handles right-to-erasure and data deletion requests by delegating to IEventLifecycle.
 * Integrated into existing cascade-delete functions (deleteSession, deleteProject, deleteTenant).
 */

export interface IEventGDPR {
  /**
   * Delete all events for specific sessions (GDPR cascade).
   * Called during session deletion.
   */
  deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void>;

  /**
   * Anonymize actor identity across all events (GDPR right-to-erasure).
   * Replaces actor_id with '[ANONYMIZED:hash]'.
   */
  anonymizeActor(tenantId: string, actorId: string): Promise<void>;

  /**
   * Delete ALL events for a tenant (tenant offboarding).
   */
  deleteTenant(tenantId: string): Promise<void>;
}
