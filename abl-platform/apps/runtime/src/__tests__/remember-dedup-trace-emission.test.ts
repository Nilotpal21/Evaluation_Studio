/**
 * Lock test for Slice 4 [ABLP-411] — dedup must emit trace for both skip and write.
 *
 * Bruce feedback 3.1: observability is not sacrificed for perf. When a
 * write is skipped by dedup, we still emit a `memory_trigger_evaluated`
 * decision with `skipped: true` so dashboards and debug traces can show
 * that the trigger fired AND that no write occurred.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { AgentIR } from '@abl/compiler';
import type { RuntimeSession } from '../services/execution/types.js';
import type { TraceEvent } from '@abl/compiler/platform/types.js';
import { evaluateRememberAfterStateChange } from '../services/execution/memory-integration.js';

function createSession(factStore: InMemoryFactStore, ir: AgentIR): RuntimeSession {
  return {
    id: 'session-trace',
    agentName: 'TestAgent',
    agentIR: ir,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: { pref: 'dark' }, gatheredKeys: new Set<string>() },
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
    traceVerbosity: 'verbose',
    callerContext: {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    },
  } as unknown as RuntimeSession;
}

function makeIR(): AgentIR {
  return {
    name: 'TestAgent',
    description: 'Test',
    execution: { mode: 'reasoning' },
    memory: {
      session: [],
      persistent: [],
      remember: [{ when: 'pref IS SET', store: { value: 'pref', target: 'user.pref' } }],
      recall: [],
    },
  } as unknown as AgentIR;
}

describe('REMEMBER dedup — trace emission', () => {
  let factStore: InMemoryFactStore;

  beforeEach(() => {
    factStore = new InMemoryFactStore({ type: 'memory' });
  });

  afterEach(() => {
    factStore.stop();
  });

  test('first pass emits a trigger_evaluated write trace', async () => {
    const session = createSession(factStore, makeIR());
    const traces: TraceEvent[] = [];
    await evaluateRememberAfterStateChange(session, (evt) => {
      traces.push(evt);
    });
    const trigger = traces.find(
      (t) =>
        t.type === 'memory_trigger_evaluated' ||
        (t.type === 'decision' &&
          typeof t.data === 'object' &&
          t.data !== null &&
          (t.data as Record<string, unknown>).decisionKind === 'memory_trigger_evaluated'),
    );
    expect(trigger).toBeTruthy();
  });

  test('second pass (dedup skip) emits a trigger_evaluated trace with skipped=true', async () => {
    const session = createSession(factStore, makeIR());
    await evaluateRememberAfterStateChange(session);

    const traces: TraceEvent[] = [];
    await evaluateRememberAfterStateChange(session, (evt) => {
      traces.push(evt);
    });
    // At least one trace must report the trigger as skipped by dedup.
    const skipped = traces.find((t) => {
      const wrapped =
        t.type === 'decision' &&
        typeof t.data === 'object' &&
        t.data !== null &&
        ((t.data as Record<string, unknown>).decisionKind === 'memory_trigger_evaluated' ||
          (t.data as Record<string, unknown>).decisionKind === 'memory_dedup_skipped');
      const direct = t.type === 'memory_trigger_evaluated' || t.type === 'memory_dedup_skipped';
      if (!wrapped && !direct) return false;
      const data = t.data as Record<string, unknown>;
      return (
        data.skipped === true || data.reason === 'unchanged' || t.type === 'memory_dedup_skipped'
      );
    });
    expect(skipped).toBeTruthy();
  });
});
