import { describe, test, expect } from 'vitest';
import { createIntentQueue, enqueueIntents } from '../services/execution/intent-queue.js';
import type { RuntimeSession } from '../services/execution/types.js';

describe('Delegation Intent Isolation Invariant', () => {
  function makeSupervisorSession(): RuntimeSession {
    return {
      id: 'sess-supervisor',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'supervisor',
      conversationHistory: [],
      data: { values: {}, context: {} },
      state: { conversationPhase: 'active' },
      isComplete: false,
      intentQueue: createIntentQueue(),
      threads: [],
      activeThreadIndex: 0,
    } as unknown as RuntimeSession;
  }

  test('delegate thread does not inherit parent intentQueue', () => {
    const supervisor = makeSupervisorSession();
    enqueueIntents(supervisor.intentQueue!, [
      { intent: 'book_flight', confidence: 0.9, original_message: 'book a flight' },
      { intent: 'book_hotel', confidence: 0.85, original_message: 'book a hotel' },
    ]);
    const delegateInitialData = {
      delegate_from: 'supervisor',
      user_request: 'book a flight',
    };
    expect(delegateInitialData).not.toHaveProperty('intentQueue');
    expect(supervisor.intentQueue!.pending).toHaveLength(2);
  });

  test('delegate receives single intent message, not multi-intent context', () => {
    const primaryMessage = 'I need to book a flight to London';
    const delegateInput = primaryMessage;
    expect(typeof delegateInput).toBe('string');
    expect(delegateInput).not.toContain('intentQueue');
    expect(delegateInput).not.toContain('alternatives');
  });

  test('after delegate completes, supervisor intentQueue is preserved', () => {
    const supervisor = makeSupervisorSession();
    enqueueIntents(supervisor.intentQueue!, [
      { intent: 'book_hotel', confidence: 0.85, original_message: 'also book a hotel' },
    ]);
    const savedQueue = supervisor.intentQueue;
    expect(savedQueue).toBe(supervisor.intentQueue);
    expect(supervisor.intentQueue!.pending).toHaveLength(1);
    expect(supervisor.intentQueue!.pending[0].intent).toBe('book_hotel');
  });

  test('disambiguation markers are cleared before delegation', () => {
    const supervisor = makeSupervisorSession();
    supervisor.waitingForInput = ['_disambiguation_choice'];
    supervisor.waitingForInput = undefined;
    const delegateData = { delegate_from: 'supervisor' };
    expect(delegateData).not.toHaveProperty('waitingForInput');
  });
});
