/**
 * MongoDB Pattern Store Implementation
 *
 * Stores site profiles and crawl patterns in MongoDB using the CrawlPattern model.
 *
 * Responsibilities (Single Responsibility Principle):
 * - Convert between SiteProfile and CrawlPattern document
 * - Upsert patterns with atomic updates
 * - Query patterns with proper filtering
 * - Maintain lastAccessedAt for TTL
 * - Track crawl metrics
 *
 * Design Principles:
 * - Dependency Inversion: Implements IPatternStore interface
 * - Single Responsibility: Only handles pattern storage, not profiling
 * - Open/Closed: Can be extended with caching, analytics
 */

import {
  CrawlPattern,
  type ICrawlPattern,
  type ICrawlPatternInput,
} from '@agent-platform/database/models';
import type {
  IPatternStore,
  StoredPattern,
  StorePatternInput,
  GetPatternOptions,
  FindPatternsQuery,
  CrawlCompletionUpdate,
  PatternStoreStats,
} from './interfaces.js';
import { PatternStoreError } from './interfaces.js';
import type { SiteProfile } from '../profiler/interfaces.js';

export class MongoPatternStore implements IPatternStore {
  /**
   * Store or update a pattern for a domain
   */
  async storePattern(input: StorePatternInput): Promise<StoredPattern> {
    try {
      const { domain, tenantId, profile } = input;

      // Normalize domain
      const normalizedDomain = this.normalizeDomain(domain);

      // Prepare upsert data
      const patternInput: ICrawlPatternInput = {
        domain: normalizedDomain,
        tenantId,
        siteType: profile.siteType,
        framework: profile.framework,
        jsRequired: profile.jsRequired,
        linkDensity: profile.linkDensity,
        estimatedSize: profile.estimatedSize,
        avgResponseTime: profile.avgResponseTime,
        rateLimitDetected: profile.rateLimitDetected,
        maxConcurrency: profile.maxConcurrency,
        confidence: profile.confidence,
        metadata: profile.metadata,
        profiledAt: profile.profiledAt,
      };

      // Upsert: update if exists, create if not
      const result = await CrawlPattern.findOneAndUpdate(
        { tenantId, domain: normalizedDomain },
        {
          $set: patternInput,
          $setOnInsert: {
            totalCrawlsCompleted: 0,
            lastCrawlSuccess: true,
            lastAccessedAt: new Date(),
          },
          $currentDate: { updatedAt: true },
        },
        {
          upsert: true,
          new: true, // Return updated document
          lean: true, // Return plain object, not Mongoose document
        },
      );

      if (!result) {
        throw new PatternStoreError('Failed to upsert pattern', 'UPSERT_FAILED');
      }

      return this.toStoredPattern(result as ICrawlPattern);
    } catch (error) {
      if (error instanceof PatternStoreError) {
        throw error;
      }
      throw new PatternStoreError(
        `Failed to store pattern: ${error instanceof Error ? error.message : String(error)}`,
        'STORE_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Get pattern for a specific domain
   */
  async getPattern(
    tenantId: string,
    domain: string,
    options: GetPatternOptions = {},
  ): Promise<StoredPattern | null> {
    try {
      const normalizedDomain = this.normalizeDomain(domain);

      const pattern = await CrawlPattern.findOne({
        tenantId,
        domain: normalizedDomain,
      }).lean<ICrawlPattern>();

      if (!pattern) {
        return null;
      }

      // Update lastAccessedAt if touch option is enabled
      if (options.touch !== false) {
        // Fire and forget - don't await
        CrawlPattern.updateOne(
          { _id: pattern._id },
          { $set: { lastAccessedAt: new Date() } },
        ).exec();
      }

      return this.toStoredPattern(pattern);
    } catch (error) {
      throw new PatternStoreError(
        `Failed to get pattern: ${error instanceof Error ? error.message : String(error)}`,
        'GET_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Find patterns matching query
   */
  async findPatterns(query: FindPatternsQuery): Promise<StoredPattern[]> {
    try {
      const filter: any = { tenantId: query.tenantId };

      if (query.siteType) {
        filter.siteType = query.siteType;
      }

      if (query.framework) {
        filter.framework = query.framework;
      }

      if (query.minConfidence !== undefined) {
        filter.confidence = { $gte: query.minConfidence };
      }

      const limit = query.limit ?? 100;
      const skip = query.offset ?? 0;

      const patterns = await CrawlPattern.find(filter)
        .sort({ lastAccessedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<ICrawlPattern[]>();

      return patterns.map((p) => this.toStoredPattern(p));
    } catch (error) {
      throw new PatternStoreError(
        `Failed to find patterns: ${error instanceof Error ? error.message : String(error)}`,
        'FIND_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Update pattern after crawl completion
   */
  async updateCrawlMetrics(update: CrawlCompletionUpdate): Promise<void> {
    try {
      const normalizedDomain = this.normalizeDomain(update.domain);

      const updateDoc: any = {
        $set: {
          lastCrawlAt: new Date(),
          lastCrawlSuccess: update.success,
        },
        $inc: { totalCrawlsCompleted: 1 },
      };

      if (update.durationMs !== undefined) {
        // Calculate running average
        const pattern = await CrawlPattern.findOne({
          tenantId: update.tenantId,
          domain: normalizedDomain,
        });

        if (pattern) {
          const currentAvg = pattern.avgCrawlDurationMs ?? 0;
          const count = pattern.totalCrawlsCompleted;
          const newAvg = (currentAvg * count + update.durationMs) / (count + 1);
          updateDoc.$set.avgCrawlDurationMs = Math.round(newAvg);
        } else {
          updateDoc.$set.avgCrawlDurationMs = update.durationMs;
        }
      }

      if (update.error) {
        updateDoc.$set.lastCrawlError = update.error;
      } else {
        updateDoc.$unset = { lastCrawlError: '' };
      }

      await CrawlPattern.updateOne(
        { tenantId: update.tenantId, domain: normalizedDomain },
        updateDoc,
      ).exec();
    } catch (error) {
      throw new PatternStoreError(
        `Failed to update crawl metrics: ${error instanceof Error ? error.message : String(error)}`,
        'UPDATE_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Delete pattern for a domain
   */
  async deletePattern(tenantId: string, domain: string): Promise<boolean> {
    try {
      const normalizedDomain = this.normalizeDomain(domain);

      const result = await CrawlPattern.deleteOne({
        tenantId,
        domain: normalizedDomain,
      });

      return result.deletedCount > 0;
    } catch (error) {
      throw new PatternStoreError(
        `Failed to delete pattern: ${error instanceof Error ? error.message : String(error)}`,
        'DELETE_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Get statistics for a tenant's patterns
   */
  async getStats(tenantId: string): Promise<PatternStoreStats> {
    try {
      const patterns = await CrawlPattern.find({ tenantId }).lean<ICrawlPattern[]>();

      const totalPatterns = patterns.length;

      const patternsByType: Record<string, number> = {};
      const patternsByFramework: Record<string, number> = {};
      let totalConfidence = 0;

      let oldestPattern: Date | undefined;
      let newestPattern: Date | undefined;

      for (const pattern of patterns) {
        // Count by type
        patternsByType[pattern.siteType] = (patternsByType[pattern.siteType] ?? 0) + 1;

        // Count by framework
        if (pattern.framework) {
          patternsByFramework[pattern.framework] =
            (patternsByFramework[pattern.framework] ?? 0) + 1;
        }

        // Sum confidence
        totalConfidence += pattern.confidence;

        // Track oldest/newest
        if (!oldestPattern || pattern.profiledAt < oldestPattern) {
          oldestPattern = pattern.profiledAt;
        }
        if (!newestPattern || pattern.profiledAt > newestPattern) {
          newestPattern = pattern.profiledAt;
        }
      }

      const avgConfidence = totalPatterns > 0 ? totalConfidence / totalPatterns : 0;

      return {
        totalPatterns,
        patternsByType,
        patternsByFramework,
        avgConfidence,
        oldestPattern,
        newestPattern,
      };
    } catch (error) {
      throw new PatternStoreError(
        `Failed to get stats: ${error instanceof Error ? error.message : String(error)}`,
        'STATS_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Clear all patterns for a tenant
   */
  async clearTenant(tenantId: string): Promise<number> {
    try {
      const result = await CrawlPattern.deleteMany({ tenantId });
      return result.deletedCount;
    } catch (error) {
      throw new PatternStoreError(
        `Failed to clear tenant: ${error instanceof Error ? error.message : String(error)}`,
        'CLEAR_ERROR',
        error as Error,
      );
    }
  }

  /**
   * Convert ICrawlPattern to StoredPattern
   */
  private toStoredPattern(doc: ICrawlPattern): StoredPattern {
    return {
      id: doc._id,
      domain: doc.domain,
      tenantId: doc.tenantId,
      profile: {
        domain: doc.domain,
        profiledAt: doc.profiledAt,
        siteType: doc.siteType,
        framework: doc.framework,
        jsRequired: doc.jsRequired,
        linkDensity: doc.linkDensity,
        estimatedSize: doc.estimatedSize,
        avgResponseTime: doc.avgResponseTime,
        rateLimitDetected: doc.rateLimitDetected,
        maxConcurrency: doc.maxConcurrency,
        confidence: doc.confidence,
        metadata: doc.metadata,
      },
      crawlMetrics: {
        lastCrawlAt: doc.lastCrawlAt,
        totalCrawlsCompleted: doc.totalCrawlsCompleted,
        avgCrawlDurationMs: doc.avgCrawlDurationMs,
        lastCrawlSuccess: doc.lastCrawlSuccess,
        lastCrawlError: doc.lastCrawlError,
      },
      profiledAt: doc.profiledAt,
      lastAccessedAt: doc.lastAccessedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * Normalize domain to lowercase without protocol
   */
  private normalizeDomain(domain: string): string {
    try {
      const lowerDomain = domain.toLowerCase();
      const url = new URL(lowerDomain.startsWith('http') ? lowerDomain : `https://${lowerDomain}`);
      return url.hostname;
    } catch {
      return domain
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0];
    }
  }
}
