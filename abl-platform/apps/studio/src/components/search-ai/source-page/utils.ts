/**
 * Unified Source Page — Pure utility functions
 *
 * All functions are pure (no side effects) and unit-testable without mocks.
 */

import type { SearchAISource } from '@/api/search-ai';
import type { CrawlJob } from '@/api/crawl';
import type { DisplayState } from './types';
import { USP_TABS, DEFAULT_TAB, type USPTab } from './types';

// ─── Job statuses that indicate active work ─────────────────────────────────

const ACTIVE_JOB_STATUSES = new Set<string>(['queued', 'crawling', 'ingesting', 'indexing']);

// ─── Thin content threshold ─────────────────────────────────────────────────

/** Percentage of thin-content pages that triggers "completed_with_issues" */
const THIN_CONTENT_THRESHOLD = 0.1; // 10%

// ─── State Derivation ───────────────────────────────────────────────────────

/**
 * Derive the display state from source and the active (anchored) job.
 *
 * Priority: Job status > Source status (source may be stale by seconds).
 * Source status only used for pre-job states (configuring, pending).
 *
 * @param source - The SearchAISource object
 * @param displayJob - The anchored/selected job (may be null for new sources)
 * @returns One of 8 DisplayState values
 */
export function deriveDisplayState(
  source: SearchAISource | null,
  displayJob: CrawlJob | null,
): DisplayState {
  if (!source) return 'idle';

  // Pre-job states: use source.status directly
  if (source.status === 'configuring') return 'configuring';
  if (source.status === 'pending' && !displayJob) return 'pending';

  // No job at all — source is idle
  if (!displayJob) return 'idle';

  // Active job states
  if (ACTIVE_JOB_STATUSES.has(displayJob.status)) return 'crawling';

  // Terminal job states
  if (displayJob.status === 'cancelled') return 'cancelled';
  if (displayJob.status === 'failed') return 'failed';

  if (displayJob.status === 'completed') {
    // Check for issues: failed pages or thin content
    const failedCount = displayJob.urls?.failed ?? 0;
    const crawledCount = displayJob.urls?.crawled ?? 0;
    const hasFailures = failedCount > 0;
    const hasThinContent = crawledCount > 0 && failedCount / crawledCount >= THIN_CONTENT_THRESHOLD;

    if (hasFailures || hasThinContent) return 'completed_with_issues';
    return 'completed';
  }

  // Fallback — shouldn't reach here with known statuses
  return 'idle';
}

// ─── Badge Configuration ────────────────────────────────────────────────────

export interface BadgeConfig {
  /** i18n key under search_ai.source_page namespace */
  labelKey: string;
  variant: 'default' | 'accent' | 'success' | 'warning' | 'error' | 'info';
  pulse?: boolean;
  dot?: boolean;
}

const BADGE_MAP: Record<DisplayState, BadgeConfig> = {
  configuring: {
    labelKey: 'badge_configuring',
    variant: 'default',
    dot: true,
  },
  pending: {
    labelKey: 'badge_pending',
    variant: 'info',
    dot: true,
  },
  crawling: {
    labelKey: 'badge_crawling',
    variant: 'accent',
    pulse: true,
    dot: true,
  },
  completed: {
    labelKey: 'badge_active',
    variant: 'success',
    dot: true,
  },
  completed_with_issues: {
    labelKey: 'badge_issues',
    variant: 'warning',
    dot: true,
  },
  failed: {
    labelKey: 'badge_failed',
    variant: 'error',
    dot: true,
  },
  cancelled: {
    labelKey: 'badge_cancelled',
    variant: 'default',
    dot: true,
  },
  idle: {
    labelKey: 'badge_idle',
    variant: 'default',
    dot: true,
  },
};

export function getBadgeConfig(state: DisplayState): BadgeConfig {
  return BADGE_MAP[state];
}

// ─── Display Job Resolution ─────────────────────────────────────────────────

/**
 * Resolve the display job from the job list using the anchoring model.
 *
 * activeJobId = viewingJobId ?? anchoredJobId
 * displayJob  = jobs.find(j => j._id === activeJobId) ?? jobs[0] ?? null
 */
export function resolveDisplayJob(
  sourceJobs: CrawlJob[],
  activeJobId: string | null,
): CrawlJob | null {
  if (sourceJobs.length === 0) return null;
  if (activeJobId) {
    return sourceJobs.find((j) => j._id === activeJobId) ?? sourceJobs[0];
  }
  return sourceJobs[0];
}

// ─── Source Job Filtering ───────────────────────────────────────────────────

/**
 * Filter jobs to only those belonging to a specific source.
 * CrawlHistory is index-wide; USP needs source-scoped jobs.
 */
export function filterJobsBySource(jobs: CrawlJob[], sourceId: string): CrawlJob[] {
  return jobs.filter((j) => j.sourceId === sourceId);
}

// ─── Tab Validation ─────────────────────────────────────────────────────────

/**
 * Parse and validate the tab query parameter.
 * Returns DEFAULT_TAB if the value is invalid.
 */
export function parseTabParam(value: string | null): USPTab {
  if (value && USP_TABS.includes(value as USPTab)) {
    return value as USPTab;
  }
  return DEFAULT_TAB;
}
