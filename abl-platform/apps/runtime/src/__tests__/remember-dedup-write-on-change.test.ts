/**
 * Lock test for Slice 4 [ABLP-411] — REMEMBER dedup must still write on change.
 *
 * Bruce feedback 3.1: dedup must not skip writes when the value truly
 * changed. Changes to primitives, nested objects, arrays, or transitions
 * from null→defined must all produce a fresh `set()` call.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { AgentIR } from '@abl/compiler';
import type { RuntimeSession } from '../services/execution/types.js';
import { evaluateRememberAfterStateChange } from '../services/execution/memory-integration.js';

function createSession(
  factStore: InMemoryFactStore,
  ir: AgentIR,
  values: Record<string, unknown>,
): RuntimeSession {
  return {
    id: 'session-change',
    agentName: 'TestAgent',
    agentIR: ir,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: true,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    factStore,
    callerContext: {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    },
  } as unknown as RuntimeSession;
}

function makeIR(triggerTarget: string, triggerValue: string): AgentIR {
  return {
    name: 'TestAgent',
    description: 'Test',
    execution: { mode: 'reasoning' },
    memory: {
      session: [],
      persistent: [],
      remember: [
        { when: `${triggerValue} IS SET`, store: { value: triggerValue, target: triggerTarget } },
      ],
      recall: [],
    },
  } as unknown as AgentIR;
}

describe('REMEMBER dedup — write on change', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = new InMemoryFactStore({ type: 'memory' });
  });

  afterEach(() => {
    factStore.stop();
  });

  test('primitive value change produces a new set() call', async () => {
    const ir = makeIR('user.pref', 'pref');
    const session = createSession(factStore, ir, { pref: 'dark' });

    await evaluateRememberAfterStateChange(session);

    // Change the value, then re-evaluate
    session.data.values.pref = 'light';
    const setSpy = vi.spyOn(factStore, 'set');
    await evaluateRememberAfterStateChange(session);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  test('nested object value change produces a new set() call', async () => {
    const ir = makeIR('user.profile', 'profile');
    const session = createSession(factStore, ir, {
      profile: { name: 'Alice', settings: { theme: 'dark' } },
    });

    await evaluateRememberAfterStateChange(session);

    session.data.values.profile = { name: 'Alice', settings: { theme: 'light' } };
    const setSpy = vi.spyOn(factStore, 'set');
    await evaluateRememberAfterStateChange(session);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  test('array change produces a new set() call', async () => {
    const ir = makeIR('user.tags', 'tags');
    const session = createSession(factStore, ir, { tags: ['a', 'b'] });

    await evaluateRememberAfterStateChange(session);

    session.data.values.tags = ['a', 'b', 'c'];
    const setSpy = vi.spyOn(factStore, 'set');
    await evaluateRememberAfterStateChange(session);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });

  test('no previous value stored — first pass always writes', async () => {
    const ir = makeIR('user.new', 'newValue');
    const session = createSession(factStore, ir, { newValue: 'fresh' });

    const setSpy = vi.spyOn(factStore, 'set');
    await evaluateRememberAfterStateChange(session);
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
