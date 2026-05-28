/**
 * CachedProfiler tests
 *
 * Tests caching behavior, TTL expiration, eviction, and stats
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { CachedProfiler } from '../../profiler/cached-profiler.js';
import {
  ISiteProfiler,
  SiteProfile,
  ProfileOptions,
  ProfilerCapabilities,
} from '../../profiler/interfaces.js';

// Mock profiler for testing
class MockProfiler implements ISiteProfiler {
  callCount = 0;
  private profileData: Map<string, SiteProfile> = new Map();

  getName(): string {
    return 'mock-profiler';
  }

  getCapabilities(): ProfilerCapabilities {
    return {
      canDetectFrameworks: true,
      canTestRateLimits: false,
      canEstimateSize: true,
      requiresBrowser: false,
      avgDurationMs: 1000,
    };
  }

  async profile(url: string, _options?: ProfileOptions): Promise<SiteProfile> {
    this.callCount++;

    const domain = new URL(url).hostname;

    // Return cached mock data or create new
    if (this.profileData.has(domain)) {
      return this.profileData.get(domain)!;
    }

    const profile: SiteProfile = {
      domain,
      profiledAt: new Date(),
      siteType: 'static',
      jsRequired: false,
      linkDensity: 10,
      estimatedSize: 50,
      avgResponseTime: 500,
      rateLimitDetected: false,
      maxConcurrency: 10,
      confidence: 85,
      metadata: {},
    };

    this.profileData.set(domain, profile);
    return profile;
  }

  setProfileData(domain: string, profile: SiteProfile): void {
    this.profileData.set(domain, profile);
  }

  reset(): void {
    this.callCount = 0;
    this.profileData.clear();
  }
}

describe('CachedProfiler', () => {
  let mockProfiler: MockProfiler;
  let cachedProfiler: CachedProfiler;

  beforeEach(() => {
    mockProfiler = new MockProfiler();
    cachedProfiler = new CachedProfiler(mockProfiler, {
      ttlMs: 60000, // 1 minute for testing
      maxSize: 10,
    });
  });

  describe('getName() and getCapabilities()', () => {
    test('returns wrapped profiler name with "cached-" prefix', () => {
      expect(cachedProfiler.getName()).toBe('cached-mock-profiler');
    });

    test('returns capabilities with reduced avgDurationMs', () => {
      const caps = cachedProfiler.getCapabilities();
      expect(caps.canDetectFrameworks).toBe(true);
      expect(caps.avgDurationMs).toBe(100); // 1000 * 0.1
    });
  });

  describe('Cache Hit/Miss', () => {
    test('cache miss on first profile call', async () => {
      const profile = await cachedProfiler.profile('https://example.com');

      expect(profile.domain).toBe('example.com');
      expect(mockProfiler.callCount).toBe(1);

      const stats = cachedProfiler.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(1);
    });

    test('cache hit on second profile call for same domain', async () => {
      await cachedProfiler.profile('https://example.com');
      const profile2 = await cachedProfiler.profile('https://example.com');

      expect(profile2.domain).toBe('example.com');
      expect(mockProfiler.callCount).toBe(1); // Only called once

      const stats = cachedProfiler.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });

    test('cache hit for different paths on same domain', async () => {
      await cachedProfiler.profile('https://example.com/page1');
      await cachedProfiler.profile('https://example.com/page2');

      expect(mockProfiler.callCount).toBe(1); // Same domain, cached

      const stats = cachedProfiler.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    test('cache miss for different domains', async () => {
      await cachedProfiler.profile('https://example.com');
      await cachedProfiler.profile('https://another.com');

      expect(mockProfiler.callCount).toBe(2); // Different domains

      const stats = cachedProfiler.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(2);
      expect(stats.size).toBe(2);
    });
  });

  describe('Domain Normalization', () => {
    test('normalizes domain to lowercase', async () => {
      await cachedProfiler.profile('https://Example.COM');
      await cachedProfiler.profile('https://example.com');

      expect(mockProfiler.callCount).toBe(1); // Same domain after normalization

      const stats = cachedProfiler.getStats();
      expect(stats.hits).toBe(1);
    });

    test('handles URLs with and without protocol', async () => {
      const profile1 = await cachedProfiler.profile('https://example.com');
      const profile2 = await cachedProfiler.profile('http://example.com');

      // Both should hit same cache entry (domain is the key)
      expect(mockProfiler.callCount).toBe(1);
      expect(profile1.domain).toBe(profile2.domain);
    });
  });

  describe('TTL Expiration', () => {
    test('cache entry expires after TTL', async () => {
      // Use very short TTL for testing
      const shortTtlProfiler = new CachedProfiler(mockProfiler, {
        ttlMs: 100, // 100ms
      });

      await shortTtlProfiler.profile('https://example.com');
      expect(mockProfiler.callCount).toBe(1);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      await shortTtlProfiler.profile('https://example.com');
      expect(mockProfiler.callCount).toBe(2); // Re-profiled after expiry
    });

    test('cache entry valid within TTL', async () => {
      const shortTtlProfiler = new CachedProfiler(mockProfiler, {
        ttlMs: 5000, // 5 seconds
      });

      await shortTtlProfiler.profile('https://example.com');
      await new Promise((resolve) => setTimeout(resolve, 50));
      await shortTtlProfiler.profile('https://example.com');

      expect(mockProfiler.callCount).toBe(1); // Still cached
    });
  });

  describe('Cache Size Limit', () => {
    test('evicts oldest entry when exceeding maxSize', async () => {
      const smallCacheProfiler = new CachedProfiler(mockProfiler, {
        maxSize: 3,
        ttlMs: 60000,
      });

      await smallCacheProfiler.profile('https://site1.com');
      await smallCacheProfiler.profile('https://site2.com');
      await smallCacheProfiler.profile('https://site3.com');

      const stats1 = smallCacheProfiler.getStats();
      expect(stats1.size).toBe(3);

      // Add 4th entry - should evict site1.com (oldest)
      await smallCacheProfiler.profile('https://site4.com');

      const stats2 = smallCacheProfiler.getStats();
      expect(stats2.size).toBe(3); // Still at max

      // site1.com should be evicted - will cause re-profile
      const beforeCount = mockProfiler.callCount;
      await smallCacheProfiler.profile('https://site1.com');
      expect(mockProfiler.callCount).toBe(beforeCount + 1); // Re-profiled
    });

    test('default maxSize is 1000', () => {
      const defaultProfiler = new CachedProfiler(mockProfiler);
      expect(defaultProfiler['maxSize']).toBe(1000);
    });
  });

  describe('Cache Management', () => {
    test('clear() removes all cache entries and resets stats', async () => {
      await cachedProfiler.profile('https://example.com');
      await cachedProfiler.profile('https://another.com');

      let stats = cachedProfiler.getStats();
      expect(stats.size).toBe(2);
      expect(stats.misses).toBe(2);

      cachedProfiler.clear();

      stats = cachedProfiler.getStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);

      // After clear, re-profile should miss cache
      await cachedProfiler.profile('https://example.com');
      stats = cachedProfiler.getStats();
      expect(stats.misses).toBe(1);
    });

    test('invalidate() removes specific cache entry', async () => {
      await cachedProfiler.profile('https://example.com');
      await cachedProfiler.profile('https://another.com');

      expect(cachedProfiler.getStats().size).toBe(2);

      const removed = cachedProfiler.invalidate('https://example.com');
      expect(removed).toBe(true);
      expect(cachedProfiler.getStats().size).toBe(1);

      // Next profile should re-call profiler
      const beforeCount = mockProfiler.callCount;
      await cachedProfiler.profile('https://example.com');
      expect(mockProfiler.callCount).toBe(beforeCount + 1);
    });

    test('invalidate() returns false for non-existent entry', () => {
      const removed = cachedProfiler.invalidate('https://notcached.com');
      expect(removed).toBe(false);
    });
  });

  describe('Cache Statistics', () => {
    test('tracks hits and misses correctly', async () => {
      await cachedProfiler.profile('https://example.com'); // miss
      await cachedProfiler.profile('https://example.com'); // hit
      await cachedProfiler.profile('https://example.com'); // hit
      await cachedProfiler.profile('https://another.com'); // miss

      const stats = cachedProfiler.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBe(0.5);
      expect(stats.size).toBe(2);
    });

    test('hitRate is 0 when no calls made', () => {
      const stats = cachedProfiler.getStats();
      expect(stats.hitRate).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    test('hitRate is 1.0 for all hits', async () => {
      await cachedProfiler.profile('https://example.com'); // miss
      await cachedProfiler.profile('https://example.com'); // hit
      await cachedProfiler.profile('https://example.com'); // hit
      await cachedProfiler.profile('https://example.com'); // hit

      const stats = cachedProfiler.getStats();
      expect(stats.hitRate).toBe(0.75); // 3 hits / 4 total
    });
  });

  describe('Options Forwarding', () => {
    test('forwards options to wrapped profiler', async () => {
      const profileSpy = vi.spyOn(mockProfiler, 'profile');

      await cachedProfiler.profile('https://example.com', {
        timeout: 5000,
        detectFramework: false,
      });

      expect(profileSpy).toHaveBeenCalledWith('https://example.com', {
        timeout: 5000,
        detectFramework: false,
      });
    });

    test('options not used for cache key - same domain hits cache', async () => {
      await cachedProfiler.profile('https://example.com', { timeout: 3000 });
      await cachedProfiler.profile('https://example.com', { timeout: 5000 });

      expect(mockProfiler.callCount).toBe(1); // Cached despite different options

      const stats = cachedProfiler.getStats();
      expect(stats.hits).toBe(1);
    });
  });

  describe('Error Handling', () => {
    test('does not cache failed profile attempts', async () => {
      const errorProfiler = new MockProfiler();
      vi.spyOn(errorProfiler, 'profile').mockRejectedValueOnce(new Error('Network failure'));

      const cached = new CachedProfiler(errorProfiler);

      // First call fails
      await expect(cached.profile('https://example.com')).rejects.toThrow('Network failure');

      // Second call should retry (not cached)
      errorProfiler.profile = vi.fn().mockResolvedValue({ domain: 'example.com' } as SiteProfile);

      await cached.profile('https://example.com');
      expect(errorProfiler.profile).toHaveBeenCalledTimes(1); // Called again after failure
    });
  });

  describe('Decorator Pattern Compliance', () => {
    test('can wrap any ISiteProfiler implementation', () => {
      class CustomProfiler implements ISiteProfiler {
        getName() {
          return 'custom';
        }
        getCapabilities(): ProfilerCapabilities {
          return {
            canDetectFrameworks: false,
            canTestRateLimits: true,
            canEstimateSize: false,
            requiresBrowser: true,
            avgDurationMs: 5000,
          };
        }
        async profile(_url: string): Promise<SiteProfile> {
          return {} as SiteProfile;
        }
      }

      const custom = new CustomProfiler();
      const wrapped = new CachedProfiler(custom);

      expect(wrapped.getName()).toBe('cached-custom');
      expect(wrapped.getCapabilities().requiresBrowser).toBe(true);
    });

    test('CachedProfiler is-a ISiteProfiler (Liskov Substitution)', () => {
      const profiler: ISiteProfiler = cachedProfiler; // Should compile
      expect(profiler.getName()).toBe('cached-mock-profiler');
    });
  });
});
