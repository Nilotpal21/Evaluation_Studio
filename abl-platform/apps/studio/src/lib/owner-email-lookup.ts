/**
 * Owner email batch lookup
 *
 * Resolves a set of user ids to emails in a single Mongo query. Extracted so
 * project-scoped route lint heuristics (which require tenantId / projectId in
 * every query) don't false-positive on the global User collection (keyed by
 * email, no tenantId field). Mirrors the pattern used in workspace-repo and
 * project-member-repo.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('owner-email-lookup');

export async function resolveOwnerEmails(userIds: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueIds.length === 0) return result;

  try {
    const models = await import('@agent-platform/database/models');
    const userModel = models.User;
    const owners = (await userModel
      .find({ _id: { $in: uniqueIds } }, { _id: 1, email: 1 })
      .lean()) as Array<{ _id: string; email: string }>;
    for (const o of owners) result.set(String(o._id), o.email);
  } catch (err) {
    log.debug('Owner email batch lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}
