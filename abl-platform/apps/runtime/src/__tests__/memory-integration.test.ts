/**
 * Memory Integration Tests
 *
 * Verifies the facade module that connects standalone memory services
 * to the runtime execution pipeline.
 *
 * Ownership model: FactStore is scoped to (tenantId, userId, projectId).
 * Keys are just paths (e.g., "preferences.chain") — no user prefix.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { FactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { AgentIR } from '@abl/compiler';
import type { RuntimeSession } from '../services/execution/types.js';
import {
  initializeAllMemory,
  evaluateRememberAfterStateChange,
  executeRecallAfterToolCall,
  executeRecallAfterExtraction,
  detectAndStorePreferences,
} from '../services/execution/memory-integration.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createFactStore(): InMemoryFactStore {
  return new InMemoryFactStore({ type: 'memory' });
}

function createSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'test-session-1',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    callerContext: {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    },
    ...overrides,
  } as RuntimeSession;
}

function makeAgentIR(overrides?: Partial<AgentIR>): AgentIR {
  return {
    name: 'TestAgent',
    description: 'Test',
    execution: { mode: 'reasoning' },
    ...overrides,
  } as AgentIR;
}

// ---------------------------------------------------------------------------
// initializeAllMemory
// ---------------------------------------------------------------------------

describe('initializeAllMemory', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('sets session memory initial values', async () => {
    const session = createSession({ factStore });
    const ir = makeAgentIR({
      memory: {
        session: [
          { name: 'step_counter', initial_value: 0 },
          { name: 'user_lang', initial_value: 'en' },
        ],
        persistent: [],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values.step_counter).toBe(0);
    expect(session.data.values.user_lang).toBe('en');
  });

  test('batch-loads persistent memory from FactStore with fallback to default_value', async () => {
    const session = createSession({ factStore });

    // Pre-populate one fact (key is just the path — no user prefix)
    await factStore.set({
      key: 'preferred_chain',
      value: 'Hilton',
      source: { type: 'agent' },
    });

    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'preferred_chain', access: 'readwrite', description: 'Preferred hotel chain' },
          { path: 'budget', access: 'readwrite', default_value: 500, type: 'number', unit: 'USD' },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    // preferred_chain loaded from FactStore
    expect(session.data.values.preferred_chain).toBe('Hilton');
    // budget falls back to default_value
    expect(session.data.values.budget).toBe(500);
  });

  test('initializes _clarification_count to 0', async () => {
    const session = createSession({ factStore });
    const ir = makeAgentIR({
      memory: { session: [], persistent: [], remember: [], recall: [] },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values._clarification_count).toBe(0);
  });

  test('executes session_start RECALL in parallel with defaults loading', async () => {
    // Pre-populate a recall fact
    await factStore.set({
      key: 'preferences.chain',
      value: 'Hilton',
      source: { type: 'agent' },
    });

    const session = createSession({ factStore });
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [{ path: 'budget', access: 'readwrite', default_value: 500 }],
        remember: [],
        recall: [
          {
            event: 'session_start',
            instruction: 'Load preferences',
            action: { type: 'inject_context', paths: ['preferences.chain'] },
          },
        ],
      },
    });

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    await initializeAllMemory(session, ir, (e) => traceEvents.push(e));

    // Both loaded in parallel
    expect(session.data.values['preferences.chain']).toBe('Hilton');
    expect(session.data.values.budget).toBe(500);
    expect(traceEvents.some((e) => e.type === 'memory_recall')).toBe(true);
  });

  test('skips write-only persistent paths (not loaded from DB)', async () => {
    const session = createSession({ factStore });

    // Pre-populate facts for both readable and write-only paths
    await factStore.set({ key: 'read_path', value: 'loaded', source: { type: 'agent' } });
    await factStore.set({ key: 'write_path', value: 'should-not-load', source: { type: 'agent' } });
    await factStore.set({ key: 'rw_path', value: 'also-loaded', source: { type: 'agent' } });

    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'read_path', access: 'read' },
          { path: 'write_path', access: 'write', default_value: 'write-default' },
          { path: 'rw_path', access: 'readwrite' },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    // read and readwrite paths loaded from DB
    expect(session.data.values.read_path).toBe('loaded');
    expect(session.data.values.rw_path).toBe('also-loaded');
    // write-only path NOT loaded — not even default_value
    expect(session.data.values.write_path).toBeUndefined();
  });

  test('uses getMany (batch $in) instead of query for persistent defaults', async () => {
    const session = createSession({ factStore });

    await factStore.set({ key: 'pref_a', value: 'A', source: { type: 'agent' } });

    const getManySpy = vi.spyOn(factStore, 'getMany');
    const querySpy = vi.spyOn(factStore, 'query');

    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'pref_a', access: 'readwrite' },
          { path: 'pref_b', access: 'read', default_value: 'B' },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    // getMany called with only the readable paths
    expect(getManySpy).toHaveBeenCalledWith(['pref_a', 'pref_b']);
    // query should NOT be called for persistent defaults loading
    expect(querySpy).not.toHaveBeenCalled();

    expect(session.data.values.pref_a).toBe('A');
    expect(session.data.values.pref_b).toBe('B');
  });

  test('no-op when no memory config', async () => {
    const session = createSession({ factStore });
    const ir = makeAgentIR(); // no memory

    await initializeAllMemory(session, ir);

    expect(session.data.values).toEqual({
      _memory_initialized_agent: 'TestAgent',
    });
  });

  test('falls back to defaults when no FactStore', async () => {
    const session = createSession(); // no factStore
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [{ path: 'budget', access: 'readwrite', default_value: 500 }],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values.budget).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// evaluateRememberAfterStateChange
// ---------------------------------------------------------------------------

describe('evaluateRememberAfterStateChange', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('stores facts when triggers match', async () => {
    const session = createSession({
      factStore,
      agentIR: makeAgentIR({
        memory: {
          session: [],
          persistent: [],
          remember: [
            {
              when: 'preferred_chain IS SET',
              store: { value: 'preferred_chain', target: 'preferences.chain' },
            },
          ],
          recall: [],
        },
      }),
    });

    session.data.values.preferred_chain = 'Marriott';

    await evaluateRememberAfterStateChange(session);

    // Key is just the target path — no user prefix
    const fact = await factStore.get({ key: 'preferences.chain' });
    expect(fact).not.toBeNull();
    expect(fact!.value).toBe('Marriott');
  });

  test('no-op when no memory config', async () => {
    const session = createSession({
      factStore,
      agentIR: makeAgentIR(),
    });

    await evaluateRememberAfterStateChange(session);
  });

  test('no-op when no factStore', async () => {
    const session = createSession({
      agentIR: makeAgentIR({
        memory: {
          session: [],
          persistent: [],
          remember: [{ when: 'x IS SET', store: { value: 'x', target: 'y' } }],
          recall: [],
        },
      }),
    });

    await evaluateRememberAfterStateChange(session);
  });
});

// ---------------------------------------------------------------------------
// executeRecallAfterToolCall
// ---------------------------------------------------------------------------

describe('executeRecallAfterToolCall', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('detects search event and recalls', async () => {
    await factStore.set({
      key: 'search_prefs',
      value: { sort: 'price' },
      source: { type: 'agent' },
    });

    const session = createSession({
      factStore,
      agentIR: makeAgentIR({
        memory: {
          session: [],
          persistent: [],
          remember: [],
          recall: [
            {
              event: 'tool:search_hotels:after',
              instruction: 'Load search prefs',
              action: { type: 'inject_context', paths: ['search_prefs'] },
            },
          ],
        },
      }),
    });

    await executeRecallAfterToolCall(session, 'search_hotels');

    expect(session.data.values.search_prefs).toEqual({ sort: 'price' });
  });
});

// ---------------------------------------------------------------------------
// executeRecallAfterExtraction
// ---------------------------------------------------------------------------

describe('executeRecallAfterExtraction', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('detects entity events and recalls', async () => {
    await factStore.set({
      key: 'destination_history',
      value: ['Paris', 'London'],
      source: { type: 'agent' },
    });

    const session = createSession({
      factStore,
      agentIR: makeAgentIR({
        memory: {
          session: [],
          persistent: [],
          remember: [],
          recall: [
            {
              event: 'entity:destination:extracted',
              instruction: 'Load history',
              action: { type: 'inject_context', paths: ['destination_history'] },
            },
          ],
        },
      }),
    });

    await executeRecallAfterExtraction(session, ['destination']);

    expect(session.data.values.destination_history).toEqual(['Paris', 'London']);
  });
});

// ---------------------------------------------------------------------------
// detectAndStorePreferences
// ---------------------------------------------------------------------------

describe('detectAndStorePreferences', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('stores detected preferences via FactStore', async () => {
    const session = createSession({
      factStore,
      agentIR: makeAgentIR({
        gather: {
          fields: [{ name: 'hotel', type: 'string', required: true, preferences: true }],
          strategy: 'hybrid',
        },
      }),
    });

    await detectAndStorePreferences(session, 'I prefer Hilton hotels', ['hotel']);

    // Key is just preferences.{category} — no user prefix
    const desireFact = await factStore.get({ key: 'preferences.desire' });
    expect(desireFact).not.toBeNull();
    expect(desireFact!.value as string[]).toContain('Hilton hotels');
  });

  test('no-op when no gather fields have preferences flag', async () => {
    const session = createSession({
      factStore,
      agentIR: makeAgentIR({
        gather: {
          fields: [{ name: 'hotel', type: 'string', required: true }],
          strategy: 'hybrid',
        },
      }),
    });

    await detectAndStorePreferences(session, 'I prefer Hilton', ['hotel']);
    const facts = await factStore.query({});
    expect(facts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe('error resilience', () => {
  test('all functions catch errors and emit trace events without throwing', async () => {
    const brokenStore = {
      get: vi.fn().mockRejectedValue(new Error('DB down')),
      getMany: vi.fn().mockRejectedValue(new Error('DB down')),
      set: vi.fn().mockRejectedValue(new Error('DB down')),
      query: vi.fn().mockRejectedValue(new Error('DB down')),
    } as unknown as FactStore;

    const session = createSession({
      factStore: brokenStore,
      agentIR: makeAgentIR({
        memory: {
          session: [{ name: 'x', initial_value: 1 }],
          persistent: [{ path: 'y', access: 'readwrite', default_value: 2 }],
          remember: [{ when: 'x IS SET', store: { value: 'x', target: 'z' } }],
          recall: [
            {
              event: 'session_start',
              instruction: 'test',
              action: { type: 'inject_context', paths: ['z'] },
            },
          ],
        },
        gather: {
          fields: [{ name: 'h', type: 'string', required: true, preferences: true }],
          strategy: 'hybrid',
        },
      }),
    });
    session.data.values.x = 'set';

    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTrace = (e: { type: string; data: Record<string, unknown> }) => traceEvents.push(e);

    // None of these should throw
    await initializeAllMemory(session, session.agentIR!, onTrace);
    await evaluateRememberAfterStateChange(session, onTrace);
    await executeRecallAfterToolCall(session, 'search_hotels', onTrace);
    await executeRecallAfterExtraction(session, ['dest'], onTrace);
    await detectAndStorePreferences(session, 'I prefer X', ['h'], onTrace);

    // Session memory initial values should still be set (no DB needed)
    expect(session.data.values.x).toBe('set');
    // Persistent defaults should fall back when batch query fails
    expect(session.data.values.y).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// REMEMBER scope routing (project vs user)
// ---------------------------------------------------------------------------

describe('REMEMBER project-scope routing', () => {
  let userFactStore: InMemoryFactStore;

  beforeEach(() => {
    userFactStore = createFactStore();
  });

  afterEach(() => {
    userFactStore.stop();
  });

  test('when scope === "project" but session.projectFactStore is undefined, REMEMBER skips and does NOT write to user factStore', async () => {
    const session = createSession({
      factStore: userFactStore,
      // projectFactStore intentionally absent
      agentIR: makeAgentIR({
        memory: {
          session: [],
          persistent: [{ path: 'shared.setting', access: 'readwrite', scope: 'project' }],
          remember: [
            {
              when: 'shared_val IS SET',
              store: { value: 'shared_val', target: 'shared.setting' },
            },
          ],
          recall: [],
        },
      }),
    });

    session.data.values.shared_val = 'project-wide-value';

    const setSpy = vi.spyOn(userFactStore, 'set');

    await evaluateRememberAfterStateChange(session);

    // The user factStore should NOT have been written to as a fallback
    expect(setSpy).not.toHaveBeenCalled();

    // Confirm nothing was stored in the user store
    const fact = await userFactStore.get({ key: 'shared.setting' });
    expect(fact).toBeNull();
  });

  test('when scope === "project" and session.projectFactStore exists, REMEMBER writes to projectFactStore', async () => {
    const projectFactStore = createFactStore();

    try {
      const session = createSession({
        factStore: userFactStore,
        projectFactStore,
        agentIR: makeAgentIR({
          memory: {
            session: [],
            persistent: [{ path: 'shared.setting', access: 'readwrite', scope: 'project' }],
            remember: [
              {
                when: 'shared_val IS SET',
                store: { value: 'shared_val', target: 'shared.setting' },
              },
            ],
            recall: [],
          },
        }),
      });

      session.data.values.shared_val = 'project-wide-value';

      await evaluateRememberAfterStateChange(session);

      // Written to the project store
      const projectFact = await projectFactStore.get({ key: 'shared.setting' });
      expect(projectFact).not.toBeNull();
      expect(projectFact!.value).toBe('project-wide-value');

      // NOT written to the user store
      const userFact = await userFactStore.get({ key: 'shared.setting' });
      expect(userFact).toBeNull();
    } finally {
      projectFactStore.stop();
    }
  });
});
