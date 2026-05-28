/**
 * Architecture-review oscillation detection.
 *
 * The layered architecture-review pass (claude-code/opus) sometimes
 * generates new findings on each retry attempt — the implementation is
 * already correct but the reviewer keeps surfacing different concerns. We
 * call this "review oscillation". A typical pattern looks like:
 *
 *   blocked(2) → blocked(2) → blocked(1) → approved(0)
 *
 * Each intermediate `blocked` verdict triggers the failure-advisor's retry
 * loop, burning ~10 minutes and ~$5-15 of reviewer cost per cycle. After
 * the reviewer eventually approves, we want to trust that approval as
 * authoritative without further re-evaluation.
 *
 * This module is pure: it inspects an append-only history of review
 * verdicts and returns a structured judgment. No state is held here; the
 * caller persists `slice.archReviewHistory` between attempts.
 */
import type { ArchitectureReviewHistoryEntry } from '../../types.js';

/** Minimum number of attempts before we declare oscillation. */
export const REVIEW_OSCILLATION_MIN_ATTEMPTS = 3;

export interface ReviewOscillationAnalysis {
  /** True when the history shows an unstable verdict pattern. */
  isOscillating: boolean;
  /** Total number of review attempts on this slice so far. */
  totalAttempts: number;
  /** Count of consecutive blocked verdicts ending at the latest attempt. */
  consecutiveBlocked: number;
  /**
   * True when the latest verdict is approved AND there were prior blocked
   * verdicts in this run. The caller should trust the approval as final.
   */
  flappedToApproved: boolean;
}

export function analyzeArchReviewHistory(
  history: ReadonlyArray<ArchitectureReviewHistoryEntry> | undefined,
): ReviewOscillationAnalysis {
  if (!history || history.length === 0) {
    return {
      isOscillating: false,
      totalAttempts: 0,
      consecutiveBlocked: 0,
      flappedToApproved: false,
    };
  }

  const latest = history[history.length - 1];
  const totalAttempts = history.length;

  let consecutiveBlocked = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && !entry.approved) {
      consecutiveBlocked += 1;
    } else {
      break;
    }
  }

  const hadPriorBlocked =
    history.slice(0, -1).some((entry) => !entry.approved) && totalAttempts >= 2;

  const flappedToApproved = Boolean(latest?.approved) && hadPriorBlocked;

  // Oscillation: at least MIN_ATTEMPTS reviews, with at least one swing
  // between approved and blocked across the history (not strictly monotonic).
  const hasApproved = history.some((entry) => entry.approved);
  const hasBlocked = history.some((entry) => !entry.approved);
  const isOscillating =
    totalAttempts >= REVIEW_OSCILLATION_MIN_ATTEMPTS && hasApproved && hasBlocked;

  return {
    isOscillating,
    totalAttempts,
    consecutiveBlocked,
    flappedToApproved,
  };
}

/**
 * Append a new architecture-review verdict to the slice's history.
 * Returns the updated array — pure helper, does not mutate input.
 */
export function recordArchReviewVerdict(
  history: ReadonlyArray<ArchitectureReviewHistoryEntry> | undefined,
  approved: boolean,
  findingsCount: number,
  timestamp: string,
): ArchitectureReviewHistoryEntry[] {
  return [...(history ?? []), { approved, findingsCount, timestamp }];
}
