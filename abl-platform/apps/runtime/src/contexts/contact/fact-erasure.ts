/**
 * Default `factErasure` port implementation for `CascadeDeleteContact`
 * (LLD §Phase 5, D-8).
 *
 * Purges every user-scope `Fact` document whose `userId` matches the
 * deleted contact. Workflow-scope and project-scope facts (stored under
 * the `userId='__project__'` sentinel) are NOT touched — the cascade does
 * not own shared project memory and must not delete it.
 *
 * The query is intentionally `tenantId + userId + scope='user'` rather
 * than scoping on `projectId`, because a contact may have facts across
 * multiple projects within a tenant and the cascade does not have a
 * canonical project list. The unique index on
 * `(tenantId, userId, projectId, scope, key)` already isolates these
 * documents per project, so a multi-project deleteMany is safe.
 *
 * v1 = contact-only erasure (D-8). Non-contact identities (`customerId`,
 * `anonymousId`, channel-artifact) are deferred to v1.1 and tracked in the
 * feature spec gap table as GAP-016.
 */

import { Fact } from '@agent-platform/database/models';

/**
 * Erase every user-scope fact owned by `contactId` within `tenantId`.
 * Returns the number of documents deleted (informational; the cascade
 * audit-logs it but does not gate on the count).
 *
 * Used as a port: callers wire this function into
 * `CascadeDeleteContact`'s constructor / `ContactContextDeps.factErasure`.
 * It must be safe to call on a contact with zero facts (returns
 * `{ erased: 0 }` — no error).
 */
export async function eraseUserScopedFacts(
  tenantId: string,
  contactId: string,
): Promise<{ erased: number }> {
  const result = await Fact.deleteMany({
    tenantId,
    userId: contactId,
    scope: 'user',
  });
  return { erased: result.deletedCount ?? 0 };
}
