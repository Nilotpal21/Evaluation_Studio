/**
 * Browse SDK — Shared Types
 *
 * Types and constants used across browse service layer (facet queries,
 * taxonomy cache, browse router).
 */

/** Max document IDs for an OpenSearch terms query (65K clause limit) */
export const DOC_ID_THRESHOLD = 65_536;

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetResult {
  attributeType: string;
  productType: string;
  dataType: string;
  values: FacetValue[];
  total: number;
}

export interface FacetCountResult {
  attributeType: string;
  productType: string;
  count: number;
}

export interface FacetDocumentsResult {
  documentIds: string[];
  total: number;
  /**
   * True when total exceeds DOC_ID_THRESHOLD (65K) — signals the SDK
   * that using these doc IDs in a terms query would exceed OpenSearch limits.
   * Note: this does NOT indicate pagination truncation (use total vs documentIds.length for that).
   */
  truncated: boolean;
}

// ─── Facet Display Rules ─────────────────────────────────────────────
export interface FacetDisplayConfig {
  maxVisibleFacets: number;
  maxBetaFacets: number;
  minDistinctValues: number;
}

export const DEFAULT_FACET_DISPLAY_CONFIG: FacetDisplayConfig = {
  maxVisibleFacets: 8,
  maxBetaFacets: 3,
  minDistinctValues: 2,
};

export interface DisplayFacet {
  attributeType: string;
  productScope: string;
  displayName: string;
  tier: string;
  isBeta: boolean;
  dataType: string;
  distinctValueCount: number;
  impressionCount: number;
}
