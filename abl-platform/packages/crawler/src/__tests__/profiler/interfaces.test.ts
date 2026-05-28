/**
 * Interface contract tests for ISiteProfiler
 *
 * These tests ensure that all implementations of ISiteProfiler
 * follow the contract correctly
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  ISiteProfiler,
  SiteProfile,
  ProfilerError,
  ProfilerTimeoutError,
} from '../../profiler/interfaces.js';

/**
 * Mock implementation for testing interface contract
 */
class MockProfiler implements ISiteProfiler {
  constructor(private mockProfile: Partial<SiteProfile> = {}) {}

  async profile(url: string, options?: any): Promise<SiteProfile> {
    return {
      domain: new URL(url).hostname,
      profiledAt: new Date(),
      siteType: 'static',
      framework: undefined,
      jsRequired: false,
      linkDensity: 10,
      estimatedSize: 100,
      avgResponseTime: 200,
      rateLimitDetected: false,
      maxConcurrency: 10,
      confidence: 85,
      metadata: {},
      ...this.mockProfile,
    };
  }

  getName(): string {
    return 'mock-profiler';
  }

  getCapabilities() {
    return {
      canDetectFrameworks: true,
      canTestRateLimits: false,
      canEstimateSize: true,
      requiresBrowser: false,
      avgDurationMs: 1000,
    };
  }
}

describe('ISiteProfiler Interface Contract', () => {
  let profiler: ISiteProfiler;

  beforeEach(() => {
    profiler = new MockProfiler();
  });

  describe('profile() method', () => {
    test('returns valid SiteProfile', async () => {
      const profile = await profiler.profile('https://example.com');

      // Required fields
      expect(profile).toHaveProperty('domain');
      expect(profile).toHaveProperty('profiledAt');
      expect(profile).toHaveProperty('siteType');
      expect(profile).toHaveProperty('jsRequired');
      expect(profile).toHaveProperty('linkDensity');
      expect(profile).toHaveProperty('estimatedSize');
      expect(profile).toHaveProperty('avgResponseTime');
      expect(profile).toHaveProperty('rateLimitDetected');
      expect(profile).toHaveProperty('maxConcurrency');
      expect(profile).toHaveProperty('confidence');
      expect(profile).toHaveProperty('metadata');

      // Type checks
      expect(typeof profile.domain).toBe('string');
      expect(profile.profiledAt).toBeInstanceOf(Date);
      expect(['static', 'spa', 'hybrid', 'unknown']).toContain(profile.siteType);
      expect(typeof profile.jsRequired).toBe('boolean');
      expect(typeof profile.linkDensity).toBe('number');
      expect(typeof profile.estimatedSize).toBe('number');
      expect(typeof profile.avgResponseTime).toBe('number');
      expect(typeof profile.rateLimitDetected).toBe('boolean');
      expect(typeof profile.maxConcurrency).toBe('number');
      expect(typeof profile.confidence).toBe('number');
      expect(typeof profile.metadata).toBe('object');
    });

    test('confidence is between 0 and 100', async () => {
      const profile = await profiler.profile('https://example.com');
      expect(profile.confidence).toBeGreaterThanOrEqual(0);
      expect(profile.confidence).toBeLessThanOrEqual(100);
    });

    test('domain extracted from URL', async () => {
      const profile = await profiler.profile('https://example.com/path');
      expect(profile.domain).toBe('example.com');
    });

    test('profiledAt is recent', async () => {
      const before = new Date();
      const profile = await profiler.profile('https://example.com');
      const after = new Date();

      expect(profile.profiledAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(profile.profiledAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    test('accepts ProfileOptions', async () => {
      const profile = await profiler.profile('https://example.com', {
        timeout: 5000,
        useCache: false,
        thoroughness: 'quick',
        detectFramework: true,
        testRateLimits: false,
      });

      expect(profile).toBeDefined();
    });
  });

  describe('getName() method', () => {
    test('returns non-empty string', () => {
      const name = profiler.getName();
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    });
  });

  describe('getCapabilities() method', () => {
    test('returns valid capabilities object', () => {
      const caps = profiler.getCapabilities();

      expect(caps).toHaveProperty('canDetectFrameworks');
      expect(caps).toHaveProperty('canTestRateLimits');
      expect(caps).toHaveProperty('canEstimateSize');
      expect(caps).toHaveProperty('requiresBrowser');
      expect(caps).toHaveProperty('avgDurationMs');

      expect(typeof caps.canDetectFrameworks).toBe('boolean');
      expect(typeof caps.canTestRateLimits).toBe('boolean');
      expect(typeof caps.canEstimateSize).toBe('boolean');
      expect(typeof caps.requiresBrowser).toBe('boolean');
      expect(typeof caps.avgDurationMs).toBe('number');
      expect(caps.avgDurationMs).toBeGreaterThan(0);
    });
  });

  describe('Multiple implementations', () => {
    test('all implementations return valid SiteProfile', async () => {
      const implementations: ISiteProfiler[] = [
        new MockProfiler({ siteType: 'static' }),
        new MockProfiler({ siteType: 'spa' }),
        new MockProfiler({ siteType: 'hybrid' }),
      ];

      for (const impl of implementations) {
        const profile = await impl.profile('https://example.com');
        expect(profile.domain).toBe('example.com');
        expect(profile.confidence).toBeGreaterThanOrEqual(0);
        expect(profile.confidence).toBeLessThanOrEqual(100);
      }
    });

    test('implementations are interchangeable', async () => {
      const profiler1 = new MockProfiler({ confidence: 80 });
      const profiler2 = new MockProfiler({ confidence: 90 });

      const profile1 = await profiler1.profile('https://example.com');
      const profile2 = await profiler2.profile('https://example.com');

      expect(profile1.domain).toBe(profile2.domain);
      expect(profile1).toHaveProperty('siteType');
      expect(profile2).toHaveProperty('siteType');
    });
  });
});

describe('ProfilerTimeoutError', () => {
  test('creates error with correct properties', () => {
    const error = new ProfilerTimeoutError('https://example.com', 60000);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProfilerTimeoutError');
    expect(error.url).toBe('https://example.com');
    expect(error.timeoutMs).toBe(60000);
    expect(error.message).toContain('60000ms');
    expect(error.message).toContain('https://example.com');
  });
});

describe('ProfilerError', () => {
  test('creates error with message', () => {
    const error = new ProfilerError('Test error');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProfilerError');
    expect(error.message).toBe('Test error');
    expect(error.cause).toBeUndefined();
  });

  test('creates error with cause', () => {
    const cause = new Error('Original error');
    const error = new ProfilerError('Wrapped error', cause);

    expect(error.cause).toBe(cause);
    expect(error.cause.message).toBe('Original error');
  });
});
