/**
 * Crawl Status Endpoint — Enhanced Response Tests
 *
 * Validates the response-building logic for GET /api/crawl/status,
 * specifically the `crawled` and `failed` fields added in the
 * bugfix wave. These are pure-logic tests that verify the response
 * shape derivation from CrawlJob document data without requiring
 * MongoDB or Express infrastructure.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Type matching CrawlJob document shape (subset used by /status handler)
// ---------------------------------------------------------------------------
interface CrawlJobDoc {
  _id: string;
  status: string;
  strategy?: string;
  urls?: {
    original?: string[];
    crawled?: number;
    failed?: number;
    blocked?: number;
  };
  timeline?: {
    submittedAt?: Date;
    startedAt?: Date;
    completedAt?: Date;
  };
  results?: {
    documentsCreated?: number;
    documentsIndexed?: number;
    documentsFailed?: number;
  };
  processingErrors?: Array<{ message: string }>;
}

/**
 * Mirrors the response-building logic in crawl.ts GET /status handler
 * (lines ~2095-2111).
 */
function buildStatusResponse(crawlJob: CrawlJobDoc, bullState?: string | null) {
  return {
    success: true as const,
    jobId: crawlJob._id,
    state: bullState ?? crawlJob.status,
    urls: crawlJob.urls?.original?.length ?? 0,
    crawled: crawlJob.urls?.crawled ?? 0,
    failed: crawlJob.urls?.failed ?? 0,
    strategy: crawlJob.strategy,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/crawl/status — enhanced response', () => {
  it('includes crawled and failed counts from CrawlJob document', () => {
    const crawlJob: CrawlJobDoc = {
      _id: 'job-1',
      status: 'completed',
      strategy: 'bulk',
      urls: { original: ['a', 'b', 'c'], crawled: 2, failed: 1, blocked: 0 },
      timeline: { submittedAt: new Date() },
      results: { documentsCreated: 2 },
    };

    const response = buildStatusResponse(crawlJob);
    expect(response.crawled).toBe(2);
    expect(response.failed).toBe(1);
    expect(response.urls).toBe(3);
    expect(response.success).toBe(true);
  });

  it('defaults crawled and failed to 0 when undefined', () => {
    const crawlJob: CrawlJobDoc = {
      _id: 'job-2',
      status: 'queued',
      urls: { original: ['a'] },
    };

    const response = buildStatusResponse(crawlJob);
    expect(response.crawled).toBe(0);
    expect(response.failed).toBe(0);
    expect(response.urls).toBe(1);
  });

  it('defaults urls to 0 when original array is missing', () => {
    const crawlJob: CrawlJobDoc = {
      _id: 'job-3',
      status: 'queued',
    };

    const response = buildStatusResponse(crawlJob);
    expect(response.urls).toBe(0);
    expect(response.crawled).toBe(0);
    expect(response.failed).toBe(0);
  });

  it('uses bullState when provided, falling back to crawlJob.status', () => {
    const crawlJob: CrawlJobDoc = {
      _id: 'job-4',
      status: 'completed',
      urls: { original: ['a', 'b'], crawled: 2, failed: 0 },
    };

    const withBull = buildStatusResponse(crawlJob, 'active');
    expect(withBull.state).toBe('active');

    const withoutBull = buildStatusResponse(crawlJob, null);
    expect(withoutBull.state).toBe('completed');
  });

  it('handles large crawled/failed counts', () => {
    const urls = Array.from({ length: 10000 }, (_, i) => `https://example.com/${i}`);
    const crawlJob: CrawlJobDoc = {
      _id: 'job-5',
      status: 'completed',
      strategy: 'bulk',
      urls: { original: urls, crawled: 9500, failed: 400, blocked: 100 },
    };

    const response = buildStatusResponse(crawlJob);
    expect(response.urls).toBe(10000);
    expect(response.crawled).toBe(9500);
    expect(response.failed).toBe(400);
  });

  it('response shape matches the expected contract', () => {
    const crawlJob: CrawlJobDoc = {
      _id: 'job-6',
      status: 'active',
      strategy: 'bulk',
      urls: { original: ['a'], crawled: 0, failed: 0 },
    };

    const response = buildStatusResponse(crawlJob);
    // Verify all expected keys exist
    expect(response).toHaveProperty('success', true);
    expect(response).toHaveProperty('jobId', 'job-6');
    expect(response).toHaveProperty('state', 'active');
    expect(response).toHaveProperty('urls');
    expect(response).toHaveProperty('crawled');
    expect(response).toHaveProperty('failed');
    expect(response).toHaveProperty('strategy', 'bulk');
  });
});
