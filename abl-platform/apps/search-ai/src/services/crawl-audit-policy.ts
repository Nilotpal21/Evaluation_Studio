/**
 * Crawl audit retention policy.
 *
 * SearchAI crawl audit is currently treated as operational job history, not immutable
 * compliance audit. When a crawl job is deleted, its related history and audit events are
 * intentionally deleted with it so the UI and storage footprint stay consistent.
 */

export const CRAWL_AUDIT_CLASSIFICATION = 'operational_history' as const;

export function shouldDeleteCrawlAuditWithJob(): boolean {
  return CRAWL_AUDIT_CLASSIFICATION === 'operational_history';
}

export async function deleteCrawlAuditForJob(
  target:
    | { deleteMany: (filter: Record<string, unknown>) => Promise<unknown> }
    | ((filter: Record<string, unknown>) => Promise<unknown>),
  filter: Record<string, unknown>,
): Promise<boolean> {
  if (!shouldDeleteCrawlAuditWithJob()) {
    return false;
  }

  if (typeof target === 'function') {
    await target(filter);
  } else {
    await target.deleteMany(filter);
  }
  return true;
}
