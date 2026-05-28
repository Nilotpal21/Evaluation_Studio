/**
 * Recommendation Interface
 *
 * Types for the recommendation engine that scores resources, suggests sync
 * strategies, and estimates costs based on discovery results.
 */

// ─── Resource Scoring ───────────────────────────────────────────────────

export interface ResourceScoreFactors {
  /** Score based on recent activity (0-1) */
  activityScore: number;
  /** Score based on collection size (0-1, bell curve) */
  sizeScore: number;
  /** Score based on content richness (0-1) */
  contentScore: number;
  /** Penalty for detected sensitivity indicators (0-1, subtracted) */
  sensitivityPenalty: number;
}

export interface ResourceScore {
  /** ID of the scored resource */
  resourceId: string;
  /** Display name for UI */
  resourceName: string;
  /** Overall recommendation score (0-1) */
  overallScore: number;
  /** Whether this resource is recommended for sync */
  recommended: boolean;
  /** Breakdown of scoring factors */
  factors: ResourceScoreFactors;
  /** Human-readable explanation of the score */
  reasoning: string;
}

// ─── Sync Strategy ──────────────────────────────────────────────────────

export interface SyncStrategyRecommendation {
  /** Recommended sync mode */
  syncMode: 'full_then_delta' | 'full_only';
  /** Cron schedule for full sync (e.g., '0 0 * * 0' for weekly) */
  fullSyncSchedule: string;
  /** Cron schedule for delta sync (e.g., '0 * * * *' for hourly) */
  deltaSyncSchedule: string | null;
  /** Whether to enable webhook-based real-time sync */
  enableWebhooks: boolean;
  /** Explanation of the recommended strategy */
  reasoning: string;
  /** Confidence in this recommendation (0-1) */
  confidence: number;
}

// ─── Permission Mode ────────────────────────────────────────────────────

export interface PermissionRecommendation {
  /** Recommended permission crawling mode */
  mode: 'full' | 'simplified' | 'disabled';
  /** Explanation of the recommendation */
  reasoning: string;
  /** Confidence in this recommendation (0-1) */
  confidence: number;
}

// ─── Filter Recommendation ──────────────────────────────────────────────

export interface FilterRecommendation {
  /** Include or exclude mode */
  mode: 'include' | 'exclude';
  /** Resource IDs to include/exclude */
  resourceIds: string[];
  /** Content types to include (e.g., ['pdf', 'docx', 'pptx']) */
  contentTypes: string[];
  /** Only sync documents modified after this date */
  modifiedSince: Date | null;
  /** Explanation of the filter recommendation */
  reasoning: string;
}

// ─── Cost Estimate ──────────────────────────────────────────────────────

export interface CostEstimate {
  /** Estimated total documents to sync */
  estimatedDocuments: number;
  /** Estimated total storage in bytes */
  estimatedStorageBytes: number;
  /** Estimated initial sync duration in seconds */
  estimatedSyncDurationSeconds: number;
  /** Estimated monthly API calls for ongoing sync */
  estimatedMonthlyApiCalls: number;
}

// ─── Full Recommendation ────────────────────────────────────────────────

export interface ConnectorRecommendation {
  /** Scored resources with recommendations */
  resourceScores: ResourceScore[];
  /** Recommended sync strategy */
  syncStrategy: SyncStrategyRecommendation;
  /** Recommended permission mode */
  permissionMode: PermissionRecommendation;
  /** Recommended filter configuration */
  filterConfig: FilterRecommendation;
  /** Estimated sync costs */
  costEstimate: CostEstimate;
  /** Overall confidence in recommendations (0-1) */
  overallConfidence: number;
  /** When recommendations were generated */
  generatedAt: Date;
}
