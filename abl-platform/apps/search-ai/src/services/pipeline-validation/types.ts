/**
 * Pipeline Validation Types
 *
 * Type definitions for pipeline validation service.
 *
 * Reference: docs/searchai/pipelines/design/backend/01-DATA-MODELS.md (Validation Rules section)
 */

// ─── Validation Error Types ──────────────────────────────────────────────

/**
 * Validation error severity levels.
 */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * Validation error codes.
 */
export type ValidationErrorCode =
  // Structure validation
  | 'NO_FLOWS'
  | 'TOO_MANY_FLOWS'
  | 'NO_STAGES'
  | 'NO_ENABLED_FLOWS'
  | 'NO_DEFAULT_FLOW'
  | 'MULTIPLE_DEFAULT_FLOWS'
  | 'PIPELINE_NO_DEFAULT_FLOW'
  | 'PIPELINE_MULTIPLE_DEFAULT_FLOWS'
  | 'DEFAULT_FLOW_HAS_RULES'
  | 'DEFAULT_FLOW_DISABLED'
  | 'DEFAULT_FLOW_PRIORITY'
  // Uniqueness validation
  | 'DUPLICATE_FLOW_ID'
  | 'DUPLICATE_STAGE_ID'
  | 'DUPLICATE_PRIORITY'
  // Stage validation
  | 'INVALID_STAGE_TYPE'
  | 'INVALID_STAGE_SEQUENCE'
  | 'DUPLICATE_STAGE_TYPE'
  // Provider validation
  | 'PROVIDER_NOT_FOUND'
  | 'FALLBACK_PROVIDER_SAME_AS_PRIMARY'
  | 'INVALID_PROVIDER_CONFIG'
  // Rule validation
  | 'INVALID_CEL_EXPRESSION'
  | 'INVALID_RULE_FIELD_PATH'
  | 'INVALID_RULE_OPERATOR'
  // Embedding validation
  | 'EMBEDDING_CONFIG_MISMATCH'
  | 'MISSING_EMBEDDING_CONFIG'
  | 'EMBEDDING_CREDENTIALS_UNAVAILABLE'
  // Tenant/Project validation
  | 'KNOWLEDGE_BASE_NOT_FOUND'
  | 'INSUFFICIENT_PERMISSIONS';

/**
 * Structured validation error.
 */
export interface ValidationError {
  /** Error code for programmatic handling */
  code: ValidationErrorCode;
  /** Human-readable error message */
  message: string;
  /** Severity level */
  severity: ValidationSeverity;
  /** Path to the field causing error (e.g., 'flows[0].stages[1].provider') */
  path?: string;
  /** Additional context data */
  context?: Record<string, unknown>;
}

// ─── Validation Result ───────────────────────────────────────────────────

/**
 * Result of pipeline validation.
 */
export interface ValidationResult {
  /** Whether pipeline is valid (no errors, warnings OK) */
  valid: boolean;
  /** Validation errors and warnings */
  errors: ValidationError[];
  /** Summary statistics */
  summary: {
    /** Total error count */
    errorCount: number;
    /** Total warning count */
    warningCount: number;
    /** Total info count */
    infoCount: number;
    /** Validation duration in milliseconds */
    durationMs: number;
  };
}

// ─── Validation Options ──────────────────────────────────────────────────

/**
 * Options for pipeline validation.
 */
export interface ValidationOptions {
  /** Skip provider registry checks (for testing) */
  skipProviderValidation?: boolean;
  /** Skip CEL expression validation (for testing) */
  skipCELValidation?: boolean;
  /** Skip knowledge base validation (for testing) */
  skipKnowledgeBaseValidation?: boolean;
  /** Skip permission validation (for testing) */
  skipPermissionValidation?: boolean;
}

// ─── Valid Stage Types ───────────────────────────────────────────────────

/**
 * Valid pipeline stage types.
 *
 * Must match PipelineStageType in @agent-platform/database.
 */
export const VALID_STAGE_TYPES = [
  'extraction',
  'chunking',
  'enrichment',
  'embedding',
  'multimodal',
  'content-intelligence',
  'visual-analysis',
  'field-mapping',
  'api-webhook',
  'llm-stage',
] as const;

/** Utility stages that can appear at any position and allow duplicates. */
export const UTILITY_STAGE_TYPES = ['field-mapping', 'api-webhook', 'llm-stage'] as const;

/**
 * Valid rule operators.
 */
export const VALID_RULE_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'lt',
  'gte',
  'lte',
  'contains',
  'matches',
  'in',
] as const;

/**
 * Valid rule field path prefixes.
 */
export const VALID_RULE_FIELD_PREFIXES = ['document', 'source', 'metadata'] as const;

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * Maximum number of flows allowed in a pipeline.
 *
 * Performance limit to prevent excessive document size and routing overhead.
 */
export const MAX_FLOWS_PER_PIPELINE = 50;

/**
 * Minimum number of flows required in a pipeline.
 */
export const MIN_FLOWS_PER_PIPELINE = 1;

/**
 * Minimum number of stages required per flow.
 */
export const MIN_STAGES_PER_FLOW = 1;
