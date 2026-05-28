/**
 * Base Filter Engine
 *
 * Abstract base class implementing common filter logic.
 * Concrete connectors extend this with provider-specific scope evaluation.
 *
 * Filter evaluation order (cheapest first, AND logic):
 * 1. File extension (string lookup — fastest)
 * 2. File size (number compare)
 * 3. Date range (number compare)
 * 4. Folder path (glob pattern match)
 * 5. Connector-specific scope + content category (subclass override)
 * 6. Advanced conditions (field/operator/value evaluation — most expensive)
 */

import type {
  IFilterEngine,
  FilterConfig,
  FilterEvaluationResult,
  FilterValidationResult,
  FilterValidationError,
  FilterStatistics,
} from '../interfaces/filter-engine.interface.js';
import type { SourceDocument } from '../interfaces/sync-coordinator.interface.js';
import { FileExtensionRegistry, type FileExtensionConfig } from './file-extension-registry.js';
import { FolderPathMatcher, type FolderPathConfig } from './folder-path-matcher.js';
import { AdvancedFilterEvaluator, type AdvancedFilterConfig } from './advanced-filter-evaluator.js';

// ─── Internal Statistics ────────────────────────────────────────────────

interface InternalStats {
  totalEvaluations: number;
  included: number;
  excluded: number;
  exclusionReasons: Map<string, number>;
  exclusionsByFilter: Map<string, number>;
}

// ─── Base Filter Engine ─────────────────────────────────────────────────

export abstract class BaseFilterEngine implements IFilterEngine {
  readonly config: FilterConfig;

  protected readonly extensionRegistry: FileExtensionRegistry;
  protected readonly folderPathMatcher: FolderPathMatcher;
  protected readonly advancedEvaluator: AdvancedFilterEvaluator;

  private stats: InternalStats;

  constructor(config: FilterConfig, connectorType: string) {
    this.config = config;

    // Initialize sub-engines — guard against incomplete filterConfig from legacy connectors
    this.extensionRegistry = new FileExtensionRegistry(
      connectorType,
      config.standard?.fileExtensions ?? undefined,
    );

    const folderConfig = (config.scope as { folderPaths?: FolderPathConfig } | undefined)
      ?.folderPaths ?? {
      include: [],
      exclude: [],
    };
    this.folderPathMatcher = new FolderPathMatcher(folderConfig);

    this.advancedEvaluator = new AdvancedFilterEvaluator(
      config.advancedFilters ?? { enabled: false, rootOperator: 'AND', conditions: [], groups: [] },
    );

    this.stats = this.createEmptyStats();
  }

  /**
   * Evaluate whether document should be included.
   * Uses AND logic: all configured filters must pass.
   * Evaluates cheapest filters first for early exit.
   */
  evaluate(document: SourceDocument): FilterEvaluationResult {
    this.stats.totalEvaluations++;

    const appliedFilters: string[] = [];

    // 1. File extension check (fastest — simple set lookup)
    const extResult = this.evaluateFileExtension(document);
    if (!extResult.passed) {
      return this.recordExclusion(extResult.reason ?? 'File extension rejected', 'fileExtension');
    }
    if (extResult.applied) appliedFilters.push('fileExtension');

    // 2. Size filter (number comparison)
    const sizeResult = this.evaluateSizeFilter(document);
    if (!sizeResult.passed) {
      return this.recordExclusion(sizeResult.reason ?? 'Size filter rejected', 'size');
    }
    if (sizeResult.applied) appliedFilters.push('size');

    // 3. Date filter (number comparison)
    const dateResult = this.evaluateDateFilter(document);
    if (!dateResult.passed) {
      return this.recordExclusion(dateResult.reason ?? 'Date filter rejected', 'date');
    }
    if (dateResult.applied) appliedFilters.push('date');

    // 4. Folder path (glob pattern matching)
    const folderResult = this.evaluateFolderPath(document);
    if (!folderResult.passed) {
      return this.recordExclusion(folderResult.reason ?? 'Folder path rejected', 'folderPath');
    }
    if (folderResult.applied) appliedFilters.push('folderPath');

    // 5. Connector-specific scope — includes content category filtering (subclass override)
    const scopeResult = this.evaluateScope(document);
    if (!scopeResult.passed) {
      return this.recordExclusion(scopeResult.reason ?? 'Scope filter rejected', 'scope');
    }
    if (scopeResult.applied) appliedFilters.push('scope');

    // 6. Advanced conditions (most expensive — field resolution + comparison)
    const advResult = this.advancedEvaluator.evaluate(document);
    if (!advResult.passed) {
      return this.recordExclusion(advResult.reason ?? 'Advanced filter rejected', 'advanced');
    }
    if (this.config.advancedFilters.enabled) appliedFilters.push('advanced');

    // All filters passed
    this.stats.included++;
    return { include: true, appliedFilters };
  }

  /**
   * Validate filter configuration.
   */
  validate(): FilterValidationResult {
    const errors: FilterValidationError[] = [];
    const warnings: FilterValidationError[] = [];

    // Validate standard filters
    this.validateStandardFilters(errors, warnings);

    // Validate advanced filters
    const advValidation = this.advancedEvaluator.validate();
    for (const err of advValidation.errors) {
      errors.push({
        field: `advancedFilters.${err.field}`,
        message: err.message,
        severity: 'error',
      });
    }

    // Validate connector-specific scope (subclass)
    this.validateScope(errors, warnings);

    // Detect filter conflicts
    this.detectConflicts(warnings);

    return {
      valid: errors.filter((e) => e.severity === 'error').length === 0,
      errors: errors.filter((e) => e.severity === 'error'),
      warnings: [...warnings, ...errors.filter((e) => e.severity === 'warning')],
    };
  }

  /**
   * Get filter statistics.
   */
  getStatistics(): FilterStatistics {
    return {
      totalEvaluations: this.stats.totalEvaluations,
      included: this.stats.included,
      excluded: this.stats.excluded,
      exclusionReasons: Object.fromEntries(this.stats.exclusionReasons),
      exclusionsByFilter: Object.fromEntries(this.stats.exclusionsByFilter),
    };
  }

  /**
   * Reset statistics.
   */
  resetStatistics(): void {
    this.stats = this.createEmptyStats();
  }

  // ─── Subclass Override Points ─────────────────────────────────────────

  /**
   * Evaluate connector-specific scope filters.
   * Override in concrete implementations.
   *
   * SharePoint: checks site/library scope at document level.
   * (Site/library-level scope is applied earlier during enumeration.)
   */
  protected evaluateScope(document: SourceDocument): EvalResult {
    return { passed: true, applied: false };
  }

  /**
   * Validate connector-specific scope configuration.
   * Override in concrete implementations.
   */
  protected validateScope(
    errors: FilterValidationError[],
    warnings: FilterValidationError[],
  ): void {
    // Default: no connector-specific validation
  }

  // ─── Standard Filter Evaluators ───────────────────────────────────────

  private evaluateFileExtension(document: SourceDocument): EvalResult {
    const result = this.extensionRegistry.check(document.name);
    if (!result.allowed) {
      return { passed: false, applied: true, reason: result.reason };
    }
    return { passed: true, applied: result.source !== 'connector_default' || result.allowed };
  }

  private evaluateSizeFilter(document: SourceDocument): EvalResult {
    const { maxFileSizeBytes, minFileSizeBytes } = this.config.standard;
    let applied = false;

    if (minFileSizeBytes !== null && minFileSizeBytes !== undefined) {
      applied = true;
      if (document.sizeBytes < minFileSizeBytes) {
        return {
          passed: false,
          applied: true,
          reason: `File too small: ${document.sizeBytes} bytes (min: ${minFileSizeBytes})`,
        };
      }
    }

    if (maxFileSizeBytes !== null && maxFileSizeBytes !== undefined) {
      applied = true;
      if (document.sizeBytes > maxFileSizeBytes) {
        return {
          passed: false,
          applied: true,
          reason: `File too large: ${document.sizeBytes} bytes (max: ${maxFileSizeBytes})`,
        };
      }
    }

    return { passed: true, applied };
  }

  private evaluateDateFilter(document: SourceDocument): EvalResult {
    const { modifiedAfter, modifiedBefore, createdAfter, createdBefore } = this.config.standard;
    let applied = false;

    if (modifiedAfter) {
      applied = true;
      if (document.modifiedAt < modifiedAfter) {
        return { passed: false, applied: true, reason: 'Modified before threshold' };
      }
    }

    if (modifiedBefore) {
      applied = true;
      if (document.modifiedAt > modifiedBefore) {
        return { passed: false, applied: true, reason: 'Modified after threshold' };
      }
    }

    if (createdAfter) {
      applied = true;
      if (document.createdAt < createdAfter) {
        return { passed: false, applied: true, reason: 'Created before threshold' };
      }
    }

    if (createdBefore) {
      applied = true;
      if (document.createdAt > createdBefore) {
        return { passed: false, applied: true, reason: 'Created after threshold' };
      }
    }

    return { passed: true, applied };
  }

  private evaluateFolderPath(document: SourceDocument): EvalResult {
    if (!this.folderPathMatcher.hasFilters()) {
      return { passed: true, applied: false };
    }

    // Extract folder path from document metadata using generic convention.
    // Connectors should populate metadata.folderPath during mapToSourceDocument().
    const parentPath = (document.metadata?.folderPath as string) ?? null;

    if (!parentPath) {
      // No folder path available — allow by default
      return { passed: true, applied: false };
    }

    const result = this.folderPathMatcher.isDocumentAllowed(parentPath);
    if (!result.allowed) {
      return { passed: false, applied: true, reason: result.reason };
    }

    return { passed: true, applied: true };
  }

  // ─── Validation Helpers ───────────────────────────────────────────────

  private validateStandardFilters(
    errors: FilterValidationError[],
    warnings: FilterValidationError[],
  ): void {
    const { standard } = this.config;

    // Validate date ranges
    if (standard.modifiedAfter && standard.modifiedBefore) {
      if (standard.modifiedAfter > standard.modifiedBefore) {
        errors.push({
          field: 'standard.modifiedAfter',
          message: 'modifiedAfter must be before modifiedBefore',
          severity: 'error',
        });
      }
    }

    if (standard.createdAfter && standard.createdBefore) {
      if (standard.createdAfter > standard.createdBefore) {
        errors.push({
          field: 'standard.createdAfter',
          message: 'createdAfter must be before createdBefore',
          severity: 'error',
        });
      }
    }

    // Validate size range
    if (
      standard.minFileSizeBytes !== null &&
      standard.maxFileSizeBytes !== null &&
      standard.minFileSizeBytes !== undefined &&
      standard.maxFileSizeBytes !== undefined &&
      standard.minFileSizeBytes > standard.maxFileSizeBytes
    ) {
      errors.push({
        field: 'standard.minFileSizeBytes',
        message: 'minFileSizeBytes must be <= maxFileSizeBytes',
        severity: 'error',
      });
    }

    // Validate file extensions
    if (standard.fileExtensions) {
      if (!['allowlist', 'denylist'].includes(standard.fileExtensions.mode)) {
        errors.push({
          field: 'standard.fileExtensions.mode',
          message: 'Must be "allowlist" or "denylist"',
          severity: 'error',
        });
      }
      if (!Array.isArray(standard.fileExtensions.extensions)) {
        errors.push({
          field: 'standard.fileExtensions.extensions',
          message: 'Must be an array of strings',
          severity: 'error',
        });
      }
    }

    // Validate content categories
    if (standard.contentCategories && standard.contentCategories.length === 0) {
      warnings.push({
        field: 'standard.contentCategories',
        message: 'Empty contentCategories will sync all content types',
        severity: 'warning',
      });
    }
  }

  /**
   * Detect logical conflicts between filters.
   */
  private detectConflicts(warnings: FilterValidationError[]): void {
    // Warning: very restrictive date range
    const { modifiedAfter, modifiedBefore } = this.config.standard;
    if (modifiedAfter && modifiedBefore) {
      const diffDays = (modifiedBefore.getTime() - modifiedAfter.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays < 1) {
        warnings.push({
          field: 'standard.modifiedAfter',
          message: `Date range is less than 1 day (${diffDays.toFixed(1)} days). This may exclude most content.`,
          severity: 'warning',
        });
      }
    }

    // Warning: very small size range
    const { minFileSizeBytes, maxFileSizeBytes } = this.config.standard;
    if (
      minFileSizeBytes !== null &&
      maxFileSizeBytes !== null &&
      minFileSizeBytes !== undefined &&
      maxFileSizeBytes !== undefined
    ) {
      if (maxFileSizeBytes - minFileSizeBytes < 1024) {
        warnings.push({
          field: 'standard.maxFileSizeBytes',
          message: 'Size range is less than 1KB. This may exclude most content.',
          severity: 'warning',
        });
      }
    }
  }

  // ─── Utility ──────────────────────────────────────────────────────────

  private recordExclusion(reason: string, filterType: string): FilterEvaluationResult {
    this.stats.excluded++;
    this.stats.exclusionReasons.set(reason, (this.stats.exclusionReasons.get(reason) ?? 0) + 1);
    this.stats.exclusionsByFilter.set(
      filterType,
      (this.stats.exclusionsByFilter.get(filterType) ?? 0) + 1,
    );
    return { include: false, reason, appliedFilters: [filterType] };
  }

  private createEmptyStats(): InternalStats {
    return {
      totalEvaluations: 0,
      included: 0,
      excluded: 0,
      exclusionReasons: new Map(),
      exclusionsByFilter: new Map(),
    };
  }
}

// ─── Internal Types ─────────────────────────────────────────────────────

interface EvalResult {
  passed: boolean;
  applied: boolean;
  reason?: string;
}
