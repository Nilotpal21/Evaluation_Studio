/**
 * MongoPatternStore tests
 *
 * Tests pattern storage, retrieval, updates, and queries
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MongoPatternStore } from '../../pattern-store/mongo-pattern-store.js';
import type { SiteProfile } from '../../profiler/interfaces.js';
import type { ICrawlPattern } from '@agent-platform/database/models';

// Mock the CrawlPattern model
vi.mock('@agent-platform/database/models', () => {
  const mockData = new Map<string, ICrawlPattern>();

  const CrawlPattern = {
    findOneAndUpdate: vi.fn(async (filter, update, options) => {
      const key = `${filter.tenantId}:${filter.domain}`;
      const existing = mockData.get(key);

      if (existing) {
        const updated = { ...existing, ...(update.$set || {}) };
        if (update.$currentDate) {
          updated.updatedAt = new Date();
        }
        mockData.set(key, updated);
        return options.new ? updated : existing;
      }

      if (options.upsert) {
        const newDoc: ICrawlPattern = {
          ...{
            _id: `pattern_${Math.random()}`,
            tenantId: filter.tenantId,
            domain: filter.domain,
            totalCrawlsCompleted: 0,
            lastCrawlSuccess: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            _v: 1,
          },
          ...(update.$setOnInsert || {}),
          ...(update.$set || {}),
        } as ICrawlPattern;
        mockData.set(key, newDoc);
        return newDoc;
      }

      return null;
    }),

    findOne: vi.fn((filter) => {
      const key = `${filter.tenantId}:${filter.domain}`;
      const result = mockData.get(key) || null;
      // Return a thenable query object (supports both await and chaining)
      const query: any = {
        lean: vi.fn(() => Promise.resolve(result)),
        then: (resolve: any) => Promise.resolve(result).then(resolve),
        catch: (reject: any) => Promise.resolve(result).catch(reject),
      };
      return query;
    }),

    find: vi.fn((filter) => {
      const results: ICrawlPattern[] = [];
      for (const [key, doc] of mockData.entries()) {
        if (doc.tenantId === filter.tenantId) {
          if (!filter.siteType || doc.siteType === filter.siteType) {
            if (!filter.framework || doc.framework === filter.framework) {
              if (!filter.confidence || doc.confidence >= filter.confidence.$gte) {
                results.push(doc);
              }
            }
          }
        }
      }
      // Return chained query methods
      const query = {
        sort: vi.fn(() => query),
        skip: vi.fn(() => query),
        limit: vi.fn(() => query),
        lean: vi.fn(() => Promise.resolve(results)),
      };
      return query;
    }),

    updateOne: vi.fn((filter, update) => {
      const result = () => {
        let existing: ICrawlPattern | undefined;
        let key: string | undefined;

        // Find by _id or by tenantId+domain
        if (filter._id) {
          for (const [k, doc] of mockData.entries()) {
            if (doc._id === filter._id) {
              existing = doc;
              key = k;
              break;
            }
          }
        } else if (filter.tenantId && filter.domain) {
          key = `${filter.tenantId}:${filter.domain}`;
          existing = mockData.get(key);
        }

        if (existing && key) {
          const updated = { ...existing };
          if (update.$set) {
            Object.assign(updated, update.$set);
          }
          if (update.$inc) {
            updated.totalCrawlsCompleted =
              (updated.totalCrawlsCompleted || 0) + (update.$inc.totalCrawlsCompleted || 0);
          }
          if (update.$unset) {
            delete (updated as any).lastCrawlError;
          }
          mockData.set(key, updated);
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      };
      // Return chainable query
      return {
        exec: vi.fn(() => Promise.resolve(result())),
      };
    }),

    deleteOne: vi.fn(async (filter) => {
      const key = `${filter.tenantId}:${filter.domain}`;
      const existed = mockData.has(key);
      mockData.delete(key);
      return { deletedCount: existed ? 1 : 0 };
    }),

    deleteMany: vi.fn(async (filter) => {
      let count = 0;
      const keysToDelete: string[] = [];
      for (const [key, doc] of mockData.entries()) {
        if (doc.tenantId === filter.tenantId) {
          keysToDelete.push(key);
          count++;
        }
      }
      keysToDelete.forEach((key) => mockData.delete(key));
      return { deletedCount: count };
    }),

    _mockData: mockData,
    _reset: () => mockData.clear(),
  };

  return { CrawlPattern };
});

import { CrawlPattern } from '@agent-platform/database/models';

describe('MongoPatternStore', () => {
  let store: MongoPatternStore;

  const mockProfile: SiteProfile = {
    domain: 'example.com',
    profiledAt: new Date('2025-01-01'),
    siteType: 'static',
    framework: undefined,
    jsRequired: false,
    linkDensity: 10,
    estimatedSize: 50,
    avgResponseTime: 500,
    rateLimitDetected: false,
    maxConcurrency: 10,
    confidence: 85,
    metadata: { hasRobotsTxt: true, hasSitemap: false },
  };

  beforeEach(() => {
    store = new MongoPatternStore();
    (CrawlPattern as any)._reset();
    vi.clearAllMocks();
  });

  describe('storePattern()', () => {
    test('stores a new pattern', async () => {
      const stored = await store.storePattern({
        domain: 'https://example.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      expect(stored.domain).toBe('example.com');
      expect(stored.tenantId).toBe('tenant1');
      expect(stored.profile.siteType).toBe('static');
      expect(stored.profile.confidence).toBe(85);
      expect(stored.crawlMetrics.totalCrawlsCompleted).toBe(0);
    });

    test('normalizes domain', async () => {
      const stored = await store.storePattern({
        domain: 'HTTPS://Example.COM/path',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      expect(stored.domain).toBe('example.com');
    });

    test('updates existing pattern', async () => {
      await store.storePattern({
        domain: 'example.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      const updatedProfile = { ...mockProfile, confidence: 95 };
      const stored = await store.storePattern({
        domain: 'example.com',
        tenantId: 'tenant1',
        profile: updatedProfile,
      });

      expect(stored.profile.confidence).toBe(95);
    });
  });

  describe('getPattern()', () => {
    test('retrieves existing pattern', async () => {
      await store.storePattern({
        domain: 'example.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      const pattern = await store.getPattern('tenant1', 'example.com');

      expect(pattern).not.toBeNull();
      expect(pattern!.domain).toBe('example.com');
      expect(pattern!.profile.siteType).toBe('static');
    });

    test('returns null for non-existent pattern', async () => {
      const pattern = await store.getPattern('tenant1', 'notfound.com');

      expect(pattern).toBeNull();
    });

    test('normalizes domain when retrieving', async () => {
      await store.storePattern({
        domain: 'example.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      const pattern = await store.getPattern('tenant1', 'HTTPS://EXAMPLE.COM');

      expect(pattern).not.toBeNull();
      expect(pattern!.domain).toBe('example.com');
    });

    test('respects tenant isolation', async () => {
      await store.storePattern({
        domain: 'example.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      const pattern = await store.getPattern('tenant2', 'example.com');

      expect(pattern).toBeNull();
    });
  });

  describe('findPatterns()', () => {
    beforeEach(async () => {
      await store.storePattern({
        domain: 'static1.com',
        tenantId: 'tenant1',
        profile: { ...mockProfile, siteType: 'static' },
      });

      await store.storePattern({
        domain: 'spa1.com',
        tenantId: 'tenant1',
        profile: { ...mockProfile, siteType: 'spa', framework: 'react' },
      });

      await store.storePattern({
        domain: 'hybrid1.com',
        tenantId: 'tenant1',
        profile: { ...mockProfile, siteType: 'hybrid', framework: 'next' },
      });

      await store.storePattern({
        domain: 'other.com',
        tenantId: 'tenant2',
        profile: mockProfile,
      });
    });

    test('finds all patterns for tenant', async () => {
      const patterns = await store.findPatterns({ tenantId: 'tenant1' });

      expect(patterns.length).toBe(3);
    });

    test('filters by siteType', async () => {
      const patterns = await store.findPatterns({
        tenantId: 'tenant1',
        siteType: 'spa',
      });

      expect(patterns.length).toBe(1);
      expect(patterns[0].profile.siteType).toBe('spa');
    });

    test('filters by framework', async () => {
      const patterns = await store.findPatterns({
        tenantId: 'tenant1',
        framework: 'next',
      });

      expect(patterns.length).toBe(1);
      expect(patterns[0].profile.framework).toBe('next');
    });

    test('filters by minConfidence', async () => {
      await store.storePattern({
        domain: 'low-confidence.com',
        tenantId: 'tenant1',
        profile: { ...mockProfile, confidence: 50 },
      });

      const patterns = await store.findPatterns({
        tenantId: 'tenant1',
        minConfidence: 80,
      });

      expect(patterns.length).toBe(3); // All except low-confidence
    });

    test('respects tenant isolation', async () => {
      const patterns = await store.findPatterns({ tenantId: 'tenant2' });

      expect(patterns.length).toBe(1);
      expect(patterns[0].domain).toBe('other.com');
    });
  });

  describe('updateCrawlMetrics()', () => {
    beforeEach(async () => {
      await store.storePattern({
        domain: 'example.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });
    });

    test('updates crawl metrics on success', async () => {
      await store.updateCrawlMetrics({
        domain: 'example.com',
        tenantId: 'tenant1',
        success: true,
        durationMs: 5000,
      });

      const pattern = await store.getPattern('tenant1', 'example.com');

      expect(pattern!.crawlMetrics.totalCrawlsCompleted).toBe(1);
      expect(pattern!.crawlMetrics.lastCrawlSuccess).toBe(true);
      expect(pattern!.crawlMetrics.avgCrawlDurationMs).toBe(5000);
    });

    test('updates crawl metrics on failure', async () => {
      await store.updateCrawlMetrics({
        domain: 'example.com',
        tenantId: 'tenant1',
        success: false,
        error: 'Timeout',
      });

      const pattern = await store.getPattern('tenant1', 'example.com');

      expect(pattern!.crawlMetrics.lastCrawlSuccess).toBe(false);
      expect(pattern!.crawlMetrics.lastCrawlError).toBe('Timeout');
    });

    test('calculates running average duration', async () => {
      await store.updateCrawlMetrics({
        domain: 'example.com',
        tenantId: 'tenant1',
        success: true,
        durationMs: 4000,
      });

      await store.updateCrawlMetrics({
        domain: 'example.com',
        tenantId: 'tenant1',
        success: true,
        durationMs: 6000,
      });

      const pattern = await store.getPattern('tenant1', 'example.com');

      expect(pattern!.crawlMetrics.avgCrawlDurationMs).toBe(5000); // (4000 + 6000) / 2
    });
  });

  describe('deletePattern()', () => {
    test('deletes existing pattern', async () => {
      await store.storePattern({
        domain: 'example.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      const deleted = await store.deletePattern('tenant1', 'example.com');

      expect(deleted).toBe(true);

      const pattern = await store.getPattern('tenant1', 'example.com');
      expect(pattern).toBeNull();
    });

    test('returns false for non-existent pattern', async () => {
      const deleted = await store.deletePattern('tenant1', 'notfound.com');

      expect(deleted).toBe(false);
    });
  });

  describe('getStats()', () => {
    beforeEach(async () => {
      await store.storePattern({
        domain: 'static1.com',
        tenantId: 'tenant1',
        profile: { ...mockProfile, siteType: 'static', confidence: 90 },
      });

      await store.storePattern({
        domain: 'static2.com',
        tenantId: 'tenant1',
        profile: { ...mockProfile, siteType: 'static', confidence: 80 },
      });

      await store.storePattern({
        domain: 'spa1.com',
        tenantId: 'tenant1',
        profile: {
          ...mockProfile,
          siteType: 'spa',
          framework: 'react',
          confidence: 95,
        },
      });
    });

    test('returns correct statistics', async () => {
      const stats = await store.getStats('tenant1');

      expect(stats.totalPatterns).toBe(3);
      expect(stats.patternsByType['static']).toBe(2);
      expect(stats.patternsByType['spa']).toBe(1);
      expect(stats.patternsByFramework['react']).toBe(1);
      expect(stats.avgConfidence).toBeCloseTo(88.33, 1); // (90 + 80 + 95) / 3
    });

    test('returns empty stats for tenant with no patterns', async () => {
      const stats = await store.getStats('tenant2');

      expect(stats.totalPatterns).toBe(0);
      expect(stats.avgConfidence).toBe(0);
    });
  });

  describe('clearTenant()', () => {
    test('clears all patterns for tenant', async () => {
      await store.storePattern({
        domain: 'site1.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      await store.storePattern({
        domain: 'site2.com',
        tenantId: 'tenant1',
        profile: mockProfile,
      });

      await store.storePattern({
        domain: 'site3.com',
        tenantId: 'tenant2',
        profile: mockProfile,
      });

      const deleted = await store.clearTenant('tenant1');

      expect(deleted).toBe(2);

      const patterns = await store.findPatterns({ tenantId: 'tenant1' });
      expect(patterns.length).toBe(0);

      const tenant2Patterns = await store.findPatterns({ tenantId: 'tenant2' });
      expect(tenant2Patterns.length).toBe(1);
    });
  });
});
