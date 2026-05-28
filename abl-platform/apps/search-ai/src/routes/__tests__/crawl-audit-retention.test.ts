import { describe, expect, test, vi } from 'vitest';

import {
  CRAWL_AUDIT_CLASSIFICATION,
  deleteCrawlAuditForJob,
  shouldDeleteCrawlAuditWithJob,
} from '../../services/crawl-audit-policy.js';

describe('crawl audit retention policy', () => {
  test('crawl audit is explicitly classified as operational history', () => {
    expect(CRAWL_AUDIT_CLASSIFICATION).toBe('operational_history');
    expect(shouldDeleteCrawlAuditWithJob()).toBe(true);
  });

  test('crawl audit is deleted with the job when operational history is selected', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 3 });

    const deleted = await deleteCrawlAuditForJob(
      { deleteMany },
      { crawlJobId: 'job-1', tenantId: 'tenant-1' },
    );

    expect(deleted).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ crawlJobId: 'job-1', tenantId: 'tenant-1' });
  });
});
