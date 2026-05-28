/**
 * Tenant Policy Store - MongoDB Implementation
 *
 * Stores and retrieves tenant-level crawl policies.
 * Supports domain pattern matching (exact and wildcard).
 *
 * Features:
 * - Pattern matching: "example.com" (exact), "*.example.com" (wildcard)
 * - Strategy restrictions
 * - Resource limits enforcement
 * - Compliance flags
 * - Admin audit trail
 */

import type { ITenantPolicyStore, TenantPolicy, CrawlStrategy } from './interfaces.js';
import { DecisionError } from './interfaces.js';
import { TenantCrawlPolicy, type ITenantCrawlPolicy } from '@agent-platform/database/models';

/**
 * MongoDB-based Tenant Policy Store
 */
export class MongoTenantPolicyStore implements ITenantPolicyStore {
  /**
   * Get tenant policy for a domain
   * Supports exact match and wildcard patterns
   */
  async getPolicy(tenantId: string, domain: string): Promise<TenantPolicy | null> {
    try {
      const normalizedDomain = this.normalizeDomain(domain);

      // Try exact match first
      let policy = await TenantCrawlPolicy.findOne({
        tenantId,
        domainPattern: normalizedDomain,
      }).lean<ITenantCrawlPolicy>();

      if (policy) {
        return this.toTenantPolicy(policy);
      }

      // Try wildcard matches
      const wildcardCandidates = await TenantCrawlPolicy.find({
        tenantId,
        domainPattern: { $regex: /^\*\./ }, // Patterns starting with "*."
      }).lean<ITenantCrawlPolicy[]>();

      for (const candidate of wildcardCandidates) {
        if (this.matchesWildcardPattern(candidate.domainPattern, normalizedDomain)) {
          return this.toTenantPolicy(candidate);
        }
      }

      return null;
    } catch (error) {
      throw new DecisionError(
        `Failed to get tenant policy: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'POLICY_GET_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Create tenant policy
   */
  async createPolicy(
    policy: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<TenantPolicy> {
    try {
      const normalizedPattern = this.normalizeDomain(policy.domainPattern);

      const doc = await TenantCrawlPolicy.create({
        tenantId: policy.tenantId,
        domainPattern: normalizedPattern,
        allowedStrategies: policy.allowedStrategies,
        limits: policy.limits,
        compliance: policy.compliance,
        createdBy: policy.createdBy,
      });

      return this.toTenantPolicy(doc.toObject());
    } catch (error) {
      throw new DecisionError(
        `Failed to create tenant policy: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'POLICY_CREATE_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Update tenant policy
   */
  async updatePolicy(id: string, updates: Partial<TenantPolicy>): Promise<TenantPolicy> {
    try {
      const updateData: any = {};

      if (updates.domainPattern !== undefined) {
        updateData.domainPattern = this.normalizeDomain(updates.domainPattern);
      }
      if (updates.allowedStrategies !== undefined) {
        updateData.allowedStrategies = updates.allowedStrategies;
      }
      if (updates.limits !== undefined) {
        updateData.limits = updates.limits;
      }
      if (updates.compliance !== undefined) {
        updateData.compliance = updates.compliance;
      }

      const result = await TenantCrawlPolicy.findOneAndUpdate(
        { _id: id },
        { $set: updateData, $currentDate: { updatedAt: true } },
        { new: true, lean: true },
      );

      if (!result) {
        throw new Error('Policy not found');
      }

      return this.toTenantPolicy(result);
    } catch (error) {
      throw new DecisionError(
        `Failed to update tenant policy: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'POLICY_UPDATE_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Delete tenant policy
   */
  async deletePolicy(id: string): Promise<boolean> {
    try {
      const result = await TenantCrawlPolicy.deleteOne({ _id: id });
      return result.deletedCount > 0;
    } catch (error) {
      throw new DecisionError(
        `Failed to delete tenant policy: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'POLICY_DELETE_FAILED',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * List all policies for a tenant
   */
  async listPolicies(tenantId: string): Promise<TenantPolicy[]> {
    try {
      const policies = await TenantCrawlPolicy.find({ tenantId })
        .sort({ createdAt: -1 }) // Most recently created first
        .lean<ITenantCrawlPolicy[]>();

      return policies.map((policy) => this.toTenantPolicy(policy));
    } catch (error) {
      throw new DecisionError(
        `Failed to list tenant policies: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'POLICY_LIST_FAILED',
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
   * Convert MongoDB document to TenantPolicy
   */
  private toTenantPolicy(doc: ITenantCrawlPolicy): TenantPolicy {
    return {
      id: doc._id.toString(),
      tenantId: doc.tenantId,
      domainPattern: doc.domainPattern,
      allowedStrategies: doc.allowedStrategies as CrawlStrategy[],
      limits: doc.limits,
      compliance: doc.compliance,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
