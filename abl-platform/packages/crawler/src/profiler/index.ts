/**
 * Site Profiler - Automatic site characterization
 *
 * Exports:
 * - Interfaces: ISiteProfiler, SiteProfile, ProfileOptions
 * - Errors: ProfilerError, ProfilerTimeoutError
 * - Implementations: FastProfiler (coming in next sub-task)
 */

export {
  // Core interfaces
  ISiteProfiler,
  SiteProfile,
  ProfileOptions,
  ProfilerCapabilities,

  // Error types
  ProfilerError,
  ProfilerTimeoutError,

  // Sitemap discovery types
  SitemapDiscoveryResult,
  SitemapDiscoveryStep,
  SitemapFile,
} from './interfaces.js';

// Profiler implementations
export { FastProfiler } from './fast-profiler.js';
export {
  CachedProfiler,
  CacheEntry,
  CacheStats,
  CachedProfilerOptions,
} from './cached-profiler.js';

// Factory
export {
  ProfilerFactory,
  createProfiler,
  createFastProfiler,
  createCachedProfiler,
  ProfilerType,
  ProfilerFactoryOptions,
} from './profiler-factory.js';
