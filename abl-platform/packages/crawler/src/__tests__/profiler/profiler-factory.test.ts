/**
 * ProfilerFactory tests
 *
 * Tests factory methods and profiler creation
 */

import { describe, test, expect } from 'vitest';
import {
  ProfilerFactory,
  createProfiler,
  createFastProfiler,
  createCachedProfiler,
} from '../../profiler/profiler-factory.js';
import { ISiteProfiler, ProfilerCapabilities } from '../../profiler/interfaces.js';
import { FastProfiler } from '../../profiler/fast-profiler.js';
import { CachedProfiler } from '../../profiler/cached-profiler.js';

describe('ProfilerFactory', () => {
  describe('create()', () => {
    test('creates cached profiler by default', () => {
      const profiler = ProfilerFactory.create();

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect(profiler.getName()).toBe('cached-fast-profiler');
    });

    test('creates fast profiler when type is "fast"', () => {
      const profiler = ProfilerFactory.create({ type: 'fast' });

      expect(profiler).toBeInstanceOf(FastProfiler);
      expect(profiler.getName()).toBe('fast-profiler');
    });

    test('creates cached profiler when type is "cached"', () => {
      const profiler = ProfilerFactory.create({ type: 'cached' });

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect(profiler.getName()).toBe('cached-fast-profiler');
    });

    test('creates cached profiler with custom cache options', () => {
      const profiler = ProfilerFactory.create({
        type: 'cached',
        cache: {
          ttlMs: 5000,
          maxSize: 50,
        },
      });

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect((profiler as any).ttlMs).toBe(5000);
      expect((profiler as any).maxSize).toBe(50);
    });

    test('creates custom profiler when type is "custom"', () => {
      class CustomProfiler implements ISiteProfiler {
        getName() {
          return 'my-custom-profiler';
        }
        getCapabilities(): ProfilerCapabilities {
          return {
            canDetectFrameworks: false,
            canTestRateLimits: false,
            canEstimateSize: false,
            requiresBrowser: false,
            avgDurationMs: 100,
          };
        }
        async profile() {
          return {} as any;
        }
      }

      const custom = new CustomProfiler();
      const profiler = ProfilerFactory.create({
        type: 'custom',
        customProfiler: custom,
      });

      expect(profiler).toBe(custom);
      expect(profiler.getName()).toBe('my-custom-profiler');
    });

    test('throws error when custom type without customProfiler', () => {
      expect(() => {
        ProfilerFactory.create({ type: 'custom' });
      }).toThrow('customProfiler option is required when type is "custom"');
    });

    test('throws error for unknown profiler type', () => {
      expect(() => {
        ProfilerFactory.create({ type: 'unknown' as any });
      }).toThrow('Unknown profiler type: unknown');
    });
  });

  describe('createFast()', () => {
    test('creates fast profiler', () => {
      const profiler = ProfilerFactory.createFast();

      expect(profiler).toBeInstanceOf(FastProfiler);
      expect(profiler.getName()).toBe('fast-profiler');
    });

    test('returns ISiteProfiler interface', () => {
      const profiler: ISiteProfiler = ProfilerFactory.createFast();
      expect(profiler.getName()).toBe('fast-profiler');
    });
  });

  describe('createCached()', () => {
    test('creates cached profiler with default options', () => {
      const profiler = ProfilerFactory.createCached();

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect(profiler.getName()).toBe('cached-fast-profiler');
    });

    test('creates cached profiler with custom TTL', () => {
      const profiler = ProfilerFactory.createCached({ ttlMs: 30000 });

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect((profiler as any).ttlMs).toBe(30000);
    });

    test('creates cached profiler with custom maxSize', () => {
      const profiler = ProfilerFactory.createCached({ maxSize: 500 });

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect((profiler as any).maxSize).toBe(500);
    });

    test('creates cached profiler with all custom options', () => {
      const profiler = ProfilerFactory.createCached({
        ttlMs: 10000,
        maxSize: 100,
      });

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect((profiler as any).ttlMs).toBe(10000);
      expect((profiler as any).maxSize).toBe(100);
    });
  });

  describe('withCache()', () => {
    test('wraps profiler with caching', () => {
      const fast = new FastProfiler();
      const cached = ProfilerFactory.withCache(fast);

      expect(cached).toBeInstanceOf(CachedProfiler);
      expect(cached.getName()).toBe('cached-fast-profiler');
    });

    test('wraps custom profiler with caching', () => {
      class CustomProfiler implements ISiteProfiler {
        getName() {
          return 'custom';
        }
        getCapabilities(): ProfilerCapabilities {
          return {
            canDetectFrameworks: true,
            canTestRateLimits: false,
            canEstimateSize: true,
            requiresBrowser: false,
            avgDurationMs: 2000,
          };
        }
        async profile() {
          return {} as any;
        }
      }

      const custom = new CustomProfiler();
      const cached = ProfilerFactory.withCache(custom);

      expect(cached).toBeInstanceOf(CachedProfiler);
      expect(cached.getName()).toBe('cached-custom');
    });

    test('accepts cache options', () => {
      const fast = new FastProfiler();
      const cached = ProfilerFactory.withCache(fast, {
        ttlMs: 15000,
        maxSize: 200,
      });

      expect((cached as any).ttlMs).toBe(15000);
      expect((cached as any).maxSize).toBe(200);
    });
  });

  describe('Convenience Functions', () => {
    describe('createProfiler()', () => {
      test('creates cached profiler by default', () => {
        const profiler = createProfiler();

        expect(profiler).toBeInstanceOf(CachedProfiler);
        expect(profiler.getName()).toBe('cached-fast-profiler');
      });

      test('accepts options', () => {
        const profiler = createProfiler({ type: 'fast' });

        expect(profiler).toBeInstanceOf(FastProfiler);
        expect(profiler.getName()).toBe('fast-profiler');
      });
    });

    describe('createFastProfiler()', () => {
      test('creates fast profiler', () => {
        const profiler = createFastProfiler();

        expect(profiler).toBeInstanceOf(FastProfiler);
        expect(profiler.getName()).toBe('fast-profiler');
      });
    });

    describe('createCachedProfiler()', () => {
      test('creates cached profiler', () => {
        const profiler = createCachedProfiler();

        expect(profiler).toBeInstanceOf(CachedProfiler);
        expect(profiler.getName()).toBe('cached-fast-profiler');
      });

      test('accepts cache options', () => {
        const profiler = createCachedProfiler({
          ttlMs: 20000,
          maxSize: 300,
        });

        expect((profiler as any).ttlMs).toBe(20000);
        expect((profiler as any).maxSize).toBe(300);
      });
    });
  });

  describe('Return Type Compliance', () => {
    test('all factory methods return ISiteProfiler', () => {
      const profiler1: ISiteProfiler = ProfilerFactory.create();
      const profiler2: ISiteProfiler = ProfilerFactory.createFast();
      const profiler3: ISiteProfiler = ProfilerFactory.createCached();
      const profiler4: ISiteProfiler = createProfiler();
      const profiler5: ISiteProfiler = createFastProfiler();
      const profiler6: ISiteProfiler = createCachedProfiler();

      expect(profiler1).toBeDefined();
      expect(profiler2).toBeDefined();
      expect(profiler3).toBeDefined();
      expect(profiler4).toBeDefined();
      expect(profiler5).toBeDefined();
      expect(profiler6).toBeDefined();
    });

    test('can call profile() on all created profilers', async () => {
      const profilers = [
        ProfilerFactory.create(),
        ProfilerFactory.createFast(),
        ProfilerFactory.createCached(),
        createProfiler(),
        createFastProfiler(),
        createCachedProfiler(),
      ];

      for (const profiler of profilers) {
        expect(typeof profiler.profile).toBe('function');
        expect(typeof profiler.getName).toBe('function');
        expect(typeof profiler.getCapabilities).toBe('function');
      }
    });
  });

  describe('Factory Pattern Benefits', () => {
    test('centralizes profiler creation logic', () => {
      // All profilers created through factory
      const profiler1 = ProfilerFactory.create({ type: 'fast' });
      const profiler2 = ProfilerFactory.create({ type: 'cached' });

      // Easy to switch between implementations
      expect(profiler1.getName()).toBe('fast-profiler');
      expect(profiler2.getName()).toBe('cached-fast-profiler');
    });

    test('provides sensible defaults', () => {
      // No options = best default (cached profiler)
      const profiler = ProfilerFactory.create();

      expect(profiler).toBeInstanceOf(CachedProfiler);
      expect(profiler.getName()).toContain('cached');
    });

    test('enables easy testing with custom profilers', () => {
      class MockProfiler implements ISiteProfiler {
        getName() {
          return 'mock';
        }
        getCapabilities(): ProfilerCapabilities {
          return {
            canDetectFrameworks: false,
            canTestRateLimits: false,
            canEstimateSize: false,
            requiresBrowser: false,
            avgDurationMs: 1,
          };
        }
        async profile() {
          return {
            domain: 'test.com',
            profiledAt: new Date(),
            siteType: 'static',
            jsRequired: false,
            linkDensity: 0,
            estimatedSize: 1,
            avgResponseTime: 1,
            rateLimitDetected: false,
            maxConcurrency: 1,
            confidence: 100,
            metadata: {},
          };
        }
      }

      const mock = new MockProfiler();
      const profiler = ProfilerFactory.create({
        type: 'custom',
        customProfiler: mock,
      });

      expect(profiler).toBe(mock);
    });
  });
});
