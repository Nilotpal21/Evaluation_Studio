/**
 * Recommendation Engine Service
 *
 * Pure scoring service — NO LLM, NO API calls, purely deterministic algorithms.
 * Generates resource scores, sync strategy, permission mode, filter config,
 * and cost estimates from discovery results.
 */

import type {
  ContentProfile,
  DiscoveredResource,
  ResourceScore,
  ResourceScoreFactors,
  SyncStrategyRecommendation,
  PermissionRecommendation,
  FilterRecommendation,
  CostEstimate,
  ConnectorRecommendation,
} from '@agent-platform/connectors-base';

// ─── Scoring Weights ────────────────────────────────────────────────────

const ACTIVITY_WEIGHT = 0.3;
const SIZE_WEIGHT = 0.2;
const CONTENT_WEIGHT = 0.2;
const SENSITIVITY_WEIGHT = 0.3;

// ─── Activity Thresholds (days since last modification) ─────────────────

const ACTIVITY_VERY_RECENT_DAYS = 7;
const ACTIVITY_RECENT_DAYS = 30;
const ACTIVITY_MODERATE_DAYS = 90;

// ─── Size Thresholds (document count) ───────────────────────────────────

const SIZE_IDEAL_MIN = 100;
const SIZE_IDEAL_MAX = 10_000;
const SIZE_SMALL_THRESHOLD = 10;
const SIZE_VERY_LARGE_THRESHOLD = 100_000;

// ─── Sensitivity Penalties ──────────────────────────────────────────────

const SENSITIVITY_PENALTY_MAP: Record<string, number> = {
  pii: 0.3,
  financial: 0.2,
  health: 0.3,
};

/** Resources with overall score below this after sensitivity are not recommended */
const RECOMMENDATION_THRESHOLD = 0.3;

// ─── Rich Content File Types ────────────────────────────────────────────

const RICH_CONTENT_TYPES = new Set([
  'pdf',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'xlsx',
  'xls',
  'txt',
  'md',
  'rtf',
  'html',
  'htm',
  'csv',
]);

const MEDIA_BINARY_TYPES = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'svg',
  'mp4',
  'mp3',
  'wav',
  'avi',
  'mov',
  'zip',
  'tar',
  'gz',
  'exe',
  'dll',
  'bin',
]);

// ─── Sync Estimation Constants ──────────────────────────────────────────

const DOCS_PER_SECOND = 50;
const API_CALLS_PER_PAGE = 1;
const DOCS_PER_API_PAGE = 200;

// ─── Recommendation Engine ──────────────────────────────────────────────

export class RecommendationEngineService {
  /**
   * Generate a complete recommendation from discovery results.
   */
  generateRecommendation(
    resources: DiscoveredResource[],
    profiles: ContentProfile[],
  ): ConnectorRecommendation {
    const profileMap = new Map(profiles.map((p) => [p.resourceId, p]));

    // Score resources (only drives, not sites or errors)
    const driveResources = resources.filter((r) => r.resourceType === 'drive');
    const resourceScores = driveResources.map((resource) => {
      const profile = profileMap.get(resource.id);
      return this.scoreResource(resource, profile);
    });

    // Generate strategy based on aggregate profile data
    const syncStrategy = this.recommendSyncStrategy(profiles);
    const permissionMode = this.recommendPermissionMode();
    const filterConfig = this.recommendFilterConfig(resourceScores, profiles);
    const costEstimate = this.estimateCosts(resourceScores, profiles, syncStrategy);

    // Overall confidence: weighted average of sub-confidences
    const overallConfidence =
      profiles.length > 0
        ? Math.round(((syncStrategy.confidence + permissionMode.confidence + 0.7) / 3) * 100) / 100
        : 0.3;

    return {
      resourceScores,
      syncStrategy,
      permissionMode,
      filterConfig,
      costEstimate,
      overallConfidence,
      generatedAt: new Date(),
    };
  }

  // ─── Resource Scoring ───────────────────────────────────────────────────

  /**
   * Score a single resource on a 0-1 scale.
   */
  scoreResource(resource: DiscoveredResource, profile?: ContentProfile): ResourceScore {
    const factors = this.calculateFactors(profile);

    // Weighted score (sensitivity is subtracted, not added)
    const rawScore =
      factors.activityScore * ACTIVITY_WEIGHT +
      factors.sizeScore * SIZE_WEIGHT +
      factors.contentScore * CONTENT_WEIGHT -
      factors.sensitivityPenalty * SENSITIVITY_WEIGHT;

    const overallScore = Math.max(0, Math.min(1, Math.round(rawScore * 100) / 100));
    const recommended = overallScore >= RECOMMENDATION_THRESHOLD;

    return {
      resourceId: resource.id,
      resourceName: resource.displayName,
      overallScore,
      recommended,
      factors,
      reasoning: this.buildReasoning(factors, overallScore, recommended),
    };
  }

  private calculateFactors(profile?: ContentProfile): ResourceScoreFactors {
    if (!profile) {
      return {
        activityScore: 0.1,
        sizeScore: 0.1,
        contentScore: 0.1,
        sensitivityPenalty: 0,
      };
    }

    return {
      activityScore: this.calculateActivityScore(profile),
      sizeScore: this.calculateSizeScore(profile),
      contentScore: this.calculateContentScore(profile),
      sensitivityPenalty: this.calculateSensitivityPenalty(profile),
    };
  }

  /**
   * Activity score based on recency of modifications.
   */
  private calculateActivityScore(profile: ContentProfile): number {
    if (!profile.dateRange.latest) return 0.1;

    const daysSinceLatest =
      (Date.now() - profile.dateRange.latest.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceLatest <= ACTIVITY_VERY_RECENT_DAYS) return 1.0;
    if (daysSinceLatest <= ACTIVITY_RECENT_DAYS) return 0.7;
    if (daysSinceLatest <= ACTIVITY_MODERATE_DAYS) return 0.4;
    return 0.1;
  }

  /**
   * Size score: bell curve favoring 100-10K docs.
   */
  private calculateSizeScore(profile: ContentProfile): number {
    const count = profile.totalDocuments;
    if (count === 0) return 0;
    if (count < SIZE_SMALL_THRESHOLD) return 0.3;
    if (count >= SIZE_IDEAL_MIN && count <= SIZE_IDEAL_MAX) return 1.0;
    if (count > SIZE_VERY_LARGE_THRESHOLD) return 0.5;
    // Interpolate between thresholds
    if (count < SIZE_IDEAL_MIN) {
      return 0.3 + (0.7 * (count - SIZE_SMALL_THRESHOLD)) / (SIZE_IDEAL_MIN - SIZE_SMALL_THRESHOLD);
    }
    // Between 10K and 100K
    return (
      0.5 +
      (0.5 * (SIZE_VERY_LARGE_THRESHOLD - count)) / (SIZE_VERY_LARGE_THRESHOLD - SIZE_IDEAL_MAX)
    );
  }

  /**
   * Content score based on richness of file types.
   */
  private calculateContentScore(profile: ContentProfile): number {
    const distribution = profile.fileTypeDistribution;
    const totalFiles = Object.values(distribution).reduce((sum, count) => sum + count, 0);
    if (totalFiles === 0) return 0.1;

    let richCount = 0;
    let mediaCount = 0;

    for (const [type, count] of Object.entries(distribution)) {
      if (RICH_CONTENT_TYPES.has(type)) {
        richCount += count;
      } else if (MEDIA_BINARY_TYPES.has(type)) {
        mediaCount += count;
      }
    }

    const richRatio = richCount / totalFiles;
    if (richRatio >= 0.7) return 1.0;
    if (richRatio >= 0.3) return 0.7;
    if (mediaCount / totalFiles >= 0.7) return 0.3;
    return 0.5;
  }

  /**
   * Sensitivity penalty: sum of penalties for each detected indicator.
   */
  private calculateSensitivityPenalty(profile: ContentProfile): number {
    let penalty = 0;
    for (const indicator of profile.sensitivityIndicators) {
      penalty += SENSITIVITY_PENALTY_MAP[indicator] || 0;
    }
    return Math.min(1, penalty);
  }

  private buildReasoning(
    factors: ResourceScoreFactors,
    overallScore: number,
    recommended: boolean,
  ): string {
    const parts: string[] = [];

    if (factors.activityScore >= 0.7) {
      parts.push('recently active');
    } else if (factors.activityScore <= 0.2) {
      parts.push('inactive');
    }

    if (factors.sizeScore >= 0.8) {
      parts.push('ideal size');
    } else if (factors.sizeScore <= 0.3) {
      parts.push('very few documents');
    }

    if (factors.contentScore >= 0.7) {
      parts.push('rich content');
    } else if (factors.contentScore <= 0.3) {
      parts.push('mostly binary/media');
    }

    if (factors.sensitivityPenalty > 0) {
      parts.push('contains sensitive data');
    }

    const status = recommended ? 'Recommended' : 'Not recommended';
    const detail = parts.length > 0 ? `: ${parts.join(', ')}` : '';
    return `${status} (score: ${overallScore})${detail}`;
  }

  // ─── Sync Strategy ────────────────────────────────────────────────────

  recommendSyncStrategy(profiles: ContentProfile[]): SyncStrategyRecommendation {
    if (profiles.length === 0) {
      return {
        syncMode: 'full_only',
        fullSyncSchedule: '0 0 * * *',
        deltaSyncSchedule: null,
        enableWebhooks: false,
        reasoning: 'No content profiles available; defaulting to daily full sync.',
        confidence: 0.3,
      };
    }

    // Determine dominant update frequency
    const freqCounts: Record<string, number> = { daily: 0, weekly: 0, monthly: 0, rarely: 0 };
    for (const p of profiles) {
      freqCounts[p.updateFrequency]++;
    }

    // Find the dominant update frequency
    let dominant: string = 'rarely';
    let maxCount = freqCounts.rarely;
    for (const [freq, count] of Object.entries(freqCounts)) {
      if (count > maxCount) {
        dominant = freq;
        maxCount = count;
      }
    }

    if (dominant === 'daily') {
      return {
        syncMode: 'full_then_delta',
        fullSyncSchedule: '0 0 * * 0',
        deltaSyncSchedule: '0 * * * *',
        enableWebhooks: true,
        reasoning:
          'Frequently updated content detected. Hourly delta sync with webhooks for real-time updates.',
        confidence: 0.85,
      };
    }

    if (dominant === 'weekly') {
      return {
        syncMode: 'full_then_delta',
        fullSyncSchedule: '0 0 * * 0',
        deltaSyncSchedule: '0 */6 * * *',
        enableWebhooks: false,
        reasoning: 'Moderately updated content. 6-hour delta sync schedule.',
        confidence: 0.75,
      };
    }

    return {
      syncMode: 'full_only',
      fullSyncSchedule: '0 0 * * *',
      deltaSyncSchedule: null,
      enableWebhooks: false,
      reasoning: 'Infrequently updated content. Daily full sync is sufficient.',
      confidence: 0.7,
    };
  }

  // ─── Permission Mode ──────────────────────────────────────────────────

  recommendPermissionMode(): PermissionRecommendation {
    // Without permission sample data, default to simplified mode
    return {
      mode: 'simplified',
      reasoning:
        'Simplified mode provides 95% accuracy with lower API overhead. Upgrade to full mode if strict access control is required.',
      confidence: 0.7,
    };
  }

  // ─── Filter Config ────────────────────────────────────────────────────

  recommendFilterConfig(scores: ResourceScore[], profiles: ContentProfile[]): FilterRecommendation {
    const recommendedIds = scores.filter((s) => s.recommended).map((s) => s.resourceId);

    // Determine content types from profiles
    const typeCounts: Record<string, number> = {};
    for (const p of profiles) {
      for (const [type, count] of Object.entries(p.fileTypeDistribution)) {
        typeCounts[type] = (typeCounts[type] || 0) + count;
      }
    }

    // Include rich content types that are actually present
    const contentTypes = Object.keys(typeCounts).filter((t) => RICH_CONTENT_TYPES.has(t));

    const notRecommendedCount = scores.length - recommendedIds.length;
    const reasoning =
      notRecommendedCount > 0
        ? `Excluding ${notRecommendedCount} resource(s) due to low activity, sensitivity, or unsuitable content.`
        : 'All discovered resources are recommended for sync.';

    return {
      mode: 'include',
      resourceIds: recommendedIds,
      contentTypes: contentTypes.length > 0 ? contentTypes : [],
      modifiedSince: null,
      reasoning,
    };
  }

  // ─── Cost Estimation ──────────────────────────────────────────────────

  estimateCosts(
    scores: ResourceScore[],
    profiles: ContentProfile[],
    syncStrategy: SyncStrategyRecommendation,
  ): CostEstimate {
    const recommendedIds = new Set(scores.filter((s) => s.recommended).map((s) => s.resourceId));
    const recommendedProfiles = profiles.filter((p) => recommendedIds.has(p.resourceId));

    const estimatedDocuments = recommendedProfiles.reduce((sum, p) => sum + p.totalDocuments, 0);
    const estimatedStorageBytes = recommendedProfiles.reduce((sum, p) => sum + p.totalSizeBytes, 0);
    const estimatedSyncDurationSeconds =
      estimatedDocuments > 0 ? Math.ceil(estimatedDocuments / DOCS_PER_SECOND) : 0;

    // Monthly API calls based on sync frequency
    const pagesPerSync = Math.ceil(estimatedDocuments / DOCS_PER_API_PAGE);
    let syncsPerMonth: number;

    if (syncStrategy.deltaSyncSchedule) {
      // Delta syncs: assume ~5% change per sync
      const deltaPages = Math.max(1, Math.ceil(pagesPerSync * 0.05));
      if (syncStrategy.deltaSyncSchedule.includes('*/6')) {
        syncsPerMonth = 4 * 30; // Every 6 hours
      } else {
        syncsPerMonth = 24 * 30; // Every hour
      }
      const fullSyncsPerMonth = 4; // Weekly full sync
      return {
        estimatedDocuments,
        estimatedStorageBytes,
        estimatedSyncDurationSeconds,
        estimatedMonthlyApiCalls:
          fullSyncsPerMonth * pagesPerSync * API_CALLS_PER_PAGE +
          syncsPerMonth * deltaPages * API_CALLS_PER_PAGE,
      };
    }

    // Full sync only: daily
    syncsPerMonth = 30;
    return {
      estimatedDocuments,
      estimatedStorageBytes,
      estimatedSyncDurationSeconds,
      estimatedMonthlyApiCalls: syncsPerMonth * pagesPerSync * API_CALLS_PER_PAGE,
    };
  }
}
