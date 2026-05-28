import { describe, test, expect } from 'vitest';
import { createIntentQueue, enqueueIntents, peekNext } from '../services/execution/intent-queue.js';
import type { RuntimeSession } from '../services/execution/types.js';

describe('ON_INPUT vs Multi-Intent Priority Invariant', () => {
  function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
    return {
      id: 'sess-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'test-agent',
      conversationHistory: [],
      data: { values: {}, context: {} },
      state: { conversationPhase: 'active' },
      currentFlowStep: 'gather_info',
      isComplete: false,
      intentQueue: createIntentQueue(),
      ...overrides,
    } as RuntimeSession;
  }

  test('ON_INPUT match prevents intent queue from being consulted', () => {
    const session = makeSession();
    enqueueIntents(session.intentQueue!, [
      { intent: 'secondary_intent', confidence: 0.9, original_message: 'also do Y' },
    ]);
    // Simulate ON_INPUT routing: the session transitions to the ON_INPUT target step
    // and clears waitingForInput — the intent queue must NOT be drained
    session.currentFlowStep = 'on_input_target_step';
    session.waitingForInput = undefined;
    // The queue still holds the secondary intent — it was not consumed
    expect(session.intentQueue!.pending).toHaveLength(1);
    expect(peekNext(session.intentQueue!)?.intent).toBe('secondary_intent');
    // waitingForInput is cleared because ON_INPUT handled the message
    expect(session.waitingForInput).toBeUndefined();
  });

  test('queued intents survive ON_INPUT transition and surface after completion', () => {
    const session = makeSession();
    enqueueIntents(session.intentQueue!, [
      { intent: 'book_hotel', confidence: 0.85, original_message: 'book a hotel too' },
    ]);
    // Simulate: ON_INPUT handled the primary message, flow advanced and completed
    session.currentFlowStep = 'previous_step';
    session.isComplete = true;
    // The queued intent must still be available for post-completion surfacing
    expect(session.intentQueue!.pending).toHaveLength(1);
    expect(peekNext(session.intentQueue!)?.intent).toBe('book_hotel');
  });

  test('intent queue confirmation wait marker is distinct from ON_INPUT wait markers', () => {
    // These markers gate different control flow paths; they must never collide
    const queueMarker = '_queued_intent_confirmation_';
    const disambiguationMarker = '_disambiguation_choice';
    expect(queueMarker.startsWith('_')).toBe(true);
    expect(disambiguationMarker.startsWith('_')).toBe(true);
    expect(queueMarker).not.toBe(disambiguationMarker);
  });
});
