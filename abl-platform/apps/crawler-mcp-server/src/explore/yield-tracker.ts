/**
 * YieldTracker — Signal-based stopping for depth probing.
 *
 * Replaces static caps (maxPageVisits, sampleSize) with adaptive
 * yield tracking. Stops exploration when marginal returns drop
 * below 5% of peak yield (design doc §5).
 *
 * Key principle: No hardcoded limits. Stopping is driven by
 * diminishing returns, not arbitrary caps.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface YieldTracker {
  /** New links found per page visit */
  yieldPerPage: number[];
  /** Highest single-page yield observed */
  peakYield: number;
  /** Total new links across all pages */
  totalNewLinks: number;
  /** Consecutive pages with yield below threshold */
  consecutiveLowYield: number;
}

export type YieldTrend = 'productive' | 'declining' | 'stalled';

export interface YieldDecision {
  /** Whether exploration should continue */
  continue: boolean;
  /** Human-readable reason for the decision */
  reason: string;
  /** Current yield trend */
  trend: YieldTrend;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Stop when yield drops below this fraction of peak */
const PEAK_YIELD_THRESHOLD = 0.05;

/** Number of consecutive low-yield pages before stopping */
const CONSECUTIVE_LOW_YIELD_LIMIT = 3;

/** Minimum pages visited before yield-based stopping kicks in */
const MIN_PAGES_BEFORE_YIELD_CHECK = 3;

/** Below this absolute yield, even a single page counts as "low" */
const ABSOLUTE_LOW_YIELD = 1;

// ─── Factory ────────────────────────────────────────────────────────

export function createYieldTracker(): YieldTracker {
  return {
    yieldPerPage: [],
    peakYield: 0,
    totalNewLinks: 0,
    consecutiveLowYield: 0,
  };
}

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Record a page visit and update tracker state.
 * Mutates the tracker in place for efficiency.
 */
export function trackPageVisit(tracker: YieldTracker, newLinksOnPage: number): void {
  tracker.yieldPerPage.push(newLinksOnPage);
  tracker.totalNewLinks += newLinksOnPage;

  if (newLinksOnPage > tracker.peakYield) {
    tracker.peakYield = newLinksOnPage;
  }

  const threshold = Math.max(tracker.peakYield * PEAK_YIELD_THRESHOLD, ABSOLUTE_LOW_YIELD);
  if (newLinksOnPage < threshold) {
    tracker.consecutiveLowYield++;
  } else {
    tracker.consecutiveLowYield = 0;
  }
}

/**
 * Determine whether exploration should continue based on yield signals.
 *
 * Returns { continue: false } when:
 * - Consecutive low-yield pages exceed the limit (3)
 * - Last page yield is below 5% of peak yield
 * - At least MIN_PAGES_BEFORE_YIELD_CHECK pages have been visited
 */
export function shouldContinue(tracker: YieldTracker): YieldDecision {
  const pageCount = tracker.yieldPerPage.length;

  // Always continue for the first few pages
  if (pageCount < MIN_PAGES_BEFORE_YIELD_CHECK) {
    return { continue: true, reason: 'Gathering initial data', trend: 'productive' };
  }

  // No links found at all — site may be sparse
  if (tracker.peakYield === 0) {
    return {
      continue: false,
      reason: 'No links discovered on any page',
      trend: 'stalled',
    };
  }

  const threshold = Math.max(tracker.peakYield * PEAK_YIELD_THRESHOLD, ABSOLUTE_LOW_YIELD);
  const lastYield = tracker.yieldPerPage[pageCount - 1];
  const trend = getTrend(tracker);

  // Consecutive low-yield pages
  if (tracker.consecutiveLowYield >= CONSECUTIVE_LOW_YIELD_LIMIT) {
    return {
      continue: false,
      reason: `${tracker.consecutiveLowYield} consecutive pages below yield threshold (${threshold.toFixed(0)} links)`,
      trend: 'stalled',
    };
  }

  // Single very low yield after productive phase
  if (lastYield < threshold && trend === 'declining') {
    return {
      continue: true,
      reason: `Yield declining (${lastYield} links, peak was ${tracker.peakYield})`,
      trend: 'declining',
    };
  }

  return { continue: true, reason: 'Discovery productive', trend };
}

/**
 * Adaptive sample count for a hub page.
 *
 * More links on a hub = more samples worth taking. Uses a logarithmic
 * scale to avoid over-sampling very large hubs.
 */
export function pickSampleCount(hub: { linkCount: number }): number {
  const { linkCount } = hub;
  if (linkCount <= 0) return 0;
  if (linkCount <= 5) return Math.min(linkCount, 2);
  if (linkCount <= 20) return 3;
  // Logarithmic scaling: ~4 samples for 50 links, ~5 for 100, ~6 for 200
  return Math.min(Math.ceil(Math.log2(linkCount)), 8);
}

// ─── Helpers ────────────────────────────────────────────────────────

function getTrend(tracker: YieldTracker): YieldTrend {
  const pages = tracker.yieldPerPage;
  if (pages.length < 2) return 'productive';

  // Compare last 3 pages against first 3
  const recentWindow = pages.slice(-3);
  const earlyWindow = pages.slice(0, Math.min(3, pages.length));

  const recentAvg = recentWindow.reduce((a, b) => a + b, 0) / recentWindow.length;
  const earlyAvg = earlyWindow.reduce((a, b) => a + b, 0) / earlyWindow.length;

  if (earlyAvg === 0) return recentAvg === 0 ? 'stalled' : 'productive';
  if (recentAvg < earlyAvg * 0.3) return 'stalled';
  if (recentAvg < earlyAvg * 0.7) return 'declining';
  return 'productive';
}
