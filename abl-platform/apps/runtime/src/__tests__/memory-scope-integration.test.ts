/**
 * Memory Scope Integration Tests
 *
 * Tests that the memory integration layer correctly:
 * - Splits persistent memory loading by scope (user vs project)
 * - Routes REMEMBER writes to the correct FactStore by scope
 * - Falls back to default_value for both scopes
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryFactStore } from '@abl/compiler/platform/stores/fact-store.js';
import type { AgentIR } from '@abl/compiler';
import type { RuntimeSession } from '../services/execution/types.js';
import {
  initializeAllMemory,
  evaluateRememberAfterStateChange,
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
    delegateStack: [],
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
// loadPersistentDefaults by scope
// ---------------------------------------------------------------------------

describe('initializeAllMemory: scope-based loading', () => {
  let userFactStore: InMemoryFactStore;
  let projectFactStore: InMemoryFactStore;

  beforeEach(() => {
    userFactStore = createFactStore();
    projectFactStore = createFactStore();
  });

  afterEach(() => {
    userFactStore.stop();
    projectFactStore.stop();
  });

  test('loads user-scoped persistent paths from user factStore', async () => {
    // Pre-populate user fact
    await userFactStore.set({
      key: 'user.preferences',
      value: { theme: 'dark' },
      source: { type: 'agent' },
    });

    const session = createSession({ factStore: userFactStore, projectFactStore });
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'user.preferences', scope: 'user', access: 'readwrite', type: 'object' },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values['user.preferences']).toEqual({ theme: 'dark' });
  });

  test('loads project-scoped persistent paths from project factStore', async () => {
    // Pre-populate project fact
    await projectFactStore.set({
      key: 'global_promotions',
      value: ['spring_sale', 'loyalty_bonus'],
      source: { type: 'system' },
    });

    const session = createSession({ factStore: userFactStore, projectFactStore });
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'global_promotions', scope: 'project', access: 'read', type: 'array' },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values['global_promotions']).toEqual(['spring_sale', 'loyalty_bonus']);
  });

  test('loads mixed user and project scoped paths from respective stores', async () => {
    await userFactStore.set({
      key: 'user.name',
      value: 'Alice',
      source: { type: 'agent' },
    });
    await projectFactStore.set({
      key: 'business_hours',
      value: { open: '9am', close: '5pm' },
      source: { type: 'system' },
    });

    const session = createSession({ factStore: userFactStore, projectFactStore });
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'user.name', scope: 'user', access: 'read' },
          { path: 'business_hours', scope: 'project', access: 'read', type: 'object' },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values['user.name']).toBe('Alice');
    expect(session.data.values['business_hours']).toEqual({ open: '9am', close: '5pm' });
  });

  test('falls back to default_value for project-scoped paths not in store', async () => {
    const session = createSession({ factStore: userFactStore, projectFactStore });
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          {
            path: 'business_hours',
            scope: 'project',
            access: 'read',
            type: 'object',
            default_value: { open: '8am', close: '6pm' },
          },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values['business_hours']).toEqual({ open: '8am', close: '6pm' });
  });

  test('write-only project paths are not loaded at start', async () => {
    await projectFactStore.set({
      key: 'write_only_metric',
      value: 42,
      source: { type: 'system' },
    });

    const session = createSession({ factStore: userFactStore, projectFactStore });
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          { path: 'write_only_metric', scope: 'project', access: 'write', type: 'number' },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values['write_only_metric']).toBeUndefined();
  });

  test('gracefully handles missing project factStore', async () => {
    const session = createSession({ factStore: userFactStore });
    // projectFactStore is undefined
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          {
            path: 'global_config',
            scope: 'project',
            access: 'read',
            default_value: 'fallback',
          },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    // Should fall back to default_value
    expect(session.data.values['global_config']).toBe('fallback');
  });

  test('loads execution_tree scoped paths from workflow memory and projects nested view', async () => {
    const session = createSession({
      factStore: userFactStore,
      projectFactStore,
      executionTreeValues: {
        'workflow.auth_token': 'shared-token',
      },
    });
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [
          {
            path: 'workflow.auth_token',
            scope: 'execution_tree',
            access: 'readwrite',
            type: 'string',
          },
        ],
        remember: [],
        recall: [],
      },
    });

    await initializeAllMemory(session, ir);

    expect(session.data.values['workflow.auth_token']).toBe('shared-token');
    expect(session.executionTreeValues).toEqual({ 'workflow.auth_token': 'shared-token' });
    expect(session.data.values.execution_tree).toEqual({
      workflow: { auth_token: 'shared-token' },
    });
  });
});

// ---------------------------------------------------------------------------
// REMEMBER routing by scope
// ---------------------------------------------------------------------------

describe('evaluateRememberAfterStateChange: scope routing', () => {
  let userFactStore: InMemoryFactStore;
  let projectFactStore: InMemoryFactStore;

  beforeEach(() => {
    userFactStore = createFactStore();
    projectFactStore = createFactStore();
  });

  afterEach(() => {
    userFactStore.stop();
    projectFactStore.stop();
  });

  test('REMEMBER routes to user factStore for user-scoped paths', async () => {
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [{ path: 'user.last_action', scope: 'user', access: 'readwrite' }],
        remember: [
          {
            when: 'action_taken',
            store: { value: 'action_taken', target: 'user.last_action' },
          },
        ],
        recall: [],
      },
    });

    const session = createSession({
      factStore: userFactStore,
      projectFactStore,
      agentIR: ir,
    });
    session.data.values.action_taken = 'booked_hotel';

    await evaluateRememberAfterStateChange(session);

    // User store should have the fact
    const userFact = await userFactStore.get({ key: 'user.last_action' });
    expect(userFact).not.toBeNull();
    expect(userFact!.value).toBe('booked_hotel');

    // Project store should NOT have the fact
    const projectFact = await projectFactStore.get({ key: 'user.last_action' });
    expect(projectFact).toBeNull();
  });

  test('REMEMBER routes to project factStore for project-scoped paths', async () => {
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [{ path: 'shared_counter', scope: 'project', access: 'readwrite' }],
        remember: [
          {
            when: 'counter_updated',
            store: { value: 'counter_updated', target: 'shared_counter' },
          },
        ],
        recall: [],
      },
    });

    const session = createSession({
      factStore: userFactStore,
      projectFactStore,
      agentIR: ir,
    });
    session.data.values.counter_updated = 99;

    await evaluateRememberAfterStateChange(session);

    // Project store should have the fact
    const projectFact = await projectFactStore.get({ key: 'shared_counter' });
    expect(projectFact).not.toBeNull();
    expect(projectFact!.value).toBe(99);

    // User store should NOT have the fact
    const userFact = await userFactStore.get({ key: 'shared_counter' });
    expect(userFact).toBeNull();
  });

  test('REMEMBER stores execution_tree scoped paths in workflow memory instead of fact stores', async () => {
    const ir = makeAgentIR({
      memory: {
        session: [],
        persistent: [{ path: 'workflow.auth_token', scope: 'execution_tree', access: 'readwrite' }],
        remember: [
          {
            when: 'auth_result',
            store: { value: 'auth_result', target: 'workflow.auth_token' },
          },
        ],
        recall: [],
      },
    });

    const session = createSession({
      factStore: userFactStore,
      projectFactStore,
      agentIR: ir,
      executionTreeValues: {},
    });
    session.data.values.auth_result = 'rotating-token';

    await evaluateRememberAfterStateChange(session);

    expect(session.executionTreeValues).toEqual({ 'workflow.auth_token': 'rotating-token' });
    expect(session.data.values['workflow.auth_token']).toBe('rotating-token');
    expect(session.data.values.execution_tree).toEqual({
      workflow: { auth_token: 'rotating-token' },
    });
    expect(await userFactStore.get({ key: 'workflow.auth_token' })).toBeNull();
    expect(await projectFactStore.get({ key: 'workflow.auth_token' })).toBeNull();
  });
});
