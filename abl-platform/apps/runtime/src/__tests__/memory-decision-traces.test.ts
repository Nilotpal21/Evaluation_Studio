/**
 * Memory Decision Traces Tests
 *
 * Verifies that memory integration functions emit the correct decision trace
 * events at verbose verbosity, and that none are emitted at standard verbosity.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
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
// Helpers
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
    traceVerbosity: 'verbose',
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

type TraceEvent = { type: string; data: Record<string, unknown> };

function collectTraces(): { events: TraceEvent[]; onTrace: (e: TraceEvent) => void } {
  const events: TraceEvent[] = [];
  return { events, onTrace: (e: TraceEvent) => events.push(e) };
}

// ---------------------------------------------------------------------------
// memory_unavailable
// ---------------------------------------------------------------------------

describe('memory_unavailable traces', () => {
  test('emitted when no memory config on initializeAllMemory', async () => {
    const session = createSession();
    const ir = makeAgentIR(); // no memory config
    const { events, onTrace } = collectTraces();

    await initializeAllMemory(session, ir, onTrace);

    const unavailable = events.filter((e) => e.type === 'memory_unavailable');
    expect(unavailable.length).toBeGreaterThanOrEqual(1);
    expect(unavailable[0].data.reason).toBe('no_memory_config');
    expect(unavailable[0].data.operation).toBe('init');
    expect(unavailable[0].data.agentName).toBe('TestAgent');
  });

  test('emitted with reason no_fact_store on evaluateRememberAfterStateChange', async () => {
    const session = createSession({
      // no factStore
      agentIR: makeAgentIR({
        memory: {
          session: [],
          persistent: [],
          remember: [{ when: 'x IS SET', store: { value: 'x', target: 'y' } }],
          recall: [],
        },
      }),
    });
    session.data.values.x = 'hello';
    const { events, onTrace } = collectTraces();

    await evaluateRememberAfterStateChange(session, onTrace);

    const unavailable = events.filter((e) => e.type === 'memory_unavailable');
    expect(unavailable.length).toBe(1);
    expect(unavailable[0].data.reason).toBe('no_fact_store');
    expect(unavailable[0].data.operation).toBe('remember');
  });

  test('emitted with reason no_memory_config on evaluateRememberAfterStateChange when no remember config', async () => {
    const session = createSession({
      agentIR: makeAgentIR(), // no memory at all
    });
    const { events, onTrace } = collectTraces();

    await evaluateRememberAfterStateChange(session, onTrace);

    const unavailable = events.filter((e) => e.type === 'memory_unavailable');
    expect(unavailable.length).toBe(1);
    expect(unavailable[0].data.reason).toBe('no_memory_config');
    expect(unavailable[0].data.operation).toBe('remember');
  });

  test('emitted with reason no_memory_config on executeRecallAfterToolCall when no recall config', async () => {
    const session = createSession({
      agentIR: makeAgentIR(), // no memory
    });
    const { events, onTrace } = collectTraces();

    await executeRecallAfterToolCall(session, 'search_hotels', onTrace);

    const unavailable = events.filter((e) => e.type === 'memory_unavailable');
    expect(unavailable.length).toBe(1);
    expect(unavailable[0].data.reason).toBe('no_memory_config');
    expect(unavailable[0].data.operation).toBe('recall');
  });

  test('emitted with reason no_memory_config on executeRecallAfterExtraction when no recall config', async () => {
    const session = createSession({
      agentIR: makeAgentIR(), // no memory
    });
    const { events, onTrace } = collectTraces();

    await executeRecallAfterExtraction(session, ['destination'], onTrace);

    const unavailable = events.filter((e) => e.type === 'memory_unavailable');
    expect(unavailable.length).toBe(1);
    expect(unavailable[0].data.reason).toBe('no_memory_config');
    expect(unavailable[0].data.operation).toBe('recall');
  });

  test('emitted with reason no_fact_store on detectAndStorePreferences', async () => {
    const session = createSession({
      // no factStore
      agentIR: makeAgentIR({
        gather: {
          fields: [{ name: 'hotel', type: 'string', required: true, preferences: true }],
          strategy: 'hybrid',
        },
      }),
    });
    const { events, onTrace } = collectTraces();

    await detectAndStorePreferences(session, 'I prefer Hilton hotels', ['hotel'], onTrace);

    const unavailable = events.filter((e) => e.type === 'memory_unavailable');
    expect(unavailable.length).toBe(1);
    expect(unavailable[0].data.reason).toBe('no_fact_store');
    expect(unavailable[0].data.operation).toBe('preferences');
  });

  test('emitted with reason no_memory_config on detectAndStorePreferences when no gather fields', async () => {
    const session = createSession({
      agentIR: makeAgentIR(), // no gather config
    });
    const { events, onTrace } = collectTraces();

    await detectAndStorePreferences(session, 'I prefer Hilton hotels', ['hotel'], onTrace);

    const unavailable = events.filter((e) => e.type === 'memory_unavailable');
    expect(unavailable.length).toBe(1);
    expect(unavailable[0].data.reason).toBe('no_memory_config');
    expect(unavailable[0].data.operation).toBe('preferences');
  });
});

// ---------------------------------------------------------------------------
// memory_trigger_evaluated
// ---------------------------------------------------------------------------

describe('memory_trigger_evaluated traces', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('emitted with result: true when trigger fires', async () => {
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
    const { events, onTrace } = collectTraces();

    await evaluateRememberAfterStateChange(session, onTrace);

    const triggerTraces = events.filter((e) => e.type === 'memory_trigger_evaluated');
    expect(triggerTraces.length).toBe(1);
    expect(triggerTraces[0].data.result).toBe(true);
    expect(triggerTraces[0].data.trigger).toBe('preferences.chain');
    expect(triggerTraces[0].data.value).toBe('Marriott');
    expect(triggerTraces[0].data.agentName).toBe('TestAgent');
  });

  test('emitted with result: false when no triggers match', async () => {
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
    // preferred_chain is NOT set in session values, so trigger should not match
    const { events, onTrace } = collectTraces();

    await evaluateRememberAfterStateChange(session, onTrace);

    const triggerTraces = events.filter((e) => e.type === 'memory_trigger_evaluated');
    expect(triggerTraces.length).toBe(1);
    expect(triggerTraces[0].data.result).toBe(false);
    expect(triggerTraces[0].data.reason).toBe('no_conditions_matched');
    expect(triggerTraces[0].data.triggerCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// memory_recall_result
// ---------------------------------------------------------------------------

describe('memory_recall_result traces', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('emitted with factsFound count after recall', async () => {
    // Pre-populate a fact
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
    const { events, onTrace } = collectTraces();

    await executeRecallAfterToolCall(session, 'search_hotels', onTrace);

    const recallResults = events.filter((e) => e.type === 'memory_recall_result');
    expect(recallResults.length).toBe(1);
    expect(recallResults[0].data.factsFound).toBe(1);
    expect(recallResults[0].data.factsLoaded).toEqual(['search_prefs']);
    expect(recallResults[0].data.event).toBe('tool:search_hotels');
    expect(recallResults[0].data.agentName).toBe('TestAgent');
  });

  test('emitted with factsFound: 0 when no matching facts', async () => {
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
              action: { type: 'inject_context', paths: ['nonexistent_key'] },
            },
          ],
        },
      }),
    });
    const { events, onTrace } = collectTraces();

    await executeRecallAfterToolCall(session, 'search_hotels', onTrace);

    const recallResults = events.filter((e) => e.type === 'memory_recall_result');
    expect(recallResults.length).toBe(1);
    expect(recallResults[0].data.factsFound).toBe(0);
    expect(recallResults[0].data.factsLoaded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// preference_detected
// ---------------------------------------------------------------------------

describe('preference_detected traces', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('emitted with category and confidence for each detected preference', async () => {
    const session = createSession({
      factStore,
      agentIR: makeAgentIR({
        gather: {
          fields: [{ name: 'hotel', type: 'string', required: true, preferences: true }],
          strategy: 'hybrid',
        },
      }),
    });
    const { events, onTrace } = collectTraces();

    await detectAndStorePreferences(session, 'I prefer Hilton hotels', ['hotel'], onTrace);

    const prefTraces = events.filter((e) => e.type === 'preference_detected');
    expect(prefTraces.length).toBeGreaterThanOrEqual(1);

    const first = prefTraces[0];
    expect(first.data.category).toBe('desire');
    expect(first.data.confidence).toBe(0.8);
    expect(first.data.text).toBe('Hilton hotels');
    expect(first.data.agentName).toBe('TestAgent');
  });
});

// ---------------------------------------------------------------------------
// Verbosity gating: none emitted at 'standard'
// ---------------------------------------------------------------------------

describe('verbosity gating', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = createFactStore();
  });

  afterEach(() => {
    factStore.stop();
  });

  test('no decision traces emitted at standard verbosity', async () => {
    const session = createSession({
      traceVerbosity: 'standard',
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
          recall: [
            {
              event: 'search_initiated',
              instruction: 'Load prefs',
              action: { type: 'inject_context', paths: ['search_prefs'] },
            },
          ],
        },
        gather: {
          fields: [{ name: 'hotel', type: 'string', required: true, preferences: true }],
          strategy: 'hybrid',
        },
      }),
    });
    session.data.values.preferred_chain = 'Marriott';

    const { events, onTrace } = collectTraces();

    // Run all memory functions
    await evaluateRememberAfterStateChange(session, onTrace);
    await executeRecallAfterToolCall(session, 'search_hotels', onTrace);
    await executeRecallAfterExtraction(session, ['destination'], onTrace);
    await detectAndStorePreferences(session, 'I prefer Hilton hotels', ['hotel'], onTrace);

    // Decision trace types that require verbose level
    const decisionTraceTypes = [
      'memory_unavailable',
      'memory_trigger_evaluated',
      'memory_recall_result',
      'preference_detected',
    ];

    const decisionTraces = events.filter((e) => decisionTraceTypes.includes(e.type));
    expect(decisionTraces).toEqual([]);
  });

  test('no decision traces emitted when traceVerbosity is not set (defaults to standard)', async () => {
    const session = createSession({
      traceVerbosity: undefined, // defaults to standard
    });
    const ir = makeAgentIR(); // no memory config
    const { events, onTrace } = collectTraces();

    await initializeAllMemory(session, ir, onTrace);

    const decisionTraces = events.filter((e) => e.type === 'memory_unavailable');
    expect(decisionTraces).toEqual([]);
  });
});
