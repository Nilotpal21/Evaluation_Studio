/**
 * User Preference Store - MongoDB Implementation
 *
 * Stores and retrieves user-specific crawl preferences.
 * Supports domain pattern matching (exact and wildcard).
 *
 * Features:
 * - Pattern matching: "example.com" (exact), "*.example.com" (wildcard)
 * - Tenant isolation
 * - Usage tracking
 * - Auto-decide flag
 */

import type { IUserPreferenceStore, UserPreference, CrawlStrategy } from './interfaces.js';
import { DecisionError } from './interfaces.js';
import { UserCrawlPreference, type IUserCrawlPreference } from '@agent-platform/database/models';

/**
 * MongoDB-based User Preference Store
 */
export class MongoUserPreferenceStore implements IUserPreferenceStore {
  /**
   * Get user preference for a domain
   * Supports exact match and wildcard patterns
   */
  async getPreference(
    userId: string,
    tenantId: string,
    domain: string,
  ): Promise<UserPreference | null> {
    try {
      const normalizedDomain = this.normalizeDomain(domain);

      // Try exact match first
      let preference = await UserCrawlPreference.findOne({
        userId,
        tenantId,
        domainPattern: normalizedDomain,
      }).lean<IUserCrawlPreference>();

      if (preference) {
        return this.toUserPreference(preference);
      }

      // Try wildcard matches
      const wildcardCandidates = await UserCrawlPreference.find({
        userId,
        tenantId,
        domainPattern: { $regex: /^\*\./ }, // Patterns starting with "*."
      }).lean<IUserCrawlPreference[]>();

      for (const candidate of wildcardCandidates) {
        if (this.matchesWildcardPattern(candidate.domainPattern, normalizedDomain)) {
          return this.toUserPreference(candidate);
        }
      }

      return null;
    } catch (error) {
      throw new DecisionError(
        `Failed to get user preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PREFERENCE_GET_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Save user preference
   */
  async savePreference(
    preference: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<UserPreference> {
    try {
      const normalizedPattern = this.normalizeDomain(preference.domainPattern);

      const result = await UserCrawlPreference.findOneAndUpdate(
        {
          userId: preference.userId,
          tenantId: preference.tenantId,
          domainPattern: normalizedPattern,
        },
        {
          $set: {
            strategy: preference.strategy,
            batchSize: preference.batchSize,
            concurrency: preference.concurrency,
            autoDecide: preference.autoDecide,
            useCount: preference.useCount,
            lastUsed: preference.lastUsed,
          },
          $setOnInsert: {
            userId: preference.userId,
            tenantId: preference.tenantId,
            domainPattern: normalizedPattern,
          },
          $currentDate: { updatedAt: true },
        },
        {
          upsert: true,
          new: true,
          lean: true,
        },
      );

      if (!result) {
        throw new Error('Failed to create preference');
      }

      return this.toUserPreference(result);
    } catch (error) {
      throw new DecisionError(
        `Failed to save user preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PREFERENCE_SAVE_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Delete user preference
   */
  async deletePreference(id: string): Promise<boolean> {
    try {
      const result = await UserCrawlPreference.deleteOne({ _id: id });
      return result.deletedCount > 0;
    } catch (error) {
      throw new DecisionError(
        `Failed to delete user preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PREFERENCE_DELETE_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * List all preferences for a user
   */
  async listPreferences(userId: string, tenantId: string): Promise<UserPreference[]> {
    try {
      const preferences = await UserCrawlPreference.find({
        userId,
        tenantId,
      })
        .sort({ lastUsed: -1 }) // Most recently used first
        .lean<IUserCrawlPreference[]>();

      return preferences.map((pref) => this.toUserPreference(pref));
    } catch (error) {
      throw new DecisionError(
        `Failed to list user preferences: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PREFERENCE_LIST_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Update usage stats (useCount, lastUsed)
   */
  async trackUsage(id: string): Promise<void> {
    try {
      await UserCrawlPreference.updateOne(
        { _id: id },
        {
          $inc: { useCount: 1 },
          $set: { lastUsed: new Date() },
        },
      );
    } catch (error) {
      throw new DecisionError(
        `Failed to track preference usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'PREFERENCE_TRACK_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ========================================
  // Private Helpers
  // ========================================

  /**
   * Normalize domain to lowercase
   */
  private normalizeDomain(domain: string): string {
    try {
      // If it looks like a full URL, extract hostname
      if (domain.includes('://')) {
        return new URL(domain).hostname.toLowerCase();
      }
      return domain.toLowerCase().trim();
    } catch {
      return domain.toLowerCase().trim();
    }
  }

  /**
   * Check if domain matches wildcard pattern
   * Pattern: "*.example.com" matches "sub.example.com" and "example.com"
   */
  private matchesWildcardPattern(pattern: string, domain: string): boolean {
    if (!pattern.startsWith('*.')) {
      return pattern === domain;
    }

    const baseDomain = pattern.slice(2); // Remove "*."
    return domain.endsWith('.' + baseDomain) || domain === baseDomain;
  }

  /**
   * Convert MongoDB document to UserPreference
   */
  private toUserPreference(doc: IUserCrawlPreference): UserPreference {
    return {
      id: doc._id.toString(),
      userId: doc.userId,
      tenantId: doc.tenantId,
      domainPattern: doc.domainPattern,
      strategy: doc.strategy as CrawlStrategy,
      batchSize: doc.batchSize,
      concurrency: doc.concurrency,
      autoDecide: doc.autoDecide,
      useCount: doc.useCount,
      lastUsed: doc.lastUsed,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
