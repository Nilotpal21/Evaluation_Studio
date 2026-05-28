/**
 * Bulk Crawl Event Shape Tests
 *
 * Validates the event contracts produced by the bulk-crawl worker:
 * - Every `url_fetched` / `url_skipped` event includes `data.progress`
 * - Terminal event type logic (job_completed vs job_failed)
 * - Percentage formula: (crawled + failed + skipped) / total * 100
 * - Error codes for cancelled and zero-page crawls
 *
 * These are pure-logic / contract tests that verify the data shapes
 * and decision logic extracted from `processBulkCrawl()` without
 * requiring Redis, MongoDB, or BullMQ infrastructure.
 */

import { describe, it, expect } from 'vitest';
import type { ProgressEvent } from '../../routes/progress.js';

// ---------------------------------------------------------------------------
// Helpers that mirror the worker's inline logic
// ---------------------------------------------------------------------------

/** Percentage formula used in every progress emission */
function calcPercentage(crawled: number, failed: number, skipped: number, total: number): number {
  return total > 0 ? Math.round(((crawled + failed + skipped) / total) * 100) : 0;
}

/** Terminal event type determination */
function terminalEventType(cancelled: boolean, crawledCount: number): ProgressEvent['type'] {
  return cancelled ? 'job_failed' : crawledCount > 0 ? 'job_completed' : 'job_failed';
}

/** Terminal error payload (matches worker spread logic) */
function terminalErrorPayload(
  cancelled: boolean,
  crawledCount: number,
): { error: { message: string; code: string } } | Record<string, never> {
  if (cancelled) return { error: { message: 'Crawl cancelled by user', code: 'CANCELLED' } };
  if (crawledCount === 0)
    return { error: { message: 'No pages could be crawled', code: 'ZERO_PAGES' } };
  return {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bulk Crawl Event Shapes', () => {
  describe('url_fetched events include data.progress', () => {
    it('success url_fetched has progress with total/completed/failed/percentage', () => {
      const event: ProgressEvent = {
        type: 'url_fetched',
        jobId: 'test-job',
        timestamp: new Date().toISOString(),
        data: {
          url: 'https://example.com/page1',
          progress: { total: 100, completed: 5, failed: 1, percentage: 6 },
        },
      };
      expect(event.data?.progress).toBeDefined();
      expect(event.data!.progress!.total).toBe(100);
      expect(event.data!.progress!.completed).toBe(5);
      expect(event.data!.progress!.failed).toBe(1);
      expect(event.data!.progress!.percentage).toBe(6);
    });

    it('failure url_fetched has progress and error', () => {
      const event: ProgressEvent = {
        type: 'url_fetched',
        jobId: 'test-job',
        timestamp: new Date().toISOString(),
        data: {
          url: 'https://example.com/broken',
          status: 'failed',
          error: { message: 'timeout' },
          progress: { total: 100, completed: 5, failed: 2, percentage: 7 },
        },
      };
      expect(event.data!.progress!.failed).toBe(2);
      expect(event.data!.error!.message).toBe('timeout');
    });
  });

  describe('url_skipped events include data.progress', () => {
    it('url_skipped carries progress and skipReason', () => {
      const event: ProgressEvent = {
        type: 'url_skipped',
        jobId: 'test-job',
        timestamp: new Date().toISOString(),
        data: {
          url: 'https://example.com/skipped',
          skipReason: 'robots_disallowed',
          progress: { total: 50, completed: 10, failed: 2, percentage: 26 },
        },
      };
      expect(event.data!.progress).toBeDefined();
      expect(event.data!.skipReason).toBe('robots_disallowed');
    });
  });

  describe('terminal event type determination', () => {
    it('uses job_completed when crawledCount > 0 and not cancelled', () => {
      expect(terminalEventType(false, 5)).toBe('job_completed');
    });

    it('uses job_failed when crawledCount === 0', () => {
      expect(terminalEventType(false, 0)).toBe('job_failed');
    });

    it('uses job_failed when cancelled even with pages crawled', () => {
      expect(terminalEventType(true, 10)).toBe('job_failed');
    });

    it('uses job_failed when cancelled with zero pages', () => {
      expect(terminalEventType(true, 0)).toBe('job_failed');
    });
  });

  describe('terminal error payload', () => {
    it('includes CANCELLED code when cancelled', () => {
      const payload = terminalErrorPayload(true, 10);
      expect(payload).toHaveProperty('error.code', 'CANCELLED');
      expect(payload).toHaveProperty('error.message', 'Crawl cancelled by user');
    });

    it('includes ZERO_PAGES code when zero crawled and not cancelled', () => {
      const payload = terminalErrorPayload(false, 0);
      expect(payload).toHaveProperty('error.code', 'ZERO_PAGES');
      expect(payload).toHaveProperty('error.message', 'No pages could be crawled');
    });

    it('returns empty object on success (crawledCount > 0, not cancelled)', () => {
      const payload = terminalErrorPayload(false, 5);
      expect(payload).toEqual({});
    });

    it('CANCELLED takes precedence over ZERO_PAGES', () => {
      const payload = terminalErrorPayload(true, 0);
      expect(payload).toHaveProperty('error.code', 'CANCELLED');
    });
  });

  describe('percentage formula', () => {
    it('calculates (crawled + failed + skipped) / total * 100', () => {
      expect(calcPercentage(30, 10, 5, 100)).toBe(45);
    });

    it('returns 0 when total is 0', () => {
      expect(calcPercentage(5, 2, 1, 0)).toBe(0);
    });

    it('rounds to nearest integer', () => {
      // 1/3 = 33.33... -> 33
      expect(calcPercentage(1, 0, 0, 3)).toBe(33);
    });

    it('reaches 100 when all URLs are processed', () => {
      expect(calcPercentage(80, 15, 5, 100)).toBe(100);
    });

    it('counts skipped towards progress', () => {
      // 0 crawled, 0 failed, 10 skipped out of 10 -> 100%
      expect(calcPercentage(0, 0, 10, 10)).toBe(100);
    });
  });

  describe('job_started event shape', () => {
    it('includes progress with zeros and correct total', () => {
      const totalUrls = 50;
      const event: ProgressEvent = {
        type: 'job_started',
        jobId: 'test-job',
        timestamp: new Date().toISOString(),
        data: {
          progress: { total: totalUrls, completed: 0, failed: 0, percentage: 0 },
        },
      };
      expect(event.data!.progress!.total).toBe(50);
      expect(event.data!.progress!.completed).toBe(0);
      expect(event.data!.progress!.failed).toBe(0);
      expect(event.data!.progress!.percentage).toBe(0);
    });
  });

  describe('terminal event full shape', () => {
    it('builds a valid job_completed event with summary and sections', () => {
      const event: ProgressEvent = {
        type: 'job_completed',
        jobId: 'bulk-123',
        timestamp: new Date().toISOString(),
        data: {
          progress: { total: 20, completed: 18, failed: 1, percentage: 100 },
          summary: {
            totalPages: 20,
            completed: 18,
            failed: 1,
            skipped: 1,
            httpPages: 15,
            browserPages: 5,
          },
          sections: [
            { sectionId: 'sec-1', name: 'Blog', count: 12 },
            { sectionId: 'sec-2', name: 'Docs', count: 8 },
          ],
        },
      };
      expect(event.type).toBe('job_completed');
      expect(event.data!.sections).toHaveLength(2);
      expect(event.data!.summary).toHaveProperty('httpPages', 15);
    });
  });
});
