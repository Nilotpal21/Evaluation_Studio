/**
 * Pattern Store Interfaces
 *
 * Abstractions for storing and retrieving site profiles and crawl patterns.
 *
 * Design Principles:
 * - Interface Segregation: IPatternStore focused on pattern storage
 * - Dependency Inversion: Depend on abstraction, not implementation
 * - Single Responsibility: Pattern storage separated from profiling
 */

import { SiteProfile } from '../profiler/interfaces.js';

/**
 * Stored pattern with crawl metadata
 */
export interface StoredPattern {
  /** Unique pattern ID */
  id: string;

  /** Normalized domain */
  domain: string;

  /** Tenant ID for multi-tenancy */
  tenantId: string;

  /** Site profile data */
  profile: SiteProfile;

  /** Crawl performance metrics */
  crawlMetrics: {
    lastCrawlAt?: Date;
    totalCrawlsCompleted: number;
    avgCrawlDurationMs?: number;
    lastCrawlSuccess: boolean;
    lastCrawlError?: string;
  };

  /** When profile was created */
  profiledAt: Date;

  /** Last time pattern was accessed (for TTL) */
  lastAccessedAt: Date;

  /** When record was created */
  createdAt: Date;

  /** When record was last updated */
  updatedAt: Date;
}

/**
 * Input for storing a new pattern
 */
export interface StorePatternInput {
  domain: string;
  tenantId: string;
  profile: SiteProfile;
}

/**
 * Options for retrieving patterns
 */
export interface GetPatternOptions {
  /** Include patterns even if they're stale */
  includeStale?: boolean;

  /** Update lastAccessedAt on read */
  touch?: boolean;
}

/**
 * Query options for finding patterns
 */
export interface FindPatternsQuery {
  tenantId: string;
  siteType?: 'static' | 'spa' | 'hybrid' | 'unknown';
  framework?: string;
  minConfidence?: number;
  limit?: number;
  offset?: number;
}

/**
 * Update for crawl completion
 */
export interface CrawlCompletionUpdate {
  domain: string;
  tenantId: string;
  success: boolean;
  durationMs?: number;
  error?: string;
}

/**
 * Pattern Store statistics
 */
export interface PatternStoreStats {
  totalPatterns: number;
  patternsByType: Record<string, number>;
  patternsByFramework: Record<string, number>;
  avgConfidence: number;
  oldestPattern?: Date;
  newestPattern?: Date;
}

/**
 * IPatternStore - Interface for pattern storage
 */
export interface IPatternStore {
  /**
   * Store or update a pattern for a domain
   * Upserts based on (tenantId, domain) key
   */
  storePattern(input: StorePatternInput): Promise<StoredPattern>;

  /**
   * Get pattern for a specific domain
   * Returns null if not found or expired
   */
  getPattern(
    tenantId: string,
    domain: string,
    options?: GetPatternOptions,
  ): Promise<StoredPattern | null>;

  /**
   * Find patterns matching query
   */
  findPatterns(query: FindPatternsQuery): Promise<StoredPattern[]>;

  /**
   * Update pattern after crawl completion
   */
  updateCrawlMetrics(update: CrawlCompletionUpdate): Promise<void>;

  /**
   * Delete pattern for a domain
   */
  deletePattern(tenantId: string, domain: string): Promise<boolean>;

  /**
   * Get statistics for a tenant's patterns
   */
  getStats(tenantId: string): Promise<PatternStoreStats>;

  /**
   * Clear all patterns for a tenant
   */
  clearTenant(tenantId: string): Promise<number>;
}

/**
 * Pattern Store Error
 */
export class PatternStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'PatternStoreError';
  }
}
