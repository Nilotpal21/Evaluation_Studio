/**
 * Pure-function tests for CrawlProgressView and USP crawl-progress logic.
 *
 * Tests the data derivation logic without rendering components:
 * - Quality breakdown computation
 * - Failure grouping
 * - Display state derivation with crawl progress states
 * - Optimistic recrawlJobId → showCrawlProgress derivation
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import type { PageProgress } from '../../hooks/useMultiPageProgress';
import type { SearchAISource } from '../../api/search-ai';
import type { CrawlJob } from '../../api/crawl';
import {
  deriveDisplayState,
  resolveDisplayJob,
  filterJobsBySource,
  parseTabParam,
} from '../../components/search-ai/source-page/utils';

// ---------------------------------------------------------------------------
// Quality Breakdown — computeQuality (inlined since not exported)
// Mirrors the logic in CrawlProgressView.tsx
// ---------------------------------------------------------------------------

interface QualityBreakdown {
  good: number;
  thin: number;
  empty: number;
  unknown: number;
}

function computeQuality(pages: Record<string, PageProgress>): QualityBreakdown {
  const result: QualityBreakdown = { good: 0, thin: 0, empty: 0, unknown: 0 };
  for (const page of Object.values(pages)) {
    if (page.status !== 'completed' && page.status !== 'saved') continue;
    if (page.quality === 'good' || (page.qualityScore != null && page.qualityScore >= 0.5)) {
      result.good++;
    } else if (page.quality === 'thin' || (page.qualityScore != null && page.qualityScore > 0)) {
      result.thin++;
    } else if (page.quality === 'empty') {
      result.empty++;
    } else {
      result.unknown++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Failure Grouping — groupFailures (inlined since not exported)
// Mirrors the logic in CrawlProgressView.tsx
// ---------------------------------------------------------------------------

interface FailureGroup {
  reason: string;
  urls: string[];
}

function groupFailures(pages: Record<string, PageProgress>): FailureGroup[] {
  const groups = new Map<string, string[]>();
  for (const [url, page] of Object.entries(pages)) {
    if (page.status !== 'failed') continue;
    const reason = page.error ?? 'Unknown error';
    const existing = groups.get(reason);
    if (existing) {
      existing.push(url);
    } else {
      groups.set(reason, [url]);
    }
  }
  return Array.from(groups.entries())
    .map(([reason, urls]) => ({ reason, urls }))
    .sort((a, b) => b.urls.length - a.urls.length);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(overrides: Partial<PageProgress> = {}): PageProgress {
  return {
    url: 'https://example.com/page',
    status: 'completed',
    handlerReused: false,
    llmCalls: 0,
    ...overrides,
  };
}

function makeSource(overrides: Partial<SearchAISource> = {}): SearchAISource {
  return {
    _id: 'source-1',
    tenantId: 'tenant-1',
    indexId: 'index-1',
    name: 'https://example.com',
    sourceType: 'web',
    sourceConfig: {},
    status: 'active',
    extractionConfig: null,
    enrichmentConfig: null,
    syncSchedule: null,
    documentCount: 10,
    lastSyncAt: null,
    syncError: null,
    createdBy: null,
    crawlConfig: null,
    ...overrides,
  } as SearchAISource;
}

function makeJob(overrides: Partial<CrawlJob> = {}): CrawlJob {
  return {
    _id: 'job-1',
    sourceId: 'source-1',
    status: 'completed',
    urls: { total: 10, crawled: 10, failed: 0 },
    createdAt: '2026-05-20T00:00:00Z',
    ...overrides,
  } as CrawlJob;
}

// ═══════════════════════════════════════════════════════════════════════════
// computeQuality
// ═══════════════════════════════════════════════════════════════════════════

describe('computeQuality', () => {
  it('returns all zeros for empty pages', () => {
    expect(computeQuality({})).toEqual({ good: 0, thin: 0, empty: 0, unknown: 0 });
  });

  it('classifies good pages by quality string', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ quality: 'good' }),
      '/b': makePage({ quality: 'good' }),
    };
    expect(computeQuality(pages)).toEqual({ good: 2, thin: 0, empty: 0, unknown: 0 });
  });

  it('classifies good pages by qualityScore >= 0.5', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ qualityScore: 0.8 }),
      '/b': makePage({ qualityScore: 0.5 }),
    };
    expect(computeQuality(pages)).toEqual({ good: 2, thin: 0, empty: 0, unknown: 0 });
  });

  it('classifies thin pages by quality string', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ quality: 'thin' }),
    };
    expect(computeQuality(pages)).toEqual({ good: 0, thin: 1, empty: 0, unknown: 0 });
  });

  it('classifies thin pages by qualityScore > 0 and < 0.5', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ qualityScore: 0.3 }),
      '/b': makePage({ qualityScore: 0.1 }),
    };
    expect(computeQuality(pages)).toEqual({ good: 0, thin: 2, empty: 0, unknown: 0 });
  });

  it('classifies empty pages', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ quality: 'empty' }),
    };
    expect(computeQuality(pages)).toEqual({ good: 0, thin: 0, empty: 1, unknown: 0 });
  });

  it('classifies unknown when no quality info present', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({}), // status completed, no quality or qualityScore
    };
    expect(computeQuality(pages)).toEqual({ good: 0, thin: 0, empty: 0, unknown: 1 });
  });

  it('skips non-terminal pages (queued, analyzing, failed)', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ status: 'queued', quality: 'good' }),
      '/b': makePage({ status: 'analyzing', quality: 'good' }),
      '/c': makePage({ status: 'failed', quality: 'good' }),
    };
    expect(computeQuality(pages)).toEqual({ good: 0, thin: 0, empty: 0, unknown: 0 });
  });

  it('counts saved pages the same as completed', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ status: 'saved', quality: 'good' }),
    };
    expect(computeQuality(pages)).toEqual({ good: 1, thin: 0, empty: 0, unknown: 0 });
  });

  it('handles mixed quality distribution', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ quality: 'good' }),
      '/b': makePage({ quality: 'thin' }),
      '/c': makePage({ quality: 'empty' }),
      '/d': makePage({ qualityScore: 0.9 }),
      '/e': makePage({ qualityScore: 0.2 }),
      '/f': makePage({ status: 'failed' }), // not counted
    };
    expect(computeQuality(pages)).toEqual({ good: 2, thin: 2, empty: 1, unknown: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// groupFailures
// ═══════════════════════════════════════════════════════════════════════════

describe('groupFailures', () => {
  it('returns empty array for no failed pages', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ status: 'completed' }),
      '/b': makePage({ status: 'saved' }),
    };
    expect(groupFailures(pages)).toEqual([]);
  });

  it('groups failures by error reason', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ status: 'failed', error: 'Timeout' }),
      '/b': makePage({ status: 'failed', error: 'Timeout' }),
      '/c': makePage({ status: 'failed', error: '403 Forbidden' }),
    };
    const groups = groupFailures(pages);
    expect(groups).toHaveLength(2);
    // Sorted by count descending
    expect(groups[0].reason).toBe('Timeout');
    expect(groups[0].urls).toHaveLength(2);
    expect(groups[1].reason).toBe('403 Forbidden');
    expect(groups[1].urls).toHaveLength(1);
  });

  it('uses "Unknown error" when error is missing', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ status: 'failed' }), // no error field
    };
    const groups = groupFailures(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('Unknown error');
    expect(groups[0].urls).toEqual(['/a']);
  });

  it('ignores non-failed pages', () => {
    const pages: Record<string, PageProgress> = {
      '/a': makePage({ status: 'completed', error: 'This error should be ignored' }),
      '/b': makePage({ status: 'failed', error: 'Real error' }),
    };
    const groups = groupFailures(pages);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('Real error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deriveDisplayState — crawl progress scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe('deriveDisplayState', () => {
  it('returns idle for null source', () => {
    expect(deriveDisplayState(null, null)).toBe('idle');
  });

  it('returns configuring when source.status is configuring', () => {
    expect(deriveDisplayState(makeSource({ status: 'configuring' }), null)).toBe('configuring');
  });

  it('returns crawling for active job statuses', () => {
    for (const status of ['queued', 'crawling', 'ingesting', 'indexing']) {
      expect(deriveDisplayState(makeSource(), makeJob({ status }))).toBe('crawling');
    }
  });

  it('returns completed for completed job with no issues', () => {
    expect(
      deriveDisplayState(
        makeSource(),
        makeJob({ status: 'completed', urls: { total: 10, crawled: 10, failed: 0 } }),
      ),
    ).toBe('completed');
  });

  it('returns completed_with_issues when failed pages exceed threshold', () => {
    expect(
      deriveDisplayState(
        makeSource(),
        makeJob({ status: 'completed', urls: { total: 10, crawled: 10, failed: 2 } }),
      ),
    ).toBe('completed_with_issues');
  });

  it('returns failed for failed job', () => {
    expect(deriveDisplayState(makeSource(), makeJob({ status: 'failed' }))).toBe('failed');
  });

  it('returns cancelled for cancelled job', () => {
    expect(deriveDisplayState(makeSource(), makeJob({ status: 'cancelled' }))).toBe('cancelled');
  });

  it('returns idle when source is active but has no jobs', () => {
    expect(deriveDisplayState(makeSource({ status: 'active' }), null)).toBe('idle');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// USP Optimistic State Logic
// ═══════════════════════════════════════════════════════════════════════════

describe('USP optimistic crawl progress state', () => {
  // These test the pure logic used in UnifiedSourcePage

  describe('showCrawlProgress derivation', () => {
    it('shows progress when isCrawling is true', () => {
      const isCrawling = true;
      const recrawlJobId: string | null = null;
      const showCrawlProgress = isCrawling || recrawlJobId !== null;
      expect(showCrawlProgress).toBe(true);
    });

    it('shows progress during optimistic gap (recrawlJobId set, SWR not caught up)', () => {
      const isCrawling = false;
      const recrawlJobId: string | null = 'job-optimistic';
      const showCrawlProgress = isCrawling || recrawlJobId !== null;
      expect(showCrawlProgress).toBe(true);
    });

    it('hides progress when no active crawl and no optimistic state', () => {
      const isCrawling = false;
      const recrawlJobId: string | null = null;
      const showCrawlProgress = isCrawling || recrawlJobId !== null;
      expect(showCrawlProgress).toBe(false);
    });
  });

  describe('progressJobId derivation', () => {
    it('uses activeJobId when isCrawling (SWR caught up)', () => {
      const isCrawling = true;
      const activeJobId = 'job-swr';
      const recrawlJobId: string | null = null;
      const progressJobId = isCrawling ? activeJobId : recrawlJobId;
      expect(progressJobId).toBe('job-swr');
    });

    it('uses recrawlJobId during optimistic gap', () => {
      const isCrawling = false;
      const activeJobId = 'job-old-completed';
      const recrawlJobId: string | null = 'job-optimistic';
      const progressJobId = isCrawling ? activeJobId : recrawlJobId;
      expect(progressJobId).toBe('job-optimistic');
    });

    it('returns null when neither crawling nor optimistic', () => {
      const isCrawling = false;
      const activeJobId = 'job-completed';
      const recrawlJobId: string | null = null;
      const progressJobId = isCrawling ? activeJobId : recrawlJobId;
      expect(progressJobId).toBeNull();
    });
  });

  describe('recrawlJobId cleanup', () => {
    it('should clear recrawlJobId when isCrawling becomes true (SWR caught up)', () => {
      // Simulates: useEffect(() => { if (isCrawling && recrawlJobId) setRecrawlJobId(null) })
      let recrawlJobId: string | null = 'job-optimistic';
      const isCrawling = true;

      if (isCrawling && recrawlJobId) {
        recrawlJobId = null; // simulate setRecrawlJobId(null)
      }

      expect(recrawlJobId).toBeNull();
    });

    it('should NOT clear recrawlJobId when not yet crawling', () => {
      let recrawlJobId: string | null = 'job-optimistic';
      const isCrawling = false;

      if (isCrawling && recrawlJobId) {
        recrawlJobId = null;
      }

      expect(recrawlJobId).toBe('job-optimistic');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveDisplayJob
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveDisplayJob', () => {
  it('returns null for empty job list', () => {
    expect(resolveDisplayJob([], 'job-1')).toBeNull();
  });

  it('returns matched job by activeJobId', () => {
    const jobs = [makeJob({ _id: 'job-1' }), makeJob({ _id: 'job-2' })];
    expect(resolveDisplayJob(jobs, 'job-2')?._id).toBe('job-2');
  });

  it('falls back to first job if activeJobId not found', () => {
    const jobs = [makeJob({ _id: 'job-1' })];
    expect(resolveDisplayJob(jobs, 'nonexistent')?._id).toBe('job-1');
  });

  it('returns first job when activeJobId is null', () => {
    const jobs = [makeJob({ _id: 'job-latest' }), makeJob({ _id: 'job-old' })];
    expect(resolveDisplayJob(jobs, null)?._id).toBe('job-latest');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// filterJobsBySource
// ═══════════════════════════════════════════════════════════════════════════

describe('filterJobsBySource', () => {
  it('returns only jobs matching the sourceId', () => {
    const jobs = [
      makeJob({ _id: 'j1', sourceId: 'src-a' }),
      makeJob({ _id: 'j2', sourceId: 'src-b' }),
      makeJob({ _id: 'j3', sourceId: 'src-a' }),
    ];
    const filtered = filterJobsBySource(jobs, 'src-a');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((j) => j._id)).toEqual(['j1', 'j3']);
  });

  it('returns empty for no matches', () => {
    const jobs = [makeJob({ _id: 'j1', sourceId: 'src-a' })];
    expect(filterJobsBySource(jobs, 'src-other')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseTabParam
// ═══════════════════════════════════════════════════════════════════════════

describe('parseTabParam', () => {
  it('returns valid tab names', () => {
    expect(parseTabParam('pages')).toBe('pages');
    expect(parseTabParam('history')).toBe('history');
    expect(parseTabParam('settings')).toBe('settings');
  });

  it('returns default tab for invalid values', () => {
    expect(parseTabParam('invalid')).toBe('pages');
    expect(parseTabParam(null)).toBe('pages');
    expect(parseTabParam('')).toBe('pages');
  });
});
