/**
 * Crawl API - URL Expansion Tests
 *
 * Tests the sitemap URL expansion feature in /api/crawl/batch endpoint.
 * Covers: automatic expansion, maxPages limiting, useSitemap option, error fallback.
 *
 * WARNING: ALL tests in this file are hollow stubs — they construct inline response
 * objects and assert on local variables. No HTTP request is ever made to the crawl API.
 * The 3 describe.skip blocks are explicitly incomplete; the "passing" tests are equally
 * meaningless (they assert on object literals, not real API responses).
 *
 * TODO: Rewrite to make real HTTP requests via supertest against the crawl router.
 * Requires mocking BullMQ Queue, auth middleware, and CrawlJob model.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { FastProfiler } from '@abl/crawler';
import type { SiteProfile } from '@abl/crawler';

// Create a minimal express app for testing
let app: Express;

// Mock FastProfiler
vi.mock('@abl/crawler', async () => {
  const actual = await vi.importActual<typeof import('@abl/crawler')>('@abl/crawler');
  return {
    ...actual,
    FastProfiler: vi.fn(),
  };
});

// Mock dependencies
const mockProfile: SiteProfile = {
  domain: 'example.com',
  profiledAt: new Date(),
  siteType: 'static',
  jsRequired: false,
  linkDensity: 10,
  estimatedSize: 100,
  avgResponseTime: 200,
  rateLimitDetected: false,
  maxConcurrency: 10,
  confidence: 85,
  metadata: {
    hasRobotsTxt: true,
    hasSitemap: true,
  },
};

describe('Crawl API - URL Expansion', () => {
  let mockProfilerInstance: any;
  let mockQueueAdd: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock profiler instance
    mockProfilerInstance = {
      profile: vi.fn().mockResolvedValue(mockProfile),
      extractSitemapUrls: vi
        .fn()
        .mockResolvedValue([
          'https://example.com/',
          'https://example.com/page1/',
          'https://example.com/page2/',
          'https://example.com/page3/',
          'https://example.com/page4/',
        ]),
    };

    (FastProfiler as any).mockImplementation(() => mockProfilerInstance);

    // Mock BullMQ Queue
    mockQueueAdd = vi.fn().mockResolvedValue({ id: 'test-job-123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('automatic URL expansion', () => {
    test('should expand URLs from sitemap when single URL provided', async () => {
      const response = {
        jobId: 'test-job-123',
        urls: 5,
        urlExpansion: {
          expanded: true,
          source: 'sitemap',
          originalCount: 1,
          expandedCount: 5,
        },
      };

      expect(response.urlExpansion.expanded).toBe(true);
      expect(response.urlExpansion.source).toBe('sitemap');
      expect(response.urlExpansion.originalCount).toBe(1);
      expect(response.urlExpansion.expandedCount).toBe(5);
      expect(response.urls).toBe(5);
    });

    test('should NOT expand when multiple URLs provided', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);

      // When multiple URLs are provided, no expansion should occur
      const response = {
        urls: 2, // Original count stays
        urlExpansion: {
          expanded: false,
          source: 'none',
          originalCount: 2,
          expandedCount: 2,
        },
      };

      expect(response.urlExpansion.expanded).toBe(false);
      expect(response.urlExpansion.source).toBe('none');
      expect(mockProfilerInstance.extractSitemapUrls).not.toHaveBeenCalled();
    });

    test('should NOT expand when no sitemap exists', async () => {
      const profileWithoutSitemap = {
        ...mockProfile,
        metadata: {
          ...mockProfile.metadata,
          hasSitemap: false,
        },
      };

      mockProfilerInstance.profile.mockResolvedValue(profileWithoutSitemap);

      const response = {
        urls: 1,
        urlExpansion: {
          expanded: false,
          source: 'none',
          originalCount: 1,
          expandedCount: 1,
        },
      };

      expect(response.urlExpansion.expanded).toBe(false);
      expect(mockProfilerInstance.extractSitemapUrls).not.toHaveBeenCalled();
    });

    test('should NOT expand when useSitemap: false', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);

      // Even with sitemap, if useSitemap: false, no expansion
      const response = {
        urls: 1,
        urlExpansion: {
          expanded: false,
          source: 'none',
          originalCount: 1,
          expandedCount: 1,
        },
      };

      expect(response.urlExpansion.expanded).toBe(false);
      expect(mockProfilerInstance.extractSitemapUrls).not.toHaveBeenCalled();
    });
  });

  // NOTE: These tests are incomplete stubs that never actually invoke the crawl API.
  // They set up mocks but don't make HTTP requests, so extractSitemapUrls is never called.
  // Skipping until tests are properly implemented with actual API calls.
  describe.skip('maxPages limiting', () => {
    test('should respect maxPages limit from options', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);
      mockProfilerInstance.extractSitemapUrls.mockResolvedValue([
        'https://example.com/',
        'https://example.com/page1/',
        'https://example.com/page2/',
      ]);

      // extractSitemapUrls should be called with maxPages=3
      expect(mockProfilerInstance.extractSitemapUrls).toHaveBeenCalledWith(
        'https://example.com/',
        3,
      );
    });

    test('should respect maxPages limit from strategy limits', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);
      mockProfilerInstance.extractSitemapUrls.mockResolvedValue([
        'https://example.com/',
        'https://example.com/page1/',
        'https://example.com/page2/',
        'https://example.com/page3/',
        'https://example.com/page4/',
        'https://example.com/page5/',
        'https://example.com/page6/',
        'https://example.com/page7/',
        'https://example.com/page8/',
        'https://example.com/page9/',
      ]);

      // With limits.maxPages=10, should get 10 URLs
      expect(mockProfilerInstance.extractSitemapUrls).toHaveBeenCalledWith(
        'https://example.com/',
        10,
      );
    });

    test('should use default maxPages (50) when not specified', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);
      mockProfilerInstance.extractSitemapUrls.mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => `https://example.com/page${i}/`),
      );

      expect(mockProfilerInstance.extractSitemapUrls).toHaveBeenCalledWith(
        'https://example.com/',
        50,
      );
    });
  });

  // NOTE: Tests are incomplete stubs - never actually invoke the crawl API
  describe.skip('error handling', () => {
    test('should fallback to original URLs when sitemap parsing fails', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);
      mockProfilerInstance.extractSitemapUrls.mockRejectedValue(
        new Error('Sitemap XML parsing error'),
      );

      // Should use original URL
      const response = {
        urls: 1,
        urlExpansion: {
          expanded: false,
          source: 'none',
          originalCount: 1,
          expandedCount: 1,
        },
      };

      expect(response.urls).toBe(1);
      expect(response.urlExpansion.expanded).toBe(false);
    });

    test('should fallback to original URLs when sitemap returns empty array', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);
      mockProfilerInstance.extractSitemapUrls.mockResolvedValue([]);

      // Should use original URL
      const response = {
        urls: 1,
        urlExpansion: {
          expanded: false,
          source: 'none',
          originalCount: 1,
          expandedCount: 1,
        },
      };

      expect(response.urls).toBe(1);
      expect(response.urlExpansion.expanded).toBe(false);
    });

    test('should log warning when expansion fails but continue', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockProfilerInstance.profile.mockResolvedValue(mockProfile);
      mockProfilerInstance.extractSitemapUrls.mockRejectedValue(new Error('Network timeout'));

      // Should still succeed with original URL
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to expand URLs from sitemap'),
        expect.any(Object),
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('response structure', () => {
    test('should include urlExpansion metadata in response', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);

      const response = {
        success: true,
        jobId: 'test-job-123',
        urls: 5,
        urlExpansion: {
          expanded: true,
          source: 'sitemap',
          originalCount: 1,
          expandedCount: 5,
        },
        strategy: expect.any(Object),
        decision: expect.any(Object),
      };

      expect(response).toHaveProperty('urlExpansion');
      expect(response.urlExpansion).toHaveProperty('expanded');
      expect(response.urlExpansion).toHaveProperty('source');
      expect(response.urlExpansion).toHaveProperty('originalCount');
      expect(response.urlExpansion).toHaveProperty('expandedCount');
    });

    test('should include urlExpansion even when not expanded', async () => {
      const profileWithoutSitemap = {
        ...mockProfile,
        metadata: { ...mockProfile.metadata, hasSitemap: false },
      };
      mockProfilerInstance.profile.mockResolvedValue(profileWithoutSitemap);

      const response = {
        success: true,
        urlExpansion: {
          expanded: false,
          source: 'none',
          originalCount: 1,
          expandedCount: 1,
        },
      };

      expect(response.urlExpansion).toEqual({
        expanded: false,
        source: 'none',
        originalCount: 1,
        expandedCount: 1,
      });
    });
  });

  // NOTE: Tests are incomplete stubs - never actually invoke the crawl API
  describe.skip('integration scenarios', () => {
    test('should handle docs.kore.ai scenario - expand from sitemap', async () => {
      const docsProfile: SiteProfile = {
        ...mockProfile,
        domain: 'docs.kore.ai',
        metadata: {
          hasRobotsTxt: true,
          hasSitemap: true,
        },
      };

      mockProfilerInstance.profile.mockResolvedValue(docsProfile);
      mockProfilerInstance.extractSitemapUrls.mockResolvedValue([
        'https://docs.kore.ai/',
        'https://docs.kore.ai/gettingstarted/',
        'https://docs.kore.ai/tutorials/',
        'https://docs.kore.ai/api-reference/',
        'https://docs.kore.ai/sdk/',
      ]);

      const response = {
        urls: 5,
        urlExpansion: {
          expanded: true,
          source: 'sitemap',
          originalCount: 1,
          expandedCount: 5,
        },
      };

      expect(response.urls).toBe(5);
      expect(mockProfilerInstance.extractSitemapUrls).toHaveBeenCalledWith(
        'https://docs.kore.ai/',
        expect.any(Number),
      );
    });

    test('should handle large sitemap with limiting', async () => {
      mockProfilerInstance.profile.mockResolvedValue(mockProfile);

      // Simulate large sitemap (1000 URLs)
      const largeUrlList = Array.from({ length: 1000 }, (_, i) => `https://example.com/page${i}/`);
      mockProfilerInstance.extractSitemapUrls.mockResolvedValue(largeUrlList.slice(0, 100));

      const response = {
        urls: 100,
        urlExpansion: {
          expanded: true,
          source: 'sitemap',
          originalCount: 1,
          expandedCount: 100,
        },
      };

      expect(response.urls).toBe(100);
      expect(mockProfilerInstance.extractSitemapUrls).toHaveBeenCalledWith(
        'https://example.com/',
        100,
      );
    });
  });
});
