/**
 * Test Session Factory
 *
 * Creates minimal RuntimeSession instances for parity testing.
 * Each factory method produces a session in a specific state
 * to isolate the behavior under test.
 *
 * These factories produce objects matching the ACTUAL RuntimeSession,
 * RuntimeState, and SessionDataStore interfaces from execution/types.ts.
 */

import type {
  RuntimeSession,
  RuntimeState,
  SessionDataStore,
} from '../../../../services/execution/types.js';

export function createBaseState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    gatherProgress: {},
    conversationPhase: 'start',
    context: {},
    ...overrides,
  };
}

export function createBaseDataStore(overrides: Partial<SessionDataStore> = {}): SessionDataStore {
  return {
    values: {},
    gatheredKeys: new Set<string>(),
    ...overrides,
  };
}

/**
 * Creates a minimal RuntimeSession with all required fields.
 * Overrides let tests set specific fields without boilerplate.
 */
export function createBaseSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  const now = new Date();
  return {
    id: `test-session-${Date.now()}`,
    agentName: 'test-agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: createBaseState(),
    data: createBaseDataStore(),
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    storeVersion: 0,
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

/**
 * Creates a session with a compiled agent IR loaded.
 * Use this for testing execution paths that require agent logic.
 */
export function createSessionWithAgent(
  agentIR: RuntimeSession['agentIR'],
  overrides: Partial<RuntimeSession> = {},
): RuntimeSession {
  return createBaseSession({
    agentIR,
    initialized: true,
    ...overrides,
  });
}

/**
 * Creates a session mid-gather (fields partially collected).
 * Useful for testing gather continuation and validation paths.
 */
export function createGatherSession(
  gatheredFields: Record<string, unknown>,
  pendingFields: string[],
  overrides: Partial<RuntimeSession> = {},
): RuntimeSession {
  const gatheredKeys = new Set(Object.keys(gatheredFields));
  return createBaseSession({
    data: {
      values: { ...gatheredFields },
      gatheredKeys,
    },
    state: createBaseState({
      gatherProgress: Object.fromEntries(
        [...gatheredKeys].map((k) => [k, { value: gatheredFields[k], validated: true }]),
      ),
    }),
    waitingForInput: pendingFields,
    ...overrides,
  });
}
