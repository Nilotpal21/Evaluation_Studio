/**
 * Test helper: builds valid FilterConfig objects for SharePoint tests.
 *
 * The FilterConfig interface requires { standard, scope, advancedFilters, version }.
 * This factory provides sensible defaults so tests can focus on the fields they care about.
 */

import type { FilterConfig, StandardFilterConfig } from '@agent-platform/connectors-base';
import type { SharePointScopeConfig } from '../../filters/sharepoint-filter-engine.js';

// ─── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_STANDARD: StandardFilterConfig = {
  contentCategories: [],
  fileExtensions: null,
  maxFileSizeBytes: null,
  minFileSizeBytes: null,
  modifiedAfter: null,
  modifiedBefore: null,
  createdAfter: null,
  createdBefore: null,
};

const DEFAULT_SCOPE: SharePointScopeConfig = {
  siteMode: 'all',
  siteIds: [],
  sitePatterns: [],
  libraryMode: 'all',
  libraryNames: [],
  libraryPatterns: [],
  folderPaths: { include: [], exclude: [] },
};

const DEFAULT_ADVANCED = {
  enabled: false,
  rootOperator: 'AND' as const,
  conditions: [],
  groups: [],
};

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a valid FilterConfig with overrides for any section.
 */
export function createFilterConfig(overrides?: {
  standard?: Partial<StandardFilterConfig>;
  scope?: Partial<SharePointScopeConfig>;
  advancedFilters?: Partial<typeof DEFAULT_ADVANCED>;
  version?: number;
}): FilterConfig {
  return {
    standard: { ...DEFAULT_STANDARD, ...overrides?.standard },
    scope: { ...DEFAULT_SCOPE, ...overrides?.scope } as Record<string, unknown>,
    advancedFilters: { ...DEFAULT_ADVANCED, ...overrides?.advancedFilters },
    version: overrides?.version ?? 1,
  };
}
