/**
 * Lock test for Slice 4 [ABLP-411] — REMEMBER dedup.
 *
 * Bruce feedback 3.1: when the same REMEMBER trigger fires twice with
 * the exact same value, the second pass must skip the `set()` call
 * against the FactStore. Read-before-write on a batched `getMany()`
 * detects unchanged values and drops them before dispatch.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { AgentIR } from '@abl/compiler';
import type { RuntimeSession } from '../services/execution/types.js';
import { evaluateRememberAfterStateChange } from '../services/execution/memory-integration.js';

function createSession(factStore: InMemoryFactStore, ir: AgentIR): RuntimeSession {
  return {
    id: 'session-1',
    agentName: 'TestAgent',
    agentIR: ir,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: {
      values: { pref: 'dark', lang: 'en' },
      gatheredKeys: new Set<string>(),
    },
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

function makeAgentIR(): AgentIR {
  return {
    name: 'TestAgent',
    description: 'Test',
    execution: { mode: 'reasoning' },
    memory: {
      session: [],
      persistent: [],
      remember: [
        { when: 'pref IS SET', store: { value: 'pref', target: 'user.pref' } },
        { when: 'lang IS SET', store: { value: 'lang', target: 'user.lang' } },
      ],
      recall: [],
    },
  } as unknown as AgentIR;
}

describe('REMEMBER dedup — no write on same value', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = new InMemoryFactStore({ type: 'memory' });
  });

  afterEach(() => {
    factStore.stop();
  });

  test('second evaluation with same values triggers zero set() calls', async () => {
    const session = createSession(factStore, makeAgentIR());

    // First pass — writes should happen
    const setSpyFirst = vi.spyOn(factStore, 'set');
    await evaluateRememberAfterStateChange(session);
    const firstCallCount = setSpyFirst.mock.calls.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(2);
    setSpyFirst.mockRestore();

    // Second pass — same session values, writes must be skipped
    const setSpySecond = vi.spyOn(factStore, 'set');
    await evaluateRememberAfterStateChange(session);
    expect(setSpySecond.mock.calls).toHaveLength(0);
  });

  test('values stored on first pass remain readable after second dedup pass', async () => {
    const session = createSession(factStore, makeAgentIR());

    await evaluateRememberAfterStateChange(session);
    await evaluateRememberAfterStateChange(session);

    const pref = await factStore.get({ key: 'user.pref' });
    const lang = await factStore.get({ key: 'user.lang' });
    expect(pref?.value).toBe('dark');
    expect(lang?.value).toBe('en');
  });

  test('dedup uses batched getMany() rather than N individual get() calls', async () => {
    const session = createSession(factStore, makeAgentIR());

    // Seed identical values so dedup will skip all writes
    await factStore.set({ key: 'user.pref', value: 'dark', source: { type: 'agent' } });
    await factStore.set({ key: 'user.lang', value: 'en', source: { type: 'agent' } });

    const getManySpy = vi.spyOn(factStore, 'getMany');
    const getSpy = vi.spyOn(factStore, 'get');

    await evaluateRememberAfterStateChange(session);

    // One batched read for all trigger targets
    expect(getManySpy).toHaveBeenCalledTimes(1);
    // At most one call to getMany itself — no per-key individual gets from dedup
    expect(getSpy.mock.calls.length).toBeLessThanOrEqual(0);
  });
});
