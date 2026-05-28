/**
 * SharePoint Filter Engine
 *
 * Extends BaseFilterEngine with SharePoint-specific scope evaluation:
 * - Site filtering (by ID or URL pattern)
 * - Library filtering (by name or pattern)
 * - SharePoint content category support (files vs pages)
 *
 * Scope filters (sites, libraries, folders) are primarily applied at the
 * enumeration level in the sync coordinator. This engine provides document-level
 * re-evaluation as a safety net and for items that bypass enumeration filtering.
 */

import {
  BaseFilterEngine,
  type FilterConfig,
  type FilterValidationError,
  type FolderPathConfig,
} from '@agent-platform/connectors-base';
import type { SourceDocument } from '@agent-platform/connectors-base';

// ─── SharePoint Scope Config ────────────────────────────────────────────

/**
 * SharePoint-specific scope configuration.
 * Controls which sites, libraries, and folders to enumerate.
 */
export interface SharePointScopeConfig {
  /** Site selection mode */
  siteMode: 'all' | 'selected' | 'excluded';
  /** Site IDs (from discovery) for 'selected' or 'excluded' mode */
  siteIds: string[];
  /** Site URL glob patterns (alternative to IDs) */
  sitePatterns: string[];

  /** Library selection mode */
  libraryMode: 'all' | 'selected' | 'excluded';
  /** Library names for 'selected' or 'excluded' mode (exact match) */
  libraryNames: string[];
  /** Library name glob patterns */
  libraryPatterns: string[];

  /** Folder path filtering */
  folderPaths: FolderPathConfig;
}

// ─── SharePoint Scope Defaults ──────────────────────────────────────────

const DEFAULT_SHAREPOINT_SCOPE: SharePointScopeConfig = {
  siteMode: 'all',
  siteIds: [],
  sitePatterns: [],
  libraryMode: 'all',
  libraryNames: [],
  libraryPatterns: [],
  folderPaths: { include: [], exclude: [] },
};

// ─── SharePoint Filter Engine ───────────────────────────────────────────

export class SharePointFilterEngine extends BaseFilterEngine {
  private readonly spScope: SharePointScopeConfig;
  /** Pre-compiled regex patterns for site URL globs */
  private readonly compiledSitePatterns: RegExp[];
  /** Pre-compiled regex patterns for library name globs */
  private readonly compiledLibraryPatterns: RegExp[];

  constructor(config: FilterConfig) {
    super(config, 'sharepoint');
    this.spScope = {
      ...DEFAULT_SHAREPOINT_SCOPE,
      ...(config.scope as Partial<SharePointScopeConfig>),
    };

    // Pre-compile glob patterns once (avoid per-call regex creation)
    this.compiledSitePatterns = this.spScope.sitePatterns.map((p) => globToRegex(p));
    this.compiledLibraryPatterns = this.spScope.libraryPatterns.map((p) => globToRegex(p));
  }

  /**
   * Get the resolved SharePoint scope configuration.
   * Useful for sync coordinators to determine which sites/libraries to enumerate.
   */
  getSharePointScope(): SharePointScopeConfig {
    return this.spScope;
  }

  // ─── Scope Evaluation (Document-Level Safety Net) ─────────────────────

  /**
   * Evaluate SharePoint-specific scope for a document.
   *
   * This is a document-level re-check. Primary scope filtering happens
   * during site/library enumeration in the sync coordinator. This catches
   * edge cases where documents might slip through enumeration filtering.
   */
  protected evaluateScope(document: SourceDocument): {
    passed: boolean;
    applied: boolean;
    reason?: string;
  } {
    const metadata = document.metadata?.sharepoint;
    if (!metadata) {
      // No SharePoint metadata — can't evaluate scope, allow by default
      return { passed: true, applied: false };
    }

    // Check content category
    const categoryResult = this.evaluateContentCategory(document);
    if (!categoryResult.passed) {
      return categoryResult;
    }

    // Check site scope
    const siteResult = this.evaluateSiteScope(metadata.siteId, metadata.siteUrl);
    if (!siteResult.passed) {
      return siteResult;
    }

    // Check library scope
    const libraryResult = this.evaluateLibraryScope(metadata.driveName);
    if (!libraryResult.passed) {
      return libraryResult;
    }

    return { passed: true, applied: true };
  }

  /**
   * Validate SharePoint-specific scope configuration.
   */
  protected validateScope(
    errors: FilterValidationError[],
    warnings: FilterValidationError[],
  ): void {
    // Validate site mode
    if (!['all', 'selected', 'excluded'].includes(this.spScope.siteMode)) {
      errors.push({
        field: 'scope.siteMode',
        message: 'Must be "all", "selected", or "excluded"',
        severity: 'error',
      });
    }

    // Selected mode requires at least one site
    if (this.spScope.siteMode === 'selected') {
      if (this.spScope.siteIds.length === 0 && this.spScope.sitePatterns.length === 0) {
        errors.push({
          field: 'scope.siteIds',
          message: 'At least one site ID or pattern required when siteMode is "selected"',
          severity: 'error',
        });
      }
    }

    // Validate library mode
    if (!['all', 'selected', 'excluded'].includes(this.spScope.libraryMode)) {
      errors.push({
        field: 'scope.libraryMode',
        message: 'Must be "all", "selected", or "excluded"',
        severity: 'error',
      });
    }

    // Selected mode requires at least one library
    if (this.spScope.libraryMode === 'selected') {
      if (this.spScope.libraryNames.length === 0 && this.spScope.libraryPatterns.length === 0) {
        errors.push({
          field: 'scope.libraryNames',
          message: 'At least one library name or pattern required when libraryMode is "selected"',
          severity: 'error',
        });
      }
    }

    // Validate site patterns are valid globs
    for (const pattern of this.spScope.sitePatterns) {
      if (!pattern || pattern.trim().length === 0) {
        errors.push({
          field: 'scope.sitePatterns',
          message: 'Site patterns must be non-empty strings',
          severity: 'error',
        });
      }
    }

    // Detect conflict: selected sites with excluded libraries may result in zero content
    if (
      this.spScope.siteMode === 'selected' &&
      this.spScope.libraryMode === 'excluded' &&
      this.spScope.libraryNames.length > 0
    ) {
      warnings.push({
        field: 'scope',
        message:
          'Selected sites with excluded libraries: verify this does not exclude all content from selected sites',
        severity: 'warning',
      });
    }
  }

  // ─── Scope Helpers ────────────────────────────────────────────────────

  /**
   * Check if a site should be included based on scope configuration.
   * Used by sync coordinators during site enumeration.
   */
  shouldIncludeSite(siteId: string, siteUrl: string): boolean {
    return this.evaluateSiteScope(siteId, siteUrl).passed;
  }

  /**
   * Check if a library should be included based on scope configuration.
   * Used by sync coordinators during library enumeration.
   */
  shouldIncludeLibrary(libraryName: string): boolean {
    return this.evaluateLibraryScope(libraryName).passed;
  }

  // ─── Private Evaluators ───────────────────────────────────────────────

  private evaluateContentCategory(document: SourceDocument): {
    passed: boolean;
    applied: boolean;
    reason?: string;
  } {
    const categories = this.config.standard.contentCategories;
    if (!categories || categories.length === 0) {
      return { passed: true, applied: false };
    }

    // Determine document's content category from MIME type
    const category = this.getContentCategory(document.contentType);

    if (categories.includes(category)) {
      return { passed: true, applied: true };
    }

    return {
      passed: false,
      applied: true,
      reason: `Content category '${category}' not in configured categories: [${categories.join(', ')}]`,
    };
  }

  private evaluateSiteScope(
    siteId: string,
    siteUrl: string,
  ): { passed: boolean; applied: boolean; reason?: string } {
    if (this.spScope.siteMode === 'all') {
      return { passed: true, applied: false };
    }

    const matchesId = this.spScope.siteIds.includes(siteId);
    const matchesPattern = this.compiledSitePatterns.some((regex) =>
      regex.test(siteUrl.toLowerCase()),
    );
    const matches = matchesId || matchesPattern;

    if (this.spScope.siteMode === 'selected') {
      return matches
        ? { passed: true, applied: true }
        : { passed: false, applied: true, reason: `Site not in selected list: ${siteUrl}` };
    }

    // excluded mode
    return matches
      ? { passed: false, applied: true, reason: `Site in excluded list: ${siteUrl}` }
      : { passed: true, applied: true };
  }

  private evaluateLibraryScope(libraryName: string): {
    passed: boolean;
    applied: boolean;
    reason?: string;
  } {
    if (this.spScope.libraryMode === 'all') {
      return { passed: true, applied: false };
    }

    const matchesName = this.spScope.libraryNames.some(
      (name) => name.toLowerCase() === libraryName.toLowerCase(),
    );
    const matchesPattern = this.compiledLibraryPatterns.some((regex) =>
      regex.test(libraryName.toLowerCase()),
    );
    const matches = matchesName || matchesPattern;

    if (this.spScope.libraryMode === 'selected') {
      return matches
        ? { passed: true, applied: true }
        : { passed: false, applied: true, reason: `Library not in selected list: ${libraryName}` };
    }

    // excluded mode
    return matches
      ? { passed: false, applied: true, reason: `Library in excluded list: ${libraryName}` }
      : { passed: true, applied: true };
  }

  /**
   * Map MIME type to content category.
   */
  private getContentCategory(mimeType: string): string {
    const lower = mimeType.toLowerCase();
    if (lower === 'text/html' || lower.includes('sharepoint.page')) {
      return 'pages';
    }
    return 'files';
  }
}

// ─── Glob Compilation Utility ────────────────────────────────────────────

/**
 * Compile a glob pattern to a RegExp for reuse.
 * Supports * (any characters except /) and ** (any characters including /).
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '^';
  const lowerPattern = pattern.toLowerCase();
  for (let i = 0; i < lowerPattern.length; i++) {
    const char = lowerPattern[i];
    if (char === '*') {
      if (lowerPattern[i + 1] === '*') {
        regexStr += '.*';
        i++; // Skip next *
      } else {
        regexStr += '[^/]*';
      }
    } else if (char === '?') {
      regexStr += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      regexStr += '\\' + char;
    } else {
      regexStr += char;
    }
  }
  regexStr += '$';

  try {
    return new RegExp(regexStr, 'i');
  } catch {
    // If pattern is invalid, return a regex that never matches
    return /(?!)/;
  }
}
