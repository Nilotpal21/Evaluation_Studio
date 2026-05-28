/**
 * Inline Host Cleanup
 *
 * Lifecycle hook helper that deletes orphan transient auth profiles
 * created via inline-Add when the owning tool is deleted.
 *
 * Wired in Phase 4 by the tool-deletion route to satisfy FR-22
 * (cascade-delete on tool delete).
 */

import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('inline-host-cleanup');

/**
 * Delete all auth profiles where `inlineHostedTool.toolId` matches
 * the given toolId within the tenant scope.
 *
 * @returns The number of deleted auth profiles
 */
export async function cleanupInlineHostsForTool(
  toolId: string,
  ctx: { tenantId: string },
): Promise<{ deletedCount: number }> {
  log.warn('inline-host cleanup invoked for deprecated transient profile', {
    toolId,
    tenantId: ctx.tenantId,
  });
  try {
    const { AuthProfile } = await import('@agent-platform/database/models');

    const result = await (
      AuthProfile as {
        deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
      }
    ).deleteMany({
      tenantId: ctx.tenantId,
      'inlineHostedTool.toolId': toolId,
    });

    const deletedCount = result.deletedCount ?? 0;

    if (deletedCount > 0) {
      log.info('inline_hosted_profiles_cleaned_up', {
        toolId,
        tenantId: ctx.tenantId,
        deletedCount,
      });
    }

    return { deletedCount };
  } catch (err) {
    log.error('inline_host_cleanup_failed', {
      toolId,
      tenantId: ctx.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
