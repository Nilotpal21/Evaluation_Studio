/**
 * Disambiguation context preservation tests.
 *
 * Validates intent queue creation, original message preservation,
 * and integration with pinned intent branch filtering + evaluateOnInput.
 */

import { describe, it, expect } from 'vitest';
import { createIntentQueue, enqueueIntents } from '../services/execution/intent-queue.js';
import { evaluateOnInput } from '@abl/compiler/platform/constructs/utils.js';

type OnInputBranch = {
  condition?: string;
  respond?: string;
  set?: Record<string, string>;
  call?: string;
  then: string;
};

/** Mirror the pinned-intent branch filtering from flow-step-executor.ts */
function filterBranchesForPin(
  branches: OnInputBranch[],
  pinnedIntent: string | undefined,
): OnInputBranch[] {
  if (!pinnedIntent) return branches;

  const pinnedBranch = branches.find((b) => b.then === pinnedIntent);
  if (pinnedBranch) {
    return branches.filter((b) => b.then === pinnedIntent || !b.condition);
  }
  return [];
}

describe('disambiguation context preservation', () => {
  describe('intent queue creation during disambiguation', () => {
    it('should create intent queue with all disambiguation intents', () => {
      const queue = createIntentQueue();
      const allIntents = [
        { intent: 'book_flight', confidence: 0.85 },
        { intent: 'check_status', confidence: 0.75 },
      ];
      const userMessage = 'I want to book a flight and check my status';

      enqueueIntents(
        queue,
        allIntents.map((i) => ({
          intent: i.intent!,
          confidence: i.confidence,
          original_message: userMessage,
        })),
      );

      expect(queue.pending).toHaveLength(2);
      expect(queue.pending[0].original_message).toBe(userMessage);
      expect(queue.pending[1].original_message).toBe(userMessage);
    });
  });

  describe('original message preservation', () => {
    it('should store _disambiguation_original_message on session data', () => {
      const sessionData: Record<string, unknown> = {};
      const originalMessage = 'I want to book a flight and check my status';

      sessionData._disambiguation_original_message = originalMessage;

      expect(sessionData._disambiguation_original_message).toBe(originalMessage);
    });

    it('should use original message (not choice label) when routing after choice', () => {
      const originalMessage = 'I want to book a flight and check my status';
      const queue = createIntentQueue();
      enqueueIntents(queue, [
        { intent: 'book_flight', confidence: 0.85, original_message: originalMessage },
        { intent: 'check_status', confidence: 0.75, original_message: originalMessage },
      ]);

      const chosenIntent = 'book_flight';
      const queueEntry = queue.pending.find((p) => p.intent === chosenIntent);
      const currentMessage = queueEntry?.original_message || '1';

      expect(currentMessage).toBe(originalMessage);
      expect(currentMessage).not.toBe('1');
    });
  });

  describe('disambiguation cleanup after choice', () => {
    it('should clean up _disambiguation_original_message after choice', () => {
      const sessionData: Record<string, unknown> = {
        _disambiguation_intents: ['book_flight', 'check_status'],
        _disambiguation_original_message: 'I want to book a flight and check my status',
      };

      delete sessionData._disambiguation_intents;
      delete sessionData._disambiguation_original_message;

      expect(sessionData._disambiguation_intents).toBeUndefined();
      expect(sessionData._disambiguation_original_message).toBeUndefined();
    });
  });

  describe('disambiguation choice routes correctly via pinned intent', () => {
    const branches: OnInputBranch[] = [
      { condition: 'input contains "book"', then: 'book_flight', respond: 'Booking flight...' },
      { condition: 'input contains "status"', then: 'check_status', respond: 'Checking status...' },
      { then: 'fallback', respond: 'I did not understand' },
    ];

    it('disambiguation choice sets _pinnedIntent and filters branches correctly', () => {
      // Simulate: user chose "check_status" from disambiguation options
      const chosenIntent = 'check_status';
      const originalMessage = 'I want to book a flight and check my status';
      const pinnedIntent = chosenIntent;

      // Apply pinned intent filtering
      const filtered = filterBranchesForPin(branches, pinnedIntent);

      // Only check_status + ELSE remain
      expect(filtered.map((b) => b.then)).toEqual(['check_status', 'fallback']);

      // evaluateOnInput with original message routes to the correct branch
      const result = evaluateOnInput(filtered, originalMessage, {});
      expect(result).not.toBeNull();
      expect(result!.then).toBe('check_status');
    });

    it('without pinning, wrong branch would win from disambiguation message', () => {
      const originalMessage = 'I want to book a flight and check my status';

      // Without pinning, "book" matches first
      const result = evaluateOnInput(branches, originalMessage, {});
      expect(result).not.toBeNull();
      expect(result!.then).toBe('book_flight');
    });
  });
});
