/**
 * Pattern Store - Site profile and crawl pattern storage
 *
 * Exports:
 * - Interfaces: IPatternStore, StoredPattern, etc.
 * - Implementations: MongoPatternStore
 * - Errors: PatternStoreError
 */

export {
  // Core interface
  IPatternStore,

  // Data types
  StoredPattern,
  StorePatternInput,
  GetPatternOptions,
  FindPatternsQuery,
  CrawlCompletionUpdate,
  PatternStoreStats,

  // Error
  PatternStoreError,
} from './interfaces.js';

// Pattern store implementations
export { MongoPatternStore } from './mongo-pattern-store.js';
