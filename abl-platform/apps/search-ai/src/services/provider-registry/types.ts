/**
 * Provider Registry Types
 *
 * Defines the core abstractions for pluggable pipeline stage providers.
 * Providers implement specific processing logic (extraction, chunking, embedding, etc.)
 * and are registered with the ProviderRegistry for runtime selection.
 *
 * Design principles:
 * - Type-safe: Generic interfaces for input/output/config
 * - Pluggable: Providers implement standard interface
 * - Configurable: JSON Schema validation for provider configs
 * - Observable: Built-in error tracking and logging
 *
 * Reference: docs/searchai/pipelines/design/backend/03-CIRCUIT-BREAKER-IMPLEMENTATION.md
 */

import { type SearchPipelineStageType } from '@agent-platform/database';
export type { SearchPipelineStageType };

// ─── Core Provider Interface ─────────────────────────────────────────────

/**
 * Abstract interface for all pipeline stage providers.
 *
 * Providers must implement:
 * - execute(): Core processing logic
 * - validateConfig(): Runtime config validation
 * - getSchema(): JSON Schema for UI form generation
 *
 * @typeParam TInput - Input data type (e.g., Buffer for extraction, string[] for chunking)
 * @typeParam TOutput - Output data type (e.g., { text: string } for extraction)
 * @typeParam TConfig - Provider-specific configuration type
 *
 * @example
 * ```typescript
 * class DoclingExtractionProvider implements PipelineStageProvider<Buffer, ExtractionOutput, DoclingConfig> {
 *   id = 'docling';
 *   name = 'Docling v2';
 *   type = 'extraction';
 *   version = '2.0.0';
 *
 *   async execute(input: Buffer, config: DoclingConfig): Promise<ExtractionOutput> {
 *     // Call Docling API with config
 *     return { text: extractedText, metadata: {} };
 *   }
 *
 *   validateConfig(config: unknown): config is DoclingConfig {
 *     return typeof config === 'object' && 'model' in config;
 *   }
 *
 *   getSchema(): JSONSchema {
 *     return {
 *       type: 'object',
 *       properties: {
 *         model: { type: 'string', enum: ['v1', 'v2'] }
 *       }
 *     };
 *   }
 * }
 * ```
 */
export interface PipelineStageProvider<TInput = unknown, TOutput = unknown, TConfig = unknown> {
  /** Unique provider identifier (e.g., 'docling', 'openai', 'bge-m3') */
  id: string;

  /** Human-readable provider name (e.g., 'Docling v2', 'OpenAI GPT-4') */
  name: string;

  /** Stage type this provider implements */
  type: SearchPipelineStageType;

  /** Provider version (semantic versioning) */
  version: string;

  /** Optional description for UI display */
  description?: string;

  /**
   * Execute the provider's core logic.
   *
   * @param input - Input data (type depends on stage type)
   * @param config - Provider-specific configuration
   * @returns Promise resolving to output data
   * @throws {ProviderExecutionError} If execution fails
   */
  execute(input: TInput, config: TConfig): Promise<TOutput>;

  /**
   * Validate provider configuration at runtime.
   *
   * Used to ensure config from MongoDB matches expected schema.
   * Should perform type narrowing for TypeScript safety.
   *
   * @param config - Unknown config object from database
   * @returns Type predicate confirming config is TConfig
   */
  validateConfig(config: unknown): config is TConfig;

  /**
   * Get JSON Schema for provider configuration.
   *
   * Used by Studio UI to generate dynamic configuration forms.
   * Should match the TConfig type structure.
   *
   * @returns JSON Schema object (draft-07 compatible)
   */
  getSchema(): JSONSchema;

  /**
   * Optional: Estimate execution duration in milliseconds.
   *
   * Used for:
   * - UI progress indicators
   * - BullMQ lockDuration calculation
   * - Cost estimation
   *
   * @param input - Input data for size-based estimation
   * @param config - Provider configuration
   * @returns Estimated duration in ms
   */
  estimateDuration?(input: TInput, config: TConfig): Promise<number>;

  /**
   * Optional: Estimate execution cost in USD.
   *
   * Used for tenant billing and cost projections.
   *
   * @param input - Input data for size-based estimation
   * @param config - Provider configuration
   * @returns Estimated cost in USD
   */
  estimateCost?(input: TInput, config: TConfig): Promise<number>;
}

// ─── Provider Configuration ──────────────────────────────────────────────

/**
 * JSON Schema for provider configuration.
 *
 * Subset of JSON Schema Draft-07 sufficient for UI form generation.
 */
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  title?: string;
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
}

// ─── Provider Errors ─────────────────────────────────────────────────────

/**
 * Base error for provider execution failures.
 *
 * Extends Error with additional context for debugging and monitoring.
 */
export class ProviderExecutionError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly cause?: Error,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
    Error.captureStackTrace?.(this, ProviderExecutionError);
  }
}

/**
 * Error thrown when provider configuration is invalid.
 */
export class ProviderConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly config: unknown,
    public readonly validationErrors: string[],
  ) {
    super(message);
    this.name = 'ProviderConfigValidationError';
    Error.captureStackTrace?.(this, ProviderConfigValidationError);
  }
}

/**
 * Error thrown when provider is not found in registry.
 */
export class ProviderNotFoundError extends Error {
  constructor(
    public readonly stageType: SearchPipelineStageType,
    public readonly providerId: string,
  ) {
    super(`Provider '${providerId}' not found for stage type '${stageType}'`);
    this.name = 'ProviderNotFoundError';
    Error.captureStackTrace?.(this, ProviderNotFoundError);
  }
}

// ─── Registry Types ──────────────────────────────────────────────────────

/**
 * Provider metadata for registry listing.
 */
export interface ProviderMetadata {
  id: string;
  name: string;
  type: SearchPipelineStageType;
  version: string;
  description?: string;
  schema: JSONSchema;
}
