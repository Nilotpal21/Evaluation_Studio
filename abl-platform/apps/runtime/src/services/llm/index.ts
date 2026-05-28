/**
 * LLM Services Index
 *
 * Exports all LLM-related services for the platform:
 * - ModelResolutionService: Multi-level model resolution (agent IR → DB → env)
 * - SessionLLMClient: Per-session LLM client with operation-type awareness
 * - Standalone utilities: getModelCapabilities, calculateCost, tier mapping
 */

// Model resolution (multi-level: agent IR → agent DB → project DB → tenant model)
export {
  ModelResolutionService,
  inferProviderFromModelId,
  type OperationType,
  type ResolvedModel,
  type ResolvedCredential,
  type ResolutionContext,
} from './model-resolution.js';

// Model catalog (LiteLLM data + platform overrides + gateway discovery)
export { ModelCatalogService, getModelCatalog, type CatalogModel } from './model-catalog.js';

// Per-session LLM client
export {
  SessionLLMClient,
  clearProviderCache,
  TRACE_MODEL_UNKNOWN,
  type ToolDefinition,
  type ToolPropertySchema,
  type ToolCall,
  type Message,
  type ChatResult,
  type SessionStreamEvent,
} from './session-llm-client.js';

// Model capabilities, cost calculation, and tier mapping
export {
  getModelCapabilities,
  calculateCost,
  KNOWN_MODEL_CAPABILITIES,
  mapCompilerTierToPlatform,
  mapPlatformTierToCompiler,
  type ModelTier,
  type ModelCapabilities,
} from './model-router.js';
