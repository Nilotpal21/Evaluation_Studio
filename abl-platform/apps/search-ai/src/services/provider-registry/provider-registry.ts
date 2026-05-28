/**
 * Provider Registry
 *
 * Central registry for all pipeline stage providers.
 * Manages provider registration, retrieval, and metadata access.
 *
 * Design:
 * - Two-level map: stageType -> providerId -> provider
 * - Type-safe provider retrieval
 * - Listing by stage type for UI dropdowns
 * - Thread-safe (singleton pattern)
 *
 * Usage:
 * ```typescript
 * const registry = ProviderRegistry.getInstance();
 *
 * // Register providers
 * registry.register(new DoclingProvider());
 * registry.register(new BGE_M3Provider());
 *
 * // Get provider
 * const provider = registry.get('extraction', 'docling');
 * const result = await provider.execute(input, config);
 *
 * // List by stage type
 * const extractionProviders = registry.listByStageType('extraction');
 * ```
 *
 * Reference: docs/searchai/pipelines/design/backend/03-CIRCUIT-BREAKER-IMPLEMENTATION.md
 */

import { type SearchPipelineStageType } from '@agent-platform/database';
import { createLogger } from '@abl/compiler/platform';
import {
  type PipelineStageProvider,
  type ProviderMetadata,
  ProviderNotFoundError,
} from './types.js';

const logger = createLogger('provider-registry');

/**
 * Central registry for pipeline stage providers.
 *
 * Singleton pattern ensures single instance across application.
 * Providers are organized by stage type for efficient lookup.
 */
export class ProviderRegistry {
  private static instance: ProviderRegistry | null = null;

  /**
   * Two-level map for efficient provider lookup.
   * Structure: Map<stageType, Map<providerId, provider>>
   */
  private providers = new Map<SearchPipelineStageType, Map<string, PipelineStageProvider>>();

  /**
   * Private constructor for singleton pattern.
   * Use getInstance() to access the registry.
   */
  private constructor() {
    logger.info('Initializing ProviderRegistry');
  }

  /**
   * Get singleton instance of ProviderRegistry.
   *
   * @returns The global ProviderRegistry instance
   */
  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  /**
   * Register a new provider.
   *
   * Providers are indexed by stage type and provider ID.
   * Attempting to register duplicate provider ID for same stage type will log warning.
   *
   * @param provider - Provider implementation to register
   * @throws {Error} If provider is missing required fields
   *
   * @example
   * ```typescript
   * registry.register(new DoclingProvider());
   * ```
   */
  register(provider: PipelineStageProvider): void {
    // Validate provider has required fields
    if (!provider.id || !provider.name || !provider.type) {
      throw new Error(
        `Provider must have id, name, and type. Got: ${JSON.stringify({
          id: provider.id,
          name: provider.name,
          type: provider.type,
        })}`,
      );
    }

    // Get or create stage type map
    let stageProviders = this.providers.get(provider.type);
    if (!stageProviders) {
      stageProviders = new Map();
      this.providers.set(provider.type, stageProviders);
    }

    // Check for duplicate
    if (stageProviders.has(provider.id)) {
      logger.warn('Overwriting existing provider registration', {
        stageType: provider.type,
        providerId: provider.id,
        providerName: provider.name,
      });
    }

    // Register provider
    stageProviders.set(provider.id, provider);

    logger.info('Registered provider', {
      stageType: provider.type,
      providerId: provider.id,
      providerName: provider.name,
      version: provider.version,
    });
  }

  /**
   * Get a registered provider by stage type and provider ID.
   *
   * @param stageType - Pipeline stage type
   * @param providerId - Unique provider identifier
   * @returns The registered provider
   * @throws {ProviderNotFoundError} If provider not found
   *
   * @example
   * ```typescript
   * const provider = registry.get('extraction', 'docling');
   * const result = await provider.execute(pdfBuffer, { model: 'v2' });
   * ```
   */
  get(stageType: SearchPipelineStageType, providerId: string): PipelineStageProvider {
    const stageProviders = this.providers.get(stageType);
    if (!stageProviders) {
      throw new ProviderNotFoundError(stageType, providerId);
    }

    const provider = stageProviders.get(providerId);
    if (!provider) {
      throw new ProviderNotFoundError(stageType, providerId);
    }

    return provider;
  }

  /**
   * List all registered providers for a specific stage type.
   *
   * Returns provider metadata for UI dropdowns and documentation.
   *
   * @param stageType - Pipeline stage type
   * @returns Array of provider metadata
   *
   * @example
   * ```typescript
   * const extractionProviders = registry.listByStageType('extraction');
   * // [{ id: 'docling', name: 'Docling v2', type: 'extraction', ... }]
   * ```
   */
  listByStageType(stageType: SearchPipelineStageType): ProviderMetadata[] {
    const stageProviders = this.providers.get(stageType);
    if (!stageProviders) {
      return [];
    }

    return Array.from(stageProviders.values()).map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      version: provider.version,
      description: provider.description,
      schema: provider.getSchema(),
    }));
  }

  /**
   * List all registered providers across all stage types.
   *
   * Returns flat array of all provider metadata.
   *
   * @returns Array of all provider metadata
   *
   * @example
   * ```typescript
   * const allProviders = registry.listAll();
   * ```
   */
  listAll(): ProviderMetadata[] {
    const allProviders: ProviderMetadata[] = [];

    for (const stageProviders of this.providers.values()) {
      for (const provider of stageProviders.values()) {
        allProviders.push({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          version: provider.version,
          description: provider.description,
          schema: provider.getSchema(),
        });
      }
    }

    return allProviders;
  }

  /**
   * Check if a provider is registered.
   *
   * @param stageType - Pipeline stage type
   * @param providerId - Unique provider identifier
   * @returns True if provider is registered
   *
   * @example
   * ```typescript
   * if (registry.has('extraction', 'docling')) {
   *   // Provider is available
   * }
   * ```
   */
  has(stageType: SearchPipelineStageType, providerId: string): boolean {
    const stageProviders = this.providers.get(stageType);
    if (!stageProviders) {
      return false;
    }
    return stageProviders.has(providerId);
  }

  /**
   * Unregister a provider.
   *
   * Useful for testing or hot-reloading providers.
   *
   * @param stageType - Pipeline stage type
   * @param providerId - Unique provider identifier
   * @returns True if provider was unregistered, false if not found
   *
   * @example
   * ```typescript
   * registry.unregister('extraction', 'docling');
   * ```
   */
  unregister(stageType: SearchPipelineStageType, providerId: string): boolean {
    const stageProviders = this.providers.get(stageType);
    if (!stageProviders) {
      return false;
    }

    const deleted = stageProviders.delete(providerId);

    if (deleted) {
      logger.info('Unregistered provider', {
        stageType,
        providerId,
      });
    }

    return deleted;
  }

  /**
   * Get count of registered providers by stage type.
   *
   * Useful for health checks and monitoring.
   *
   * @returns Map of stage type to provider count
   *
   * @example
   * ```typescript
   * const counts = registry.getProviderCounts();
   * // Map { 'extraction' => 2, 'embedding' => 1, ... }
   * ```
   */
  getProviderCounts(): Map<SearchPipelineStageType, number> {
    const counts = new Map<SearchPipelineStageType, number>();

    for (const [stageType, stageProviders] of this.providers.entries()) {
      counts.set(stageType, stageProviders.size);
    }

    return counts;
  }

  /**
   * Clear all registered providers.
   *
   * Primarily for testing. Use with caution in production.
   *
   * @example
   * ```typescript
   * registry.clear(); // Remove all providers
   * ```
   */
  clear(): void {
    this.providers.clear();
    logger.warn('Cleared all providers from registry');
  }

  /**
   * Reset singleton instance.
   *
   * FOR TESTING ONLY. Creates fresh registry instance.
   *
   * @internal
   */
  static _resetForTesting(): void {
    if (ProviderRegistry.instance) {
      ProviderRegistry.instance.clear();
      ProviderRegistry.instance = null;
    }
  }
}
