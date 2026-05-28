/**
 * Filter Engine Interface
 *
 * Defines the contract for document filtering during connector sync.
 *
 * Architecture:
 * - FilterConfig: Generic filter settings common to all connectors
 * - ScopeConfig: Connector-specific enumeration scope (Mixed type, validated per connector)
 * - AdvancedFilterConfig: Structured field/operator/value conditions
 * - IFilterEngine: Evaluation contract
 *
 * Pluggable design:
 * - Standard fields (contentCategories, fileExtensions, dates, sizes) are typed and generic
 * - Scope fields are connector-specific (SharePoint: sites/libraries/folders; Jira: projects/boards)
 * - Advanced filters use generic field/operator/value model that works for any connector
 */

import type { SourceDocument } from './sync-coordinator.interface.js';
import type { FileExtensionConfig } from '../filters/file-extension-registry.js';
import type { FolderPathConfig } from '../filters/folder-path-matcher.js';
import type {
  AdvancedFilterConfig,
  FilterCondition,
  FilterGroup,
  FilterOperator,
} from '../filters/advanced-filter-evaluator.js';

// ─── Standard Filter Config ─────────────────────────────────────────────

/**
 * Standard filter configuration — common to all connector types.
 * Controls what content categories, file types, sizes, and dates to sync.
 */
export interface StandardFilterConfig {
  /**
   * Content categories to sync.
   * SharePoint: 'files' (document libraries), 'pages' (site pages/news)
   * Other connectors define their own categories.
   * Empty array = sync all categories.
   */
  contentCategories: string[];

  /**
   * File extension filtering.
   * allowlist: only sync listed extensions.
   * denylist: sync everything EXCEPT listed extensions.
   * Null = use connector defaults.
   */
  fileExtensions: FileExtensionConfig | null;

  /** Maximum file size in bytes. Null = no limit. */
  maxFileSizeBytes: number | null;
  /** Minimum file size in bytes. Null = no limit. */
  minFileSizeBytes: number | null;

  /** Only sync documents modified after this date. Null = no limit. */
  modifiedAfter: Date | null;
  /** Only sync documents modified before this date. Null = no limit. */
  modifiedBefore: Date | null;
  /** Only sync documents created after this date. Null = no limit. */
  createdAfter: Date | null;
  /** Only sync documents created before this date. Null = no limit. */
  createdBefore: Date | null;
}

// ─── Complete Filter Config ─────────────────────────────────────────────

/**
 * Complete filter configuration stored on ConnectorConfig.
 *
 * Three sections:
 * 1. standard — generic filters (all connectors)
 * 2. scope — connector-specific enumeration scope (Mixed type)
 * 3. advancedFilters — structured conditions (all connectors)
 */
export interface FilterConfig {
  /** Standard document-level filters */
  standard: StandardFilterConfig;

  /**
   * Connector-specific scope configuration.
   * Type varies by connectorType. Validated at connector level.
   *
   * SharePoint: SharePointScopeConfig
   * Jira: { projectMode, projectKeys, issueTypes }
   * Confluence: { spaceMode, spaceKeys }
   */
  scope: Record<string, unknown>;

  /** Advanced field/operator/value conditions */
  advancedFilters: AdvancedFilterConfig;

  /** Filter configuration version (incremented on each change) */
  version: number;
}

// ─── Evaluation Result ──────────────────────────────────────────────────

export interface FilterEvaluationResult {
  /** Whether document should be included */
  include: boolean;
  /** Reason for exclusion (if include=false) */
  reason?: string;
  /** List of filter checks that were applied */
  appliedFilters: string[];
}

// ─── Validation Types ───────────────────────────────────────────────────

export interface FilterValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface FilterValidationResult {
  valid: boolean;
  errors: FilterValidationError[];
  warnings: FilterValidationError[];
}

// ─── Filter Engine Interface ────────────────────────────────────────────

export interface IFilterEngine {
  /** Filter configuration */
  readonly config: FilterConfig;

  /**
   * Evaluate whether a document should be included in sync.
   * Uses AND logic: all configured filters must pass.
   */
  evaluate(document: SourceDocument): FilterEvaluationResult;

  /**
   * Validate filter configuration.
   * Checks for syntax errors, invalid values, conflicts, etc.
   */
  validate(): FilterValidationResult;

  /**
   * Get filter statistics accumulated during sync.
   */
  getStatistics(): FilterStatistics;

  /**
   * Reset accumulated statistics.
   */
  resetStatistics(): void;
}

// ─── Statistics ─────────────────────────────────────────────────────────

export interface FilterStatistics {
  totalEvaluations: number;
  included: number;
  excluded: number;
  /** Breakdown of exclusion reasons with counts */
  exclusionReasons: Record<string, number>;
  /** Breakdown of which filter types caused exclusions */
  exclusionsByFilter: Record<string, number>;
}

// ─── Re-exports for convenience ─────────────────────────────────────────

export type {
  FileExtensionConfig,
  FolderPathConfig,
  AdvancedFilterConfig,
  FilterCondition,
  FilterGroup,
  FilterOperator,
};
