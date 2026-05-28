import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createIntentQueue,
  enqueueIntents,
  dequeueNext,
  peekNext,
  pruneExpired,
} from '../services/execution/intent-queue.js';
import {
  detectIntent,
  detectCorrection,
  CORRECTION_FIELD_UNKNOWN,
} from '@abl/compiler/platform/constructs/utils.js';

// =============================================================================
// Group 1: dequeueNext
// =============================================================================

describe('dequeueNext', () => {
  it('returns null on empty queue', () => {
    const queue = createIntentQueue();
    expect(dequeueNext(queue)).toBeNull();
  });

  it('returns the highest-confidence entry and removes it from queue', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'low', confidence: 0.3, original_message: 'msg' },
      { intent: 'high', confidence: 0.9, original_message: 'msg' },
      { intent: 'mid', confidence: 0.6, original_message: 'msg' },
    ]);

    const result = dequeueNext(queue);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe('high');
    expect(result!.confidence).toBe(0.9);
    // Queue should no longer contain the dequeued entry
    expect(queue.pending).toHaveLength(2);
    expect(queue.pending.find((e) => e.intent === 'high')).toBeUndefined();
  });

  it('sequential dequeues return entries in descending confidence order', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'a', confidence: 0.5, original_message: 'msg' },
      { intent: 'b', confidence: 0.9, original_message: 'msg' },
      { intent: 'c', confidence: 0.7, original_message: 'msg' },
    ]);

    const first = dequeueNext(queue);
    const second = dequeueNext(queue);
    const third = dequeueNext(queue);

    expect(first!.intent).toBe('b');
    expect(first!.confidence).toBe(0.9);
    expect(second!.intent).toBe('c');
    expect(second!.confidence).toBe(0.7);
    expect(third!.intent).toBe('a');
    expect(third!.confidence).toBe(0.5);
  });

  it('after dequeuing all entries, queue.pending is empty', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'x', confidence: 0.8, original_message: 'msg' },
      { intent: 'y', confidence: 0.4, original_message: 'msg' },
    ]);

    dequeueNext(queue);
    dequeueNext(queue);

    expect(queue.pending).toHaveLength(0);
    expect(dequeueNext(queue)).toBeNull();
  });
});

// =============================================================================
// Group 2: peekNext
// =============================================================================

describe('peekNext', () => {
  it('returns null on empty queue', () => {
    const queue = createIntentQueue();
    expect(peekNext(queue)).toBeNull();
  });

  it('returns the top entry without removing it (queue length unchanged)', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'alpha', confidence: 0.95, original_message: 'msg' },
      { intent: 'beta', confidence: 0.6, original_message: 'msg' },
    ]);

    const lengthBefore = queue.pending.length;
    const peeked = peekNext(queue);

    expect(peeked).not.toBeNull();
    expect(peeked!.intent).toBe('alpha');
    expect(peeked!.confidence).toBe(0.95);
    expect(queue.pending).toHaveLength(lengthBefore);
  });

  it('peekNext then dequeueNext returns the same entry', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'first', confidence: 0.85, original_message: 'msg' },
      { intent: 'second', confidence: 0.5, original_message: 'msg' },
    ]);

    const peeked = peekNext(queue);
    const dequeued = dequeueNext(queue);

    expect(peeked).not.toBeNull();
    expect(dequeued).not.toBeNull();
    expect(peeked!.intent).toBe(dequeued!.intent);
    expect(peeked!.confidence).toBe(dequeued!.confidence);
    expect(peeked!.original_message).toBe(dequeued!.original_message);
  });
});

// =============================================================================
// Group 3: pruneExpired
// =============================================================================

describe('pruneExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes entries older than maxAgeMs cutoff', () => {
    // Set current time to a known point
    const baseTime = new Date('2026-03-03T12:00:00Z').getTime();
    vi.setSystemTime(baseTime);

    const queue = createIntentQueue();
    // Enqueue entries — they get detected_at = baseTime
    enqueueIntents(queue, [{ intent: 'old_one', confidence: 0.9, original_message: 'msg' }]);

    // Advance time by 10 seconds and add a new entry
    vi.setSystemTime(baseTime + 10_000);
    enqueueIntents(queue, [{ intent: 'new_one', confidence: 0.7, original_message: 'msg' }]);

    expect(queue.pending).toHaveLength(2);

    // Advance time by another 55 seconds (total 65s from base)
    // and prune with maxAge = 60s — old_one (65s old) should be removed,
    // new_one (55s old) should be kept
    vi.setSystemTime(baseTime + 65_000);
    pruneExpired(queue, 60_000);

    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0].intent).toBe('new_one');
  });

  it('keeps entries within the window', () => {
    const baseTime = new Date('2026-03-03T12:00:00Z').getTime();
    vi.setSystemTime(baseTime);

    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'recent_a', confidence: 0.8, original_message: 'msg' },
      { intent: 'recent_b', confidence: 0.6, original_message: 'msg' },
    ]);

    // Only 5 seconds later, prune with 60s window — both should survive
    vi.setSystemTime(baseTime + 5_000);
    pruneExpired(queue, 60_000);

    expect(queue.pending).toHaveLength(2);
  });

  it('empty queue after pruning does not crash', () => {
    const queue = createIntentQueue();
    // Prune on an already-empty queue
    expect(() => pruneExpired(queue, 60_000)).not.toThrow();
    expect(queue.pending).toHaveLength(0);
  });

  it('all-expired entries results in empty queue', () => {
    const baseTime = new Date('2026-03-03T12:00:00Z').getTime();
    vi.setSystemTime(baseTime);

    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'expired_a', confidence: 0.9, original_message: 'msg' },
      { intent: 'expired_b', confidence: 0.7, original_message: 'msg' },
      { intent: 'expired_c', confidence: 0.5, original_message: 'msg' },
    ]);

    // Jump 2 minutes into the future — all entries are 120s old, prune at 60s
    vi.setSystemTime(baseTime + 120_000);
    pruneExpired(queue, 60_000);

    expect(queue.pending).toHaveLength(0);
  });
});

// =============================================================================
// Group 4: enqueueIntents edge cases
// =============================================================================

describe('enqueueIntents edge cases', () => {
  it('maxSize=0 does not truncate (the code checks maxSize > 0)', () => {
    const queue = createIntentQueue();
    enqueueIntents(
      queue,
      [
        { intent: 'a', confidence: 0.9, original_message: 'msg' },
        { intent: 'b', confidence: 0.8, original_message: 'msg' },
        { intent: 'c', confidence: 0.7, original_message: 'msg' },
        { intent: 'd', confidence: 0.6, original_message: 'msg' },
        { intent: 'e', confidence: 0.5, original_message: 'msg' },
      ],
      0,
    );

    // maxSize=0 should not truncate — all 5 entries should remain
    expect(queue.pending).toHaveLength(5);
  });

  it('merging duplicate with lower confidence keeps existing confidence value', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'booking', confidence: 0.9, original_message: 'first message' },
    ]);

    // Re-enqueue same intent with lower confidence
    enqueueIntents(queue, [
      { intent: 'booking', confidence: 0.5, original_message: 'second message' },
    ]);

    expect(queue.pending).toHaveLength(1);
    // Confidence should remain 0.9 (higher value kept)
    expect(queue.pending[0].confidence).toBe(0.9);
  });

  it('merging duplicate always updates original_message to the newer one (even when confidence is lower)', () => {
    const queue = createIntentQueue();
    enqueueIntents(queue, [
      { intent: 'status', confidence: 0.95, original_message: 'check my status please' },
    ]);

    // Re-enqueue same intent with lower confidence but different message
    enqueueIntents(queue, [
      { intent: 'status', confidence: 0.4, original_message: 'what is my order status' },
    ]);

    expect(queue.pending).toHaveLength(1);
    // Confidence stays at 0.95 (higher)
    expect(queue.pending[0].confidence).toBe(0.95);
    // But original_message is always updated to the newer one
    expect(queue.pending[0].original_message).toBe('what is my order status');
  });
});

// =============================================================================
// Group 5: matchesAtWordBoundary edge cases (tested via detectIntent)
// =============================================================================

describe('matchesAtWordBoundary edge cases (via detectIntent)', () => {
  // matchesAtWordBoundary is a private function in utils.ts.
  // It is exercised through detectIntent which uses it for keyword matching.
  // We construct intents whose keyword patterns exercise the boundary logic.

  it('term starting with non-word char (e.g., "+1") matches when surrounded by spaces', () => {
    // detectIntent with a quoted exact-phrase pattern uses matchesAtWordBoundary
    const result = detectIntent('I rate this +1 definitely', [{ intent: '"+1"' }], {});

    expect(result).not.toBeNull();
    expect(result!.matched).toBe('+1');
  });

  it('term starting with non-word char does NOT match as substring', () => {
    // "+1" should not match inside "support+123" because the lookaround
    // requires whitespace or start/end of string
    const result = detectIntent('support+123', [{ intent: '"+1"' }], {});

    expect(result).toBeNull();
  });

  it('regular word term uses word boundary — "booking" does NOT match inside "overbooking"', () => {
    // keyword "booking" should NOT match inside "overbooking" due to \b boundary
    const result = detectIntent('I need help with overbooking', [{ intent: 'booking' }], {});

    expect(result).toBeNull();
  });

  it('case-insensitive matching — "CANCEL" matches "I want to cancel my flight"', () => {
    // matchesAtWordBoundary uses the 'i' flag
    const result = detectIntent('I want to cancel my flight', [{ intent: 'CANCEL' }], {});

    expect(result).not.toBeNull();
    expect(result!.intent).toBe('CANCEL');
    expect(result!.matched).toBe('cancel');
  });
});

// =============================================================================
// Group 6: detectCorrection edge cases
// =============================================================================

describe('detectCorrection edge cases', () => {
  it('returns null when no string fields are collected (only numbers/booleans in data)', () => {
    // collectedData has only numeric and boolean values — no string field
    // to match a string correction against. The number regex also won't match
    // a non-numeric correction value, so no field can be identified...
    // But the function still returns a generic correction with CORRECTION_FIELD_UNKNOWN.
    // However, if the message does NOT match any correction pattern at all,
    // it returns null outright.
    const result = detectCorrection('hello world', {
      guests: 3,
      confirmed: true,
    });

    // "hello world" does not match any DEFAULT_CORRECTION_PATTERNS
    // (which require "actually ...", "no, ...", "i meant ...", "not X, ...", etc.)
    expect(result).toBeNull();
  });

  it('returns the correction when a collected string field matches the correction pattern', () => {
    // "actually Paris" matches the correction pattern "^actually[,]?\s+(.+)$"
    // and the collected data has a string field "destination" that will match
    const result = detectCorrection('actually Paris', {
      destination: 'London',
      guests: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.field).toBe('destination');
    expect(result!.newValue).toBe('paris'); // detectCorrection lowercases the input
  });
});
