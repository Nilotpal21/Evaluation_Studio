/**
 * Reconciliation Service — Shared Types
 *
 * Configuration and result types for the attribute reconciliation pipeline.
 */

// ─── Configuration ──────────────────────────────────────────────────────────

export interface ReconciliationConfig {
  /** Cosine similarity threshold to merge a novel into an existing attribute */
  cosineMatchThreshold: number;
  /** Distance threshold for agglomerative clustering (1 - cosine similarity) */
  clusterDistanceThreshold: number;
  /** Minimum document count required for promotion */
  promotionDocCountMin: number;
  /** Minimum confidence required for promotion */
  promotionConfidenceMin: number;
  /** Below this document count AND older than discardMinAgeMs, discard the attribute */
  discardDocCountMax: number;
  /** Minimum age (ms) before a low-count attribute can be discarded.
   *  Prevents premature discard of newly discovered attributes that haven't
   *  had time to accumulate document evidence. Default: 7 days. */
  discardMinAgeMs: number;

  // ─── Interaction-based promotion/demotion ─────────────────────────────
  /** Minimum click rate (clicks/impressions) for interaction-based promotion */
  promotionClickRateMin: number;
  /** Minimum unique users for interaction-based promotion */
  promotionUniqueUsersMin: number;
  /** Minimum impressions before interaction data is considered */
  promotionImpressionsMin: number;
  /** Click rate below which an approved attribute is demoted to beta */
  demotionClickRateMax: number;
  /** Minimum impressions before demotion is considered */
  demotionImpressionsMin: number;
  /** Rolling window in days for interaction aggregation */
  interactionWindowDays: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  cosineMatchThreshold: 0.85,
  clusterDistanceThreshold: 0.2,
  promotionDocCountMin: 50,
  promotionConfidenceMin: 0.8,
  discardDocCountMax: 5,
  discardMinAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Interaction-based thresholds
  promotionClickRateMin: 0.05,
  promotionUniqueUsersMin: 3,
  promotionImpressionsMin: 100,
  demotionClickRateMax: 0.01,
  demotionImpressionsMin: 20,
  interactionWindowDays: 14,
};

// ─── Interaction Stats ──────────────────────────────────────────────────────

export interface InteractionStats {
  impressions: number;
  clicks: number;
  uniqueUsers: number;
  clickRate: number;
}

// ─── Result ─────────────────────────────────────────────────────────────────

export interface ReconciliationResult {
  tenantId: string;
  indexId: string;
  productScope: string;
  mergedIntoExisting: number;
  clustered: number;
  promoted: number;
  discarded: number;
  unchanged: number;
  /** Duration in milliseconds */
  duration: number;
}
