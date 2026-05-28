/**
 * Provider Registry Module
 *
 * Central registry for pluggable pipeline stage providers.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { ProviderRegistry } from './provider-registry';
 * import { DoclingProvider } from './providers/docling';
 *
 * const registry = ProviderRegistry.getInstance();
 * registry.register(new DoclingProvider());
 *
 * const provider = registry.get('extraction', 'docling');
 * const result = await provider.execute(input, config);
 * ```
 *
 * ## Architecture
 *
 * - **PipelineStageProvider**: Abstract interface all providers implement
 * - **ProviderRegistry**: Singleton registry for registration and retrieval
 * - **Provider Types**: Type-safe generics for input/output/config
 *
 * ## Creating a New Provider
 *
 * See `example-provider.ts` for template and best practices.
 *
 * Reference: docs/searchai/pipelines/design/backend/03-CIRCUIT-BREAKER-IMPLEMENTATION.md
 */

export { ProviderRegistry } from './provider-registry.js';
export {
  ProviderRegistryWithCircuitBreaker,
  type ProtectedExecutionParams,
  type ProtectedExecutionResult,
} from './circuit-breaker-registry.js';
export {
  type PipelineStageProvider,
  type JSONSchema,
  type JSONSchemaProperty,
  type ProviderMetadata,
  ProviderExecutionError,
  ProviderConfigValidationError,
  ProviderNotFoundError,
} from './types.js';
