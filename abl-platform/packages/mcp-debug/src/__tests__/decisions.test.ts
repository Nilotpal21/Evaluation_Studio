import { describe, test, expect } from 'vitest';
import { explainDecision } from '../tools/decisions.js';
import { SessionStore } from '../store/session-store.js';
import type { DebugContext } from '../tools/index.js';
import type { DecisionLogEntry } from '../types.js';

function createMockContext(decisionLog?: DecisionLogEntry[]): DebugContext {
  const sessionStore = new SessionStore();
  const session = sessionStore.createSession('test-session', 'test-agent');
  if (decisionLog) {
    sessionStore.updateState('test-session', {
      context: {},
      conversationPhase: 'active',
      gatherProgress: {},
      constraintResults: {},
      lastToolResults: {},
      memory: { session: {}, persistentCache: {}, pendingRemembers: [] },
      decisionLog,
    });
  }
  return {
    sessionStore,
    traceStore: {
      getBySession: () => [],
      getById: () => undefined,
      getBySpan: () => [],
    },
    wsClient: { isConnected: () => false },
  } as any;
}

function makeEntry(overrides: Partial<DecisionLogEntry> & { turn: number }): DecisionLogEntry {
  return {
    timestamp: Date.now(),
    type: 'constraint_check',
    outcome: 'passed',
    matched: true,
    ...overrides,
  };
}

describe('explainDecision', () => {
  test('returns decision log entries grouped by turn', async () => {
    const log: DecisionLogEntry[] = [
      makeEntry({ turn: 1, type: 'gather_extraction', outcome: 'extracted name', timestamp: 100 }),
      makeEntry({ turn: 1, type: 'constraint_check', outcome: 'email valid', timestamp: 200 }),
      makeEntry({ turn: 2, type: 'handoff', outcome: 'routed to billing', timestamp: 300 }),
    ];
    const ctx = createMockContext(log);

    const result = JSON.parse(await explainDecision({ lastN: 5 }, ctx));

    expect(result.success).toBe(true);
    expect(result.totalDecisions).toBe(3);
    expect(result.byTurn).toBeDefined();
    expect(result.byTurn[1]).toHaveLength(2);
    expect(result.byTurn[2]).toHaveLength(1);
  });

  test('filters by turn number and includes causal chain', async () => {
    const log: DecisionLogEntry[] = [
      makeEntry({ turn: 1, type: 'gather_extraction', outcome: 'extracted name', timestamp: 100 }),
      makeEntry({
        turn: 2,
        type: 'constraint_check',
        outcome: 'age >= 18',
        matched: true,
        timestamp: 200,
      }),
      makeEntry({
        turn: 2,
        type: 'handoff',
        outcome: 'routed to booking',
        matched: true,
        timestamp: 300,
      }),
      makeEntry({ turn: 3, type: 'completion', outcome: 'done', timestamp: 400 }),
    ];
    const ctx = createMockContext(log);

    const result = JSON.parse(await explainDecision({ turn: 2, lastN: 5 }, ctx));

    expect(result.success).toBe(true);
    expect(result.turn).toBe(2);
    expect(result.count).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.causalChain).toBeDefined();
    expect(result.causalChain).toHaveLength(2);
    expect(result.causalChain[0]).toContain('START');
    expect(result.causalChain[1]).toContain('STEP 1');
  });

  test('filters by type', async () => {
    const log: DecisionLogEntry[] = [
      makeEntry({ turn: 1, type: 'constraint_check', outcome: 'check 1', timestamp: 100 }),
      makeEntry({ turn: 1, type: 'handoff', outcome: 'route 1', timestamp: 200 }),
      makeEntry({ turn: 2, type: 'constraint_check', outcome: 'check 2', timestamp: 300 }),
      makeEntry({ turn: 3, type: 'completion', outcome: 'done', timestamp: 400 }),
    ];
    const ctx = createMockContext(log);

    const result = JSON.parse(await explainDecision({ type: 'constraint_check', lastN: 5 }, ctx));

    expect(result.success).toBe(true);
    expect(result.type).toBe('constraint_check');
    expect(result.count).toBe(2);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e: any) => e.type === 'constraint_check')).toBe(true);
  });

  test('falls back to trace events when no decision log', async () => {
    const ctx = createMockContext(); // No decision log

    const result = JSON.parse(await explainDecision({ lastN: 5 }, ctx));

    expect(result.success).toBe(true);
    expect(result.explanations).toEqual([]);
    expect(result.message).toContain('No decision events found');
  });

  test('builds causal chain for a turn', async () => {
    const log: DecisionLogEntry[] = [
      makeEntry({
        turn: 1,
        type: 'gather_extraction',
        outcome: 'extracted email',
        matched: true,
        timestamp: 100,
      }),
      makeEntry({
        turn: 1,
        type: 'constraint_check',
        outcome: 'email format invalid',
        matched: false,
        timestamp: 200,
      }),
      makeEntry({
        turn: 1,
        type: 'respond',
        outcome: 'asked for valid email',
        matched: true,
        timestamp: 300,
      }),
    ];
    const ctx = createMockContext(log);

    const result = JSON.parse(await explainDecision({ turn: 1, lastN: 5 }, ctx));

    expect(result.causalChain).toHaveLength(3);
    expect(result.causalChain[0]).toContain('gather_extraction');
    expect(result.causalChain[0]).toContain('MATCHED');
    expect(result.causalChain[1]).toContain('constraint_check');
    expect(result.causalChain[1]).toContain('NOT MATCHED');
    expect(result.causalChain[2]).toContain('respond');
  });

  test('respects lastN parameter', async () => {
    const log: DecisionLogEntry[] = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        turn: i + 1,
        type: 'constraint_check',
        outcome: `check ${i}`,
        timestamp: i * 100,
      }),
    );
    const ctx = createMockContext(log);

    const result = JSON.parse(await explainDecision({ lastN: 3 }, ctx));

    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(result.totalDecisions).toBe(10);
  });
});
