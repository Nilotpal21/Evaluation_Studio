/**
 * Flow-level queued intent accept/decline/surface logic tests.
 *
 * Tests the two code paths in FlowStepExecutor that handle queued intents:
 *
 * 1. Post-completion surfacing (~lines 3916-3970):
 *    When a flow completes and session.intentQueue.pending has items,
 *    the executor prunes expired entries, peeks the next intent, and
 *    surfaces a confirmation prompt to the user.
 *
 * 2. Accept/Decline handling (~lines 1740-1827):
 *    When the user responds to a surfaced intent prompt, the executor
 *    matches affirmative/negative patterns and either dequeues-and-pins
 *    or removes-and-surfaces-next.
 *
 * These tests exercise the logic in isolation by replicating the session
 * state guards and queue operations from the executor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createIntentQueue,
  enqueueIntents,
  dequeueNext,
  peekNext,
  pruneExpired,
} from '../../services/execution/intent-queue.js';
import type { IntentQueue, PendingIntentEntry } from '../../services/execution/intent-queue.js';
import { DEFAULT_MESSAGES } from '@abl/compiler';

// =============================================================================
// Types mirroring runtime session fields relevant to queued intent handling
// =============================================================================

interface MockSession {
  agentName: string;
  intentQueue?: IntentQueue;
  waitingForInput?: string[];
  isComplete: boolean;
  _pinnedIntent?: string;
  conversationHistory: Array<{ role: string; content: string }>;
  state: { conversationPhase: string };
  agentIR?: {
    messages?: { multi_intent_queued_notice?: string };
  };
}

type TraceEvent = {
  type: string;
  data: Record<string, unknown>;
};

// =============================================================================
// Factory helpers
// =============================================================================

function createMockSession(overrides?: Partial<MockSession>): MockSession {
  return {
    agentName: 'test_agent',
    intentQueue: createIntentQueue(),
    waitingForInput: undefined,
    isComplete: false,
    _pinnedIntent: undefined,
    conversationHistory: [],
    state: { conversationPhase: 'active' },
    agentIR: undefined,
    ...overrides,
  };
}

function freshEntry(
  intent: string,
  confidence: number,
  original_message = 'user message',
): PendingIntentEntry {
  return {
    intent,
    confidence,
    original_message,
    detected_at: new Date().toISOString(),
  };
}

function expiredEntry(intent: string, confidence: number, ageMs: number): PendingIntentEntry {
  return {
    intent,
    confidence,
    original_message: 'old message',
    detected_at: new Date(Date.now() - ageMs).toISOString(),
  };
}

// =============================================================================
// Logic replicas (extracted from flow-step-executor.ts for unit testing)
// =============================================================================

/** Affirmative regex used in flow-step-executor.ts line 1749 */
const AFFIRMATIVE_PATTERN = /^(yes|sure|ok|please|yeah|go ahead|yep|y)\b/i;

/**
 * Replicates the post-completion surfacing logic from flow-step-executor.ts
 * lines 3921-3970.
 */
function surfaceQueuedIntent(
  session: MockSession,
  lastResultAction: { type: string },
  maxAgeMs: number,
  onTraceEvent?: (evt: TraceEvent) => void,
  onChunk?: (text: string) => void,
): { surfaced: boolean; noticeText?: string } {
  if (lastResultAction.type !== 'complete') {
    return { surfaced: false };
  }
  if (!session.intentQueue?.pending?.length) {
    return { surfaced: false };
  }

  pruneExpired(session.intentQueue, maxAgeMs);

  const next = peekNext(session.intentQueue);
  if (!next) {
    return { surfaced: false };
  }

  const intentLabel = next.intent.replace(/_/g, ' ');
  const surfaceMessage =
    session.agentIR?.messages?.multi_intent_queued_notice ||
    DEFAULT_MESSAGES.multi_intent_queued_notice;
  const noticeText = `${surfaceMessage} Next: ${intentLabel}. Would you like me to help with that?`;

  if (onChunk) {
    onChunk(`\n\n${noticeText}`);
  }
  session.conversationHistory.push({ role: 'assistant', content: noticeText });
  session.waitingForInput = ['_queued_intent_confirmation_'];

  if (onTraceEvent) {
    onTraceEvent({
      type: 'multi_intent_queue_surfaced',
      data: {
        agent: session.agentName,
        queuedIntent: next.intent,
        queuedIntentConfidence: next.confidence,
        remainingCount: session.intentQueue.pending.length,
      },
    });
  }

  return { surfaced: true, noticeText };
}

/**
 * Replicates the accept/decline handling logic from flow-step-executor.ts
 * lines 1744-1827.
 */
function handleQueuedIntentConfirmation(
  session: MockSession,
  currentMessage: string,
  onTraceEvent?: (evt: TraceEvent) => void,
  onChunk?: (text: string) => void,
): {
  handled: boolean;
  accepted?: boolean;
  nextIntent?: PendingIntentEntry | null;
  surfacedNext?: boolean;
  noticeText?: string;
} {
  if (
    !session.waitingForInput?.includes('_queued_intent_confirmation_') ||
    !currentMessage ||
    !session.intentQueue?.pending?.length
  ) {
    return { handled: false };
  }

  const affirmative = AFFIRMATIVE_PATTERN.test(currentMessage.trim());

  if (affirmative) {
    const nextIntent = dequeueNext(session.intentQueue);
    if (nextIntent) {
      session.waitingForInput = undefined;

      if (onTraceEvent) {
        onTraceEvent({
          type: 'multi_intent_queue_accepted',
          data: {
            agent: session.agentName,
            intent: nextIntent.intent,
            confidence: nextIntent.confidence,
            originalMessage: nextIntent.original_message,
            remainingCount: session.intentQueue.pending.length,
          },
        });
      }

      session.isComplete = false;
      session.state.conversationPhase = 'active';
      session._pinnedIntent = nextIntent.intent;

      return { handled: true, accepted: true, nextIntent };
    }
  } else {
    // Decline
    session.intentQueue.pending.shift();
    session.waitingForInput = undefined;

    if (onTraceEvent) {
      onTraceEvent({
        type: 'multi_intent_queue_declined',
        data: {
          agent: session.agentName,
          remainingCount: session.intentQueue.pending.length,
        },
      });
    }

    if (session.intentQueue.pending.length > 0) {
      const nextAfterDecline = peekNext(session.intentQueue);
      if (nextAfterDecline) {
        const intentLabel = nextAfterDecline.intent.replace(/_/g, ' ');
        const surfaceMessage =
          session.agentIR?.messages?.multi_intent_queued_notice ||
          DEFAULT_MESSAGES.multi_intent_queued_notice;
        const noticeText = `${surfaceMessage} Next: ${intentLabel}. Would you like me to help with that?`;

        if (onChunk) onChunk(noticeText);
        session.conversationHistory.push({ role: 'assistant', content: noticeText });
        session.waitingForInput = ['_queued_intent_confirmation_'];

        return {
          handled: true,
          accepted: false,
          surfacedNext: true,
          noticeText,
        };
      }
    }

    // No more queued intents
    return { handled: true, accepted: false, surfacedNext: false };
  }

  return { handled: false };
}

// =============================================================================
// SUITE 1: Post-completion surfacing
// =============================================================================

describe('post-completion intent queue surfacing', () => {
  it('surfaces next intent when queue has items after completion', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [
      freshEntry('check_weather', 0.85),
      freshEntry('reserve_hotel', 0.75),
    ];

    const result = surfaceQueuedIntent(session, { type: 'complete' }, 600_000);

    expect(result.surfaced).toBe(true);
    expect(result.noticeText).toContain('check weather');
    expect(result.noticeText).toContain('Would you like me to help with that?');
  });

  it('prunes expired intents before surfacing', () => {
    const session = createMockSession();
    // One expired (11 minutes old) and one fresh
    session.intentQueue!.pending = [
      expiredEntry('old_intent', 0.9, 700_000),
      freshEntry('fresh_intent', 0.8),
    ];

    const result = surfaceQueuedIntent(session, { type: 'complete' }, 600_000);

    expect(result.surfaced).toBe(true);
    // The expired intent should be pruned; fresh one surfaced
    expect(result.noticeText).toContain('fresh intent');
    expect(session.intentQueue!.pending).toHaveLength(1);
    expect(session.intentQueue!.pending[0].intent).toBe('fresh_intent');
  });

  it('sets waitingForInput to _queued_intent_confirmation_', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [freshEntry('check_weather', 0.85)];

    surfaceQueuedIntent(session, { type: 'complete' }, 600_000);

    expect(session.waitingForInput).toEqual(['_queued_intent_confirmation_']);
  });

  it('does not surface when queue is empty after pruning', () => {
    const session = createMockSession();
    // All entries are expired
    session.intentQueue!.pending = [
      expiredEntry('old_a', 0.9, 700_000),
      expiredEntry('old_b', 0.8, 800_000),
    ];

    const result = surfaceQueuedIntent(session, { type: 'complete' }, 600_000);

    expect(result.surfaced).toBe(false);
    expect(session.waitingForInput).toBeUndefined();
  });

  it('emits multi_intent_queue_surfaced trace', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [freshEntry('book_hotel', 0.88)];

    const traces: TraceEvent[] = [];
    const onTraceEvent = (evt: TraceEvent) => traces.push(evt);

    surfaceQueuedIntent(session, { type: 'complete' }, 600_000, onTraceEvent);

    expect(traces).toHaveLength(1);
    expect(traces[0].type).toBe('multi_intent_queue_surfaced');
    expect(traces[0].data.agent).toBe('test_agent');
    expect(traces[0].data.queuedIntent).toBe('book_hotel');
    expect(traces[0].data.queuedIntentConfidence).toBe(0.88);
    expect(traces[0].data.remainingCount).toBe(1); // still in queue (peek, not dequeue)
  });
});

// =============================================================================
// SUITE 2: Accept/Decline handling
// =============================================================================

describe('queued intent accept/decline handling', () => {
  it('affirmative response dequeues and sets _pinnedIntent', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [
      freshEntry('check_weather', 0.85, 'check weather and book hotel'),
      freshEntry('reserve_hotel', 0.75, 'check weather and book hotel'),
    ];

    const result = handleQueuedIntentConfirmation(session, 'yes');

    expect(result.handled).toBe(true);
    expect(result.accepted).toBe(true);
    expect(result.nextIntent).not.toBeNull();
    expect(result.nextIntent!.intent).toBe('check_weather');
    expect(session._pinnedIntent).toBe('check_weather');
    // Queue should have one remaining (reserve_hotel)
    expect(session.intentQueue!.pending).toHaveLength(1);
    expect(session.intentQueue!.pending[0].intent).toBe('reserve_hotel');
  });

  it('affirmative resets isComplete and conversationPhase to active', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
      isComplete: true,
    });
    session.state.conversationPhase = 'completed';
    session.intentQueue!.pending = [freshEntry('next_intent', 0.9)];

    handleQueuedIntentConfirmation(session, 'sure');

    expect(session.isComplete).toBe(false);
    expect(session.state.conversationPhase).toBe('active');
  });

  it('decline removes front intent and surfaces next if available', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [
      freshEntry('check_weather', 0.85),
      freshEntry('reserve_hotel', 0.75),
    ];

    const result = handleQueuedIntentConfirmation(session, 'no thanks');

    expect(result.handled).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.surfacedNext).toBe(true);
    // Front intent (check_weather) should have been removed
    expect(session.intentQueue!.pending).toHaveLength(1);
    expect(session.intentQueue!.pending[0].intent).toBe('reserve_hotel');
    // New notice should mention reserve_hotel
    expect(result.noticeText).toContain('reserve hotel');
    expect(result.noticeText).toContain('Would you like me to help with that?');
    // waitingForInput should be set for the next confirmation cycle
    expect(session.waitingForInput).toEqual(['_queued_intent_confirmation_']);
  });

  it('decline with no remaining intents clears wait state', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [freshEntry('only_intent', 0.9)];

    const result = handleQueuedIntentConfirmation(session, 'no');

    expect(result.handled).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.surfacedNext).toBe(false);
    // Queue should be empty
    expect(session.intentQueue!.pending).toHaveLength(0);
    // waitingForInput should be cleared (undefined)
    expect(session.waitingForInput).toBeUndefined();
  });

  it('emits multi_intent_queue_accepted on acceptance', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [freshEntry('book_flight', 0.92, 'book me a flight')];

    const traces: TraceEvent[] = [];
    const onTraceEvent = (evt: TraceEvent) => traces.push(evt);

    handleQueuedIntentConfirmation(session, 'yes', onTraceEvent);

    expect(traces).toHaveLength(1);
    expect(traces[0].type).toBe('multi_intent_queue_accepted');
    expect(traces[0].data.agent).toBe('test_agent');
    expect(traces[0].data.intent).toBe('book_flight');
    expect(traces[0].data.confidence).toBe(0.92);
    expect(traces[0].data.originalMessage).toBe('book me a flight');
    expect(traces[0].data.remainingCount).toBe(0);
  });

  it('emits multi_intent_queue_declined on decline', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [
      freshEntry('check_weather', 0.85),
      freshEntry('reserve_hotel', 0.75),
    ];

    const traces: TraceEvent[] = [];
    const onTraceEvent = (evt: TraceEvent) => traces.push(evt);

    handleQueuedIntentConfirmation(session, 'nope', onTraceEvent);

    expect(traces).toHaveLength(1);
    expect(traces[0].type).toBe('multi_intent_queue_declined');
    expect(traces[0].data.agent).toBe('test_agent');
    expect(traces[0].data.remainingCount).toBe(1); // reserve_hotel remains
  });

  it('affirmative patterns: yes, sure, ok, please, yeah, go ahead, yep, y all match', () => {
    const affirmativeInputs = [
      'yes',
      'Yes',
      'YES',
      'sure',
      'Sure thing',
      'ok',
      'OK',
      'please',
      'Please do',
      'yeah',
      'Yeah!',
      'go ahead',
      'Go ahead please',
      'yep',
      'Yep!',
      'y',
      'Y',
    ];

    for (const input of affirmativeInputs) {
      const session = createMockSession({
        waitingForInput: ['_queued_intent_confirmation_'],
      });
      session.intentQueue!.pending = [freshEntry('some_intent', 0.9)];

      const result = handleQueuedIntentConfirmation(session, input);

      expect(result.accepted).toBe(true);
    }
  });

  it('non-affirmative patterns are treated as decline', () => {
    const negativeInputs = [
      'no',
      'nope',
      'not now',
      'maybe later',
      'cancel',
      'never mind',
      'skip',
      "I don't want that",
    ];

    for (const input of negativeInputs) {
      const session = createMockSession({
        waitingForInput: ['_queued_intent_confirmation_'],
      });
      session.intentQueue!.pending = [freshEntry('some_intent', 0.9)];

      const result = handleQueuedIntentConfirmation(session, input);

      expect(result.accepted).toBe(false);
    }
  });
});

// =============================================================================
// SUITE 3: Edge cases
// =============================================================================

describe('queued intent edge cases', () => {
  it('does not surface when action type is not complete', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [freshEntry('check_weather', 0.85)];

    const result = surfaceQueuedIntent(session, { type: 'flow' }, 600_000);

    expect(result.surfaced).toBe(false);
    expect(session.waitingForInput).toBeUndefined();
  });

  it('does not handle confirmation when waitingForInput is not set', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [freshEntry('check_weather', 0.85)];

    const result = handleQueuedIntentConfirmation(session, 'yes');

    expect(result.handled).toBe(false);
  });

  it('does not handle confirmation when queue is empty', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    // Queue is empty

    const result = handleQueuedIntentConfirmation(session, 'yes');

    expect(result.handled).toBe(false);
  });

  it('does not handle confirmation when currentMessage is empty', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [freshEntry('check_weather', 0.85)];

    const result = handleQueuedIntentConfirmation(session, '');

    expect(result.handled).toBe(false);
  });

  it('clears waitingForInput after acceptance', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [freshEntry('intent_a', 0.9)];

    handleQueuedIntentConfirmation(session, 'yes');

    expect(session.waitingForInput).toBeUndefined();
  });

  it('intent label replaces underscores with spaces in surface notice', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [freshEntry('check_flight_status', 0.85)];

    const result = surfaceQueuedIntent(session, { type: 'complete' }, 600_000);

    expect(result.noticeText).toContain('check flight status');
    expect(result.noticeText).not.toContain('check_flight_status');
  });

  it('onChunk is called during surfacing', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [freshEntry('next_intent', 0.85)];

    const chunks: string[] = [];
    const onChunk = (text: string) => chunks.push(text);

    surfaceQueuedIntent(session, { type: 'complete' }, 600_000, undefined, onChunk);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('next intent');
  });

  it('onChunk is called during decline re-surface', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [
      freshEntry('first_intent', 0.9),
      freshEntry('second_intent', 0.8),
    ];

    const chunks: string[] = [];
    const onChunk = (text: string) => chunks.push(text);

    handleQueuedIntentConfirmation(session, 'no', undefined, onChunk);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('second intent');
  });

  it('conversation history is appended during surfacing', () => {
    const session = createMockSession();
    session.intentQueue!.pending = [freshEntry('next_intent', 0.85)];

    surfaceQueuedIntent(session, { type: 'complete' }, 600_000);

    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0].role).toBe('assistant');
    expect(session.conversationHistory[0].content).toContain('next intent');
  });

  it('conversation history is appended during decline re-surface', () => {
    const session = createMockSession({
      waitingForInput: ['_queued_intent_confirmation_'],
    });
    session.intentQueue!.pending = [
      freshEntry('first_intent', 0.9),
      freshEntry('second_intent', 0.8),
    ];

    handleQueuedIntentConfirmation(session, 'no');

    expect(session.conversationHistory).toHaveLength(1);
    expect(session.conversationHistory[0].role).toBe('assistant');
    expect(session.conversationHistory[0].content).toContain('second intent');
  });
});
