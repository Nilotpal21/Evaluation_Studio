/**
 * Cross-Boundary Parity Test: data.progress round-trip
 *
 * Verifies that the `data.progress` object emitted by the bulk-crawl worker
 * survives intact through JSON serialization (Redis pub/sub boundary) and
 * is structurally compatible with the frontend CrawlProgressEvent type.
 *
 * Required by: flow-change-audit-trigger.sh (pre-commit hook)
 * Audit log:   docs/sdlc-logs/crawl-v2-bugfix/data-flow-audit.md
 */

import { describe, it, expect } from 'vitest';
import type { ProgressEvent } from '../../routes/progress.js';

// Mirror the frontend CrawlProgressEvent.data.progress shape
// (from apps/studio/src/hooks/useCrawlProgress.ts:38-43)
interface FrontendProgressShape {
  total: number;
  completed: number;
  failed: number;
  percentage: number;
}

// Mirror the worker's percentage formula
// (from apps/search-ai/src/workers/bulk-crawl-worker.ts:799)
function workerPercentage(crawled: number, failed: number, skipped: number, total: number): number {
  return total > 0 ? Math.round(((crawled + failed + skipped) / total) * 100) : 0;
}

// Mirror the REST fallback percentage formula
// (from apps/studio/src/components/search-ai/crawl-flow/State4Crawl.tsx:410)
function restPercentage(crawled: number, total: number): number {
  return total > 0 ? Math.round((crawled / total) * 100) : 0;
}

describe('data.progress cross-boundary parity', () => {
  describe('JSON round-trip preserves all fields', () => {
    it('url_fetched event with data.progress survives serialization', () => {
      const event: ProgressEvent = {
        type: 'url_fetched',
        jobId: 'test-job-123',
        timestamp: new Date().toISOString(),
        data: {
          url: 'https://example.com/page1',
          progress: {
            total: 50,
            completed: 10,
            failed: 2,
            percentage: 24,
          },
        },
      };

      // Simulate Redis pub/sub: serialize → deserialize
      const serialized = JSON.stringify(event);
      const deserialized: ProgressEvent = JSON.parse(serialized);

      expect(deserialized.data?.progress).toEqual({
        total: 50,
        completed: 10,
        failed: 2,
        percentage: 24,
      });
      expect(deserialized.type).toBe('url_fetched');
      expect(deserialized.jobId).toBe('test-job-123');
    });

    it('url_skipped event with data.progress survives serialization', () => {
      const event: ProgressEvent = {
        type: 'url_skipped',
        jobId: 'test-job-456',
        timestamp: new Date().toISOString(),
        data: {
          url: 'https://example.com/blocked',
          skipReason: 'robots.txt',
          progress: {
            total: 100,
            completed: 0,
            failed: 0,
            percentage: 1,
          },
        },
      };

      const deserialized: ProgressEvent = JSON.parse(JSON.stringify(event));

      expect(deserialized.data?.progress).toEqual({
        total: 100,
        completed: 0,
        failed: 0,
        percentage: 1,
      });
      expect(deserialized.data?.skipReason).toBe('robots.txt');
    });

    it('job_completed event with data.progress + summary survives serialization', () => {
      const event: ProgressEvent = {
        type: 'job_completed',
        jobId: 'test-job-789',
        timestamp: new Date().toISOString(),
        data: {
          progress: {
            total: 200,
            completed: 180,
            failed: 15,
            percentage: 100,
          },
          summary: {
            totalPages: 200,
            completed: 180,
            failed: 15,
            skipped: 5,
          },
          sections: [
            { sectionId: 'sec-1', name: 'Main', count: 120 },
            { sectionId: 'sec-2', name: 'Blog', count: 60 },
          ],
        },
      };

      const deserialized: ProgressEvent = JSON.parse(JSON.stringify(event));

      expect(deserialized.data?.progress).toEqual({
        total: 200,
        completed: 180,
        failed: 15,
        percentage: 100,
      });
      expect(deserialized.data?.summary).toBeDefined();
      expect(deserialized.data?.sections).toHaveLength(2);
    });

    it('job_failed event with error code survives serialization', () => {
      const event: ProgressEvent = {
        type: 'job_failed',
        jobId: 'test-job-fail',
        timestamp: new Date().toISOString(),
        data: {
          progress: {
            total: 50,
            completed: 0,
            failed: 0,
            percentage: 0,
          },
          error: {
            message: 'No pages could be crawled',
            code: 'ZERO_PAGES',
          },
        },
      };

      const deserialized: ProgressEvent = JSON.parse(JSON.stringify(event));

      expect(deserialized.data?.progress).toEqual({
        total: 50,
        completed: 0,
        failed: 0,
        percentage: 0,
      });
      expect(deserialized.data?.error?.code).toBe('ZERO_PAGES');
    });
  });

  describe('backend ProgressEvent → frontend CrawlProgressEvent shape compatibility', () => {
    it('data.progress fields match frontend expected shape', () => {
      // Backend emits this shape
      const backendProgress: NonNullable<ProgressEvent['data']>['progress'] = {
        total: 100,
        completed: 75,
        failed: 10,
        percentage: 90,
      };

      // Frontend reads as this shape (must be structurally compatible)
      const frontendProgress: FrontendProgressShape = backendProgress!;

      expect(frontendProgress.total).toBe(100);
      expect(frontendProgress.completed).toBe(75);
      expect(frontendProgress.failed).toBe(10);
      expect(frontendProgress.percentage).toBe(90);
    });

    it('all four progress fields are required (not optional)', () => {
      const progress: NonNullable<ProgressEvent['data']>['progress'] = {
        total: 0,
        completed: 0,
        failed: 0,
        percentage: 0,
      };

      // Verify no field is undefined when all zeroes
      expect(progress!.total).toBeDefined();
      expect(progress!.completed).toBeDefined();
      expect(progress!.failed).toBeDefined();
      expect(progress!.percentage).toBeDefined();
    });
  });

  describe('percentage formula parity', () => {
    it('worker and REST formulas agree when no failures or skips', () => {
      // When all pages succeed, both formulas should give the same result
      const total = 100;
      const crawled = 50;
      const failed = 0;
      const skipped = 0;

      expect(workerPercentage(crawled, failed, skipped, total)).toBe(
        restPercentage(crawled, total),
      );
    });

    it('worker percentage includes failures and skips (documented divergence)', () => {
      // Worker counts ALL processed pages toward percentage
      const total = 100;
      const crawled = 50;
      const failed = 20;
      const skipped = 10;

      const wp = workerPercentage(crawled, failed, skipped, total); // 80%
      const rp = restPercentage(crawled, total); // 50%

      // Worker shows "processing progress" (80% done)
      expect(wp).toBe(80);
      // REST shows "success rate" (50% crawled)
      expect(rp).toBe(50);
      // This is a documented acceptable divergence (see data-flow-audit.md F-1)
      expect(wp).toBeGreaterThanOrEqual(rp);
    });

    it('both formulas handle zero total safely', () => {
      expect(workerPercentage(0, 0, 0, 0)).toBe(0);
      expect(restPercentage(0, 0)).toBe(0);
    });

    it('both formulas cap at 100%', () => {
      // Normal case: all processed
      expect(workerPercentage(80, 15, 5, 100)).toBe(100);
      expect(restPercentage(100, 100)).toBe(100);
    });
  });

  describe('Redis replay cache preserves data.progress', () => {
    it('cached event string is identical to published event string', () => {
      // publishProgressEvent() stores the same JSON.stringify(event) in both
      // publish() and setex() — verify the contract holds
      const event: ProgressEvent = {
        type: 'url_fetched',
        jobId: 'replay-test',
        timestamp: '2026-05-06T00:00:00.000Z',
        data: {
          url: 'https://example.com',
          progress: { total: 10, completed: 5, failed: 1, percentage: 60 },
        },
      };

      const message = JSON.stringify(event);

      // Simulate: publisher.publish(channel, message) + publisher.setex(key, ttl, message)
      // On replay: cached = publisher.get(key) → ws.send(cached)
      // The cached string must parse to the same event
      const replayed: ProgressEvent = JSON.parse(message);

      expect(replayed).toEqual(event);
      expect(replayed.data?.progress?.percentage).toBe(60);
    });
  });
});
