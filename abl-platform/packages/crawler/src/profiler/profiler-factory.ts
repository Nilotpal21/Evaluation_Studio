/**
 * Profiler Factory - Centralized profiler instantiation
 *
 * Provides convenient factory functions for creating profilers
 * with common configurations.
 *
 * Responsibilities (Factory Pattern):
 * - Create profilers with sensible defaults
 * - Support common configuration patterns
 * - Centralize profiler instantiation logic
 * - Enable easy switching between profiler strategies
 *
 * Design Principles:
 * - Factory Pattern: Centralizes object creation
 * - Dependency Inversion: Returns ISiteProfiler interface
 * - Open/Closed: Easy to add new profiler types
 * - Single Responsibility: Only handles profiler creation
 */

import { ISiteProfiler } from './interfaces.js';
import { FastProfiler } from './fast-profiler.js';
import { CachedProfiler, CachedProfilerOptions } from './cached-profiler.js';

export type ProfilerType = 'fast' | 'cached' | 'custom';

export interface ProfilerFactoryOptions {
  /** Type of profiler to create */
  type?: ProfilerType;

  /** Cache options (only for 'cached' type) */
  cache?: CachedProfilerOptions;

  /** Custom profiler instance (only for 'custom' type) */
  customProfiler?: ISiteProfiler;
}

/**
 * ProfilerFactory - Factory for creating profiler instances
 */
export class ProfilerFactory {
  /**
   * Create a profiler with the specified configuration
   */
  static create(options: ProfilerFactoryOptions = {}): ISiteProfiler {
    const type = options.type ?? 'cached'; // Default to cached for best performance

    switch (type) {
      case 'fast':
        return new FastProfiler();

      case 'cached': {
        const baseProfiler = new FastProfiler();
        return new CachedProfiler(baseProfiler, options.cache);
      }

      case 'custom': {
        if (!options.customProfiler) {
          throw new Error('customProfiler option is required when type is "custom"');
        }
        return options.customProfiler;
      }

      default:
        throw new Error(`Unknown profiler type: ${type}`);
    }
  }

  /**
   * Create a fast (non-cached) profiler
   */
  static createFast(): ISiteProfiler {
    return new FastProfiler();
  }

  /**
   * Create a cached profiler with default settings
   */
  static createCached(options?: CachedProfilerOptions): ISiteProfiler {
    const baseProfiler = new FastProfiler();
    return new CachedProfiler(baseProfiler, options);
  }

  /**
   * Wrap a custom profiler with caching
   */
  static withCache(profiler: ISiteProfiler, options?: CachedProfilerOptions): ISiteProfiler {
    return new CachedProfiler(profiler, options);
  }
}

/**
 * Convenience function: Create default profiler (cached FastProfiler)
 */
export function createProfiler(options?: ProfilerFactoryOptions): ISiteProfiler {
  return ProfilerFactory.create(options);
}

/**
 * Convenience function: Create fast profiler
 */
export function createFastProfiler(): ISiteProfiler {
  return ProfilerFactory.createFast();
}

/**
 * Convenience function: Create cached profiler
 */
export function createCachedProfiler(options?: CachedProfilerOptions): ISiteProfiler {
  return ProfilerFactory.createCached(options);
}
