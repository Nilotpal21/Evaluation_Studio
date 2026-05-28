/**
 * Intent Queue — pure functional module for managing pending intents
 * in the primary_queue multi-intent strategy.
 *
 * All functions are pure (no I/O, no side effects beyond mutating the
 * passed-in IntentQueue structure). This makes them trivially testable
 * and safe for use across pods (the queue is serialised on the session).
 */

import type {
  MultiIntentSource,
  MultiIntentTarget,
  PendingIntentSeed,
} from './multi-intent/multi-intent-types.js';
import { humanizeIntentLabel } from './multi-intent/multi-intent-types.js';

// =============================================================================
// TYPES
// =============================================================================

/** A single pending intent entry in the queue. */
export interface PendingIntentEntry {
  /** The intent name / identifier */
  intent: string;
  /** Confidence score from detection (0..1) */
  confidence: number;
  /** The original user message that triggered this intent */
  original_message: string;
  /** ISO timestamp when the intent was detected */
  detected_at: string;
  /** Optional human-readable label for disambiguation and queue UX */
  label?: string;
  /** Optional category metadata from classifier/flow detection */
  category?: string | null;
  /** Optional concise summary of the intent */
  summary?: string;
  /** Origin of the pending intent */
  source?: MultiIntentSource;
  /** Explicit executable target preserved separately from the display label */
  target?: MultiIntentTarget | null;
  /** Flow step where the intent was originally detected */
  sourceStep?: string;
}

/** The intent queue data structure — serialisable, stored on the session. */
export interface IntentQueue {
  /** Pending intents sorted by confidence descending */
  pending: PendingIntentEntry[];
}

// =============================================================================
// FACTORY
// =============================================================================

/** Create a new empty IntentQueue. */
export function createIntentQueue(): IntentQueue {
  return { pending: [] };
}

// =============================================================================
// OPERATIONS
// =============================================================================

/**
 * Enqueue one or more intents into the queue.
 *
 * - Duplicates (same intent name) are merged: the higher confidence wins
 *   and the original_message is updated to the newer one.
 * - After merge, the queue is re-sorted by confidence descending.
 * - Each entry gets a `detected_at` timestamp if not already set.
 */
export function enqueueIntents(
  queue: IntentQueue,
  intents: PendingIntentSeed[],
  maxSize?: number,
): void {
  const now = new Date().toISOString();

  for (const incoming of intents) {
    const existing = queue.pending.find((e) => e.intent === incoming.intent);

    if (existing) {
      // Merge: keep the higher confidence, update message
      if (incoming.confidence > existing.confidence) {
        existing.confidence = incoming.confidence;
      }
      existing.original_message = incoming.original_message;
      existing.detected_at = now;
      if (incoming.label !== undefined) {
        existing.label = incoming.label;
      }
      if ('category' in incoming) {
        existing.category = incoming.category ?? null;
      }
      if (incoming.summary !== undefined) {
        existing.summary = incoming.summary;
      }
      if (incoming.source !== undefined) {
        existing.source = incoming.source;
      }
      if ('target' in incoming) {
        existing.target = incoming.target ?? null;
      }
      if ('sourceStep' in incoming) {
        existing.sourceStep = incoming.sourceStep;
      }
    } else {
      queue.pending.push({
        intent: incoming.intent,
        confidence: incoming.confidence,
        original_message: incoming.original_message,
        detected_at: now,
        ...(incoming.label !== undefined ? { label: incoming.label } : {}),
        ...('category' in incoming ? { category: incoming.category ?? null } : {}),
        ...(incoming.summary !== undefined ? { summary: incoming.summary } : {}),
        ...(incoming.source !== undefined ? { source: incoming.source } : {}),
        ...('target' in incoming ? { target: incoming.target ?? null } : {}),
        ...('sourceStep' in incoming ? { sourceStep: incoming.sourceStep } : {}),
      });
    }
  }

  // Re-sort by confidence descending
  queue.pending.sort((a, b) => b.confidence - a.confidence);

  // Enforce max queue size (drop lowest-confidence entries)
  if (maxSize !== undefined && maxSize > 0 && queue.pending.length > maxSize) {
    queue.pending.length = maxSize;
  }
}

/**
 * Dequeue the highest-confidence intent from the queue.
 * Returns null if the queue is empty.
 */
export function dequeueNext(queue: IntentQueue): PendingIntentEntry | null {
  if (queue.pending.length === 0) {
    return null;
  }
  return queue.pending.shift()!;
}

/**
 * Peek at the highest-confidence intent without removing it.
 * Returns null if the queue is empty.
 */
export function peekNext(queue: IntentQueue): PendingIntentEntry | null {
  if (queue.pending.length === 0) {
    return null;
  }
  return queue.pending[0];
}

/**
 * Remove entries older than `maxAgeMs` milliseconds from the queue.
 * Uses each entry's `detected_at` timestamp for age calculation.
 */
export function pruneExpired(queue: IntentQueue, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  queue.pending = queue.pending.filter((entry) => {
    const detectedAt = new Date(entry.detected_at).getTime();
    return detectedAt > cutoff;
  });
}

export function getPendingIntentDisplayLabel(
  entry: Pick<PendingIntentEntry, 'label' | 'summary' | 'intent'>,
): string {
  return humanizeIntentLabel(entry.label || entry.summary || entry.intent);
}
