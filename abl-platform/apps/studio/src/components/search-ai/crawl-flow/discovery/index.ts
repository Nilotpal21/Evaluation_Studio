/**
 * Discovery utilities barrel — re-exports pure functions
 * used by coverage analysis, batch preview, and tree rendering.
 */

// Tree operations
export {
  formatDisplayName,
  formatUrlForDisplay,
  findNode,
  walkTree,
  flattenTree,
  countNodes,
  upsertNode,
  updateTree,
  computeVisibleNodes,
  getNodeActions,
  computeSubtreeCounts,
  AUTO_COLLAPSE_THRESHOLD,
} from './tree-utils';

// Coverage operations
export {
  buildCoverageAnalysis,
  assessCategoryConfidence,
  deriveCategoryLabel,
  mergeDiscoveryResults,
  shouldSuggestMoreDiscovery,
  pickPreviewUrls,
  MAX_PREVIEW_URLS,
} from './coverage-utils';

// URL set
export {
  DiscoveredUrlSet,
  extractLastSegment,
  normalizeDiscoveryUrl,
  normalizePattern,
  isSubsetOf,
  MAX_DISCOVERED_URLS,
} from './url-set';
