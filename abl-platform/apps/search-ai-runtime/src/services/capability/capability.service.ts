/**
 * Capability Service - RFC-SEARCHAI-001 FR-5
 *
 * Manages the Capability Registry which stores system capabilities (aggregations,
 * operators, sort functions) that vocabulary terms can resolve to at query time.
 *
 * Capabilities are STORED AS DATA (not hardcoded) to enable:
 * - Dynamic capability querying by LLM agents
 * - Runtime capability additions without code deployment
 * - Future tenant-level capability customization
 * - Centralized capability metadata management
 *
 * **Key Features:**
 * - CRUD operations for capabilities
 * - LRU caching (10min TTL, 100 tenants max)
 * - Tenant isolation (starts with 'global', prepared for tenant customization)
 * - Cache invalidation on mutations
 * - Grouped capabilities by type (for unified endpoint)
 */

import type { ICapability } from '@agent-platform/database/models';
import { getLazyModel } from '../../db/index.js';

const CapabilityRegistry = getLazyModel<ICapability>('CapabilityRegistry');
import { LRUCache } from 'lru-cache';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('CapabilityService');

// ─── Types ───────────────────────────────────────────────────────────────

export interface ListCapabilitiesParams {
  tenantId: string;
  type?: 'aggregation' | 'operator' | 'sort';
  enabled?: boolean;
}

export interface CreateCapabilityParams {
  tenantId: string;
  name: string;
  type: 'aggregation' | 'operator' | 'sort';
  description: string;
  supportedFieldTypes: string[];
  triggerKeywords: string[];
  examples: string[];
  createdBy: 'system' | 'admin';
}

export interface UpdateCapabilityParams {
  description?: string;
  supportedFieldTypes?: string[];
  triggerKeywords?: string[];
  examples?: string[];
}

export interface GroupedCapabilities {
  aggregationFunctions: ICapability[];
  filterOperators: ICapability[];
  sortOperators: ICapability[];
}

// ─── Service ─────────────────────────────────────────────────────────────

/**
 * Capability Service with LRU caching and tenant isolation
 *
 * IMPLEMENTS:
 * - FR-5: Capability Registry as database-backed queryable data
 * - Tenant isolation (all queries scoped by tenantId)
 * - LRU cache with 10min TTL
 * - Cache invalidation on mutations
 */
export class CapabilityService {
  private cache: LRUCache<string, ICapability[]>;

  constructor() {
    // Cache capabilities for 10 minutes
    this.cache = new LRUCache({
      max: 100, // 100 tenants cached
      ttl: 1000 * 60 * 10, // 10 minutes
      updateAgeOnGet: true,
      ttlAutopurge: true,
    });

    logger.info('CapabilityService initialized');
  }

  /**
   * List all capabilities for a tenant
   *
   * @param params - Filter parameters (tenantId required, type and enabled optional)
   * @returns Array of capabilities matching the filter
   */
  async listCapabilities(params: ListCapabilitiesParams): Promise<ICapability[]> {
    const cacheKey = `capabilities:${params.tenantId}:${params.type || 'all'}:${params.enabled ?? 'all'}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      logger.debug('Capability cache hit', { cacheKey });
      return cached;
    }

    // Build query
    const query: Record<string, any> = {
      tenantId: params.tenantId,
    };

    if (params.type) {
      query.type = params.type;
    }

    if (params.enabled !== undefined) {
      query.enabled = params.enabled;
    }

    // Query database
    const capabilities = await CapabilityRegistry.find(query)
      .sort({ type: 1, name: 1 })
      .lean()
      .exec();

    // Cache results
    this.cache.set(cacheKey, capabilities as ICapability[]);

    logger.info('Capabilities loaded from database', {
      tenantId: params.tenantId,
      count: capabilities.length,
      type: params.type,
      enabled: params.enabled,
    });

    return capabilities as ICapability[];
  }

  /**
   * Get capability by ID
   *
   * @param tenantId - Tenant ID for isolation
   * @param capabilityId - Capability ID
   * @returns Capability or null if not found
   */
  async getCapabilityById(tenantId: string, capabilityId: string): Promise<ICapability | null> {
    const capability = await CapabilityRegistry.findOne({
      _id: capabilityId,
      tenantId,
    })
      .lean()
      .exec();

    if (capability) {
      logger.debug('Capability retrieved', { tenantId, capabilityId });
    } else {
      logger.debug('Capability not found', { tenantId, capabilityId });
    }

    return capability as ICapability | null;
  }

  /**
   * Create new capability (admin only)
   *
   * @param params - Capability creation parameters
   * @returns Created capability
   * @throws Error if capability name already exists for tenant
   */
  async createCapability(params: CreateCapabilityParams): Promise<ICapability> {
    // Validate no duplicate name for tenant
    const existing = await CapabilityRegistry.findOne({
      tenantId: params.tenantId,
      name: params.name,
    }).exec();

    if (existing) {
      const error = new Error(`Capability with name "${params.name}" already exists for tenant`);
      logger.error('Capability creation failed - duplicate name', {
        tenantId: params.tenantId,
        name: params.name,
      });
      throw error;
    }

    // Create capability
    const capability = new CapabilityRegistry({
      tenantId: params.tenantId,
      name: params.name,
      type: params.type,
      description: params.description,
      supportedFieldTypes: params.supportedFieldTypes,
      triggerKeywords: params.triggerKeywords,
      examples: params.examples,
      enabled: true,
      metadata: {
        version: 1,
        createdBy: params.createdBy,
      },
    });

    await capability.save();

    // Invalidate cache
    this.invalidateCache(params.tenantId);

    logger.info('Capability created', {
      tenantId: params.tenantId,
      capabilityId: capability._id,
      name: params.name,
      type: params.type,
    });

    return capability.toObject() as ICapability;
  }

  /**
   * Update existing capability
   *
   * @param tenantId - Tenant ID for isolation
   * @param capabilityId - Capability ID to update
   * @param updates - Fields to update
   * @returns Updated capability or null if not found
   */
  async updateCapability(
    tenantId: string,
    capabilityId: string,
    updates: UpdateCapabilityParams,
  ): Promise<ICapability | null> {
    const capability = await CapabilityRegistry.findOne({
      _id: capabilityId,
      tenantId,
    }).exec();

    if (!capability) {
      logger.debug('Capability not found for update', { tenantId, capabilityId });
      return null;
    }

    // Apply updates
    if (updates.description !== undefined) {
      capability.description = updates.description;
    }
    if (updates.supportedFieldTypes !== undefined) {
      capability.supportedFieldTypes = updates.supportedFieldTypes;
    }
    if (updates.triggerKeywords !== undefined) {
      capability.triggerKeywords = updates.triggerKeywords;
    }
    if (updates.examples !== undefined) {
      capability.examples = updates.examples;
    }

    // Increment version
    capability.metadata.version += 1;

    await capability.save();

    // Invalidate cache
    this.invalidateCache(tenantId);

    logger.info('Capability updated', {
      tenantId,
      capabilityId,
      version: capability.metadata.version,
      updatedFields: Object.keys(updates),
    });

    return capability.toObject() as ICapability;
  }

  /**
   * Enable/disable capability
   *
   * @param tenantId - Tenant ID for isolation
   * @param capabilityId - Capability ID to toggle
   * @param enabled - New enabled state
   * @returns Updated capability or null if not found
   */
  async toggleCapability(
    tenantId: string,
    capabilityId: string,
    enabled: boolean,
  ): Promise<ICapability | null> {
    const capability = await CapabilityRegistry.findOne({
      _id: capabilityId,
      tenantId,
    }).exec();

    if (!capability) {
      logger.debug('Capability not found for toggle', { tenantId, capabilityId });
      return null;
    }

    capability.enabled = enabled;
    capability.metadata.version += 1;

    await capability.save();

    // Invalidate cache
    this.invalidateCache(tenantId);

    logger.info('Capability toggled', {
      tenantId,
      capabilityId,
      enabled,
      version: capability.metadata.version,
    });

    return capability.toObject() as ICapability;
  }

  /**
   * Delete capability (admin only, use with caution)
   *
   * @param tenantId - Tenant ID for isolation
   * @param capabilityId - Capability ID to delete
   * @returns true if deleted, false if not found
   */
  async deleteCapability(tenantId: string, capabilityId: string): Promise<boolean> {
    const result = await CapabilityRegistry.deleteOne({
      _id: capabilityId,
      tenantId,
    }).exec();

    if (result.deletedCount && result.deletedCount > 0) {
      // Invalidate cache
      this.invalidateCache(tenantId);

      logger.warn('Capability deleted', {
        tenantId,
        capabilityId,
      });

      return true;
    }

    logger.debug('Capability not found for deletion', { tenantId, capabilityId });
    return false;
  }

  /**
   * Get capabilities grouped by type (for unified endpoint)
   *
   * Returns capabilities organized by type for easy consumption by query endpoints
   *
   * @param tenantId - Tenant ID for isolation
   * @returns Grouped capabilities object
   */
  async getCapabilitiesByType(tenantId: string): Promise<GroupedCapabilities> {
    const capabilities = await this.listCapabilities({ tenantId, enabled: true });

    const grouped: GroupedCapabilities = {
      aggregationFunctions: capabilities.filter((c) => c.type === 'aggregation'),
      filterOperators: capabilities.filter((c) => c.type === 'operator'),
      sortOperators: capabilities.filter((c) => c.type === 'sort'),
    };

    logger.debug('Capabilities grouped by type', {
      tenantId,
      aggregations: grouped.aggregationFunctions.length,
      operators: grouped.filterOperators.length,
      sorts: grouped.sortOperators.length,
    });

    return grouped;
  }

  /**
   * Clear cache for tenant
   *
   * Useful for testing or when capabilities are updated externally
   *
   * @param tenantId - Tenant ID to clear cache for
   */
  clearCache(tenantId: string): void {
    this.invalidateCache(tenantId);
    logger.info('Cache cleared for tenant', { tenantId });
  }

  /**
   * Get cache statistics
   *
   * Useful for monitoring and debugging
   */
  getCacheStats(): { size: number; max: number } {
    return {
      size: this.cache.size,
      max: this.cache.max,
    };
  }

  /**
   * Invalidate cache for tenant (private helper)
   *
   * Clears all cache entries for a specific tenant
   */
  private invalidateCache(tenantId: string): void {
    // Clear all cache entries for this tenant
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(`capabilities:${tenantId}:`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.cache.delete(key));

    logger.debug('Capability cache invalidated', {
      tenantId,
      keysCleared: keysToDelete.length,
    });
  }
}
