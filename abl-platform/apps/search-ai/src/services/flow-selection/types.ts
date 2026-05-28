/**
 * Flow Selection Types
 *
 * Type definitions for flow selection and rule evaluation.
 *
 * Flow selection uses:
 * - Priority-based ordering (highest priority first)
 * - Rule evaluation (simple operators, compound logic, CEL expressions)
 * - Fail-safe error handling (continue to next flow on error)
 *
 * Reference: docs/searchai/pipelines/design/backend/01-DATA-MODELS.md
 */

import type { ISearchPipelineFlow, ISearchRuleCondition } from '@agent-platform/database';

// ─── Flow Context ────────────────────────────────────────────────────────

/**
 * Context provided to flow selection for rule evaluation.
 *
 * Contains document properties and metadata for CEL expression evaluation.
 *
 * @example
 * ```typescript
 * const context: FlowContext = {
 *   document: {
 *     extension: 'pdf',
 *     mimeType: 'application/pdf',
 *     size: 1048576,
 *     name: 'report.pdf',
 *   },
 *   source: {
 *     connector: 'google-drive',
 *     path: '/reports/2024',
 *   },
 *   metadata: {
 *     createdAt: new Date(),
 *     author: 'John Doe',
 *   },
 * };
 * ```
 */
export interface FlowContext {
  /** Document properties */
  document: {
    /** File extension (e.g., 'pdf', 'docx', 'txt') */
    extension: string;
    /** MIME type (e.g., 'application/pdf') */
    mimeType: string;
    /** File size in bytes */
    size: number;
    /** Original filename */
    name: string;
    /** Optional language code (ISO 639-1) */
    language?: string;
  };

  /** Source properties */
  source: {
    /** Connector name (e.g., 'google-drive', 's3') */
    connector: string;
    /** Source path or URL */
    path?: string;
    /** Source ID */
    id?: string;
  };

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// ─── Selection Results ───────────────────────────────────────────────────

/**
 * Result of flow selection.
 *
 * Either a selected flow or an error if no flow matched.
 */
export interface FlowSelectionResult {
  /** Whether a flow was selected */
  success: boolean;

  /** Selected flow (if success) */
  flow?: ISearchPipelineFlow;

  /** Error message (if not success) */
  error?: string;

  /** Selection details for debugging */
  details: {
    /** Number of enabled flows evaluated */
    flowsEvaluated: number;
    /** Flow that was selected (if any) */
    selectedFlowId?: string;
    /** Flows that were skipped (with reasons) */
    skippedFlows: Array<{
      flowId: string;
      reason: string;
    }>;
  };
}

/**
 * Result of rule evaluation.
 *
 * Indicates whether a rule matched and includes debug info.
 */
export interface RuleEvaluationResult {
  /** Whether the rule matched */
  matched: boolean;

  /** Error message if evaluation failed */
  error?: string;

  /** Evaluation details for debugging */
  details?: {
    ruleType: string;
    expression?: string;
    evaluationTime?: number;
  };
}

// ─── Errors ──────────────────────────────────────────────────────────────

/**
 * Error thrown when CEL expression evaluation fails.
 */
export class CELEvaluationError extends Error {
  constructor(
    message: string,
    public readonly expression: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'CELEvaluationError';
    Error.captureStackTrace?.(this, CELEvaluationError);
  }
}

/**
 * Error thrown when no flow matches the selection criteria.
 */
export class NoFlowMatchedError extends Error {
  constructor(
    message: string,
    public readonly context: FlowContext,
    public readonly flowsEvaluated: number,
  ) {
    super(message);
    this.name = 'NoFlowMatchedError';
    Error.captureStackTrace?.(this, NoFlowMatchedError);
  }
}

/**
 * Error thrown when flow selection times out.
 */
export class FlowSelectionTimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'FlowSelectionTimeoutError';
    Error.captureStackTrace?.(this, FlowSelectionTimeoutError);
  }
}
