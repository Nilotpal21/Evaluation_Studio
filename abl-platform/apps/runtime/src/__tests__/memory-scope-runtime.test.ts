import { describe, expect, test } from 'vitest';

import {
  applyGrantedMemoryState,
  applyScopedMemoryWrite,
  buildGrantedMemoryState,
} from '../services/execution/memory-scope-runtime.js';
import { deleteSessionValue, type RuntimeSession } from '../services/execution/types.js';

function createSession(): RuntimeSession {
  return {
    id: 'memory-scope-session',
    agentName: 'ChildAgent',
    agentIR: {
      memory: {
        session: [],
        persistent: [
          {
            path: 'workflow.auth_token',
            scope: 'execution_tree',
            access: 'readwrite',
          },
        ],
        remember: [],
        recall: [],
      },
    } as RuntimeSession['agentIR'],
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    executionTreeValues: {},
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  } as RuntimeSession;
}

describe('memory-scope-runtime helpers', () => {
  test('readwrite granted memory writes flow back into execution_tree storage', () => {
    const session = createSession();

    applyGrantedMemoryState(
      session,
      buildGrantedMemoryState([
        {
          path: 'workflow.auth_token',
          access: 'readwrite',
          value: 'initial-token',
          sourcePath: 'workflow.auth_token',
          sourceScope: 'execution_tree',
        },
      ]),
    );

    const applied = applyScopedMemoryWrite(
      session,
      'granted_memory.workflow.auth_token',
      'rotated-token',
    );

    expect(applied).toBe(true);
    expect(session.executionTreeValues).toEqual({ 'workflow.auth_token': 'rotated-token' });
    expect(session.data.values['workflow.auth_token']).toBe('rotated-token');
    expect(session.data.values._granted_memory).toEqual({
      'workflow.auth_token': 'rotated-token',
    });
    expect(session.data.values.granted_memory).toEqual({
      workflow: { auth_token: 'rotated-token' },
    });
    expect(session.data.values.execution_tree).toEqual({
      workflow: { auth_token: 'rotated-token' },
    });
  });

  test('readwrite execution_tree grants preserve writable metadata without an initial value', () => {
    const session = createSession();

    applyGrantedMemoryState(
      session,
      buildGrantedMemoryState([
        {
          path: 'workflow.auth_token',
          access: 'readwrite',
          value: undefined,
          sourcePath: 'workflow.auth_token',
          sourceScope: 'execution_tree',
        },
      ]),
    );

    expect(session.data.values._granted_memory).toBeUndefined();
    expect(session.data.values.granted_memory).toBeUndefined();
    expect(session.data.values._granted_memory_meta).toEqual({
      'workflow.auth_token': {
        access: 'readwrite',
        path: 'workflow.auth_token',
        sourcePath: 'workflow.auth_token',
        sourceScope: 'execution_tree',
      },
    });

    const applied = applyScopedMemoryWrite(
      session,
      'granted_memory.workflow.auth_token',
      'minted-token',
    );

    expect(applied).toBe(true);
    expect(session.executionTreeValues).toEqual({ 'workflow.auth_token': 'minted-token' });
    expect(session.data.values['workflow.auth_token']).toBe('minted-token');
    expect(session.data.values._granted_memory).toEqual({
      'workflow.auth_token': 'minted-token',
    });
  });

  test('clearing granted execution_tree memory removes workflow storage and projections', () => {
    const session = createSession();

    applyGrantedMemoryState(
      session,
      buildGrantedMemoryState([
        {
          path: 'workflow.auth_token',
          access: 'readwrite',
          value: 'initial-token',
          sourcePath: 'workflow.auth_token',
          sourceScope: 'execution_tree',
        },
      ]),
    );
    applyScopedMemoryWrite(session, 'granted_memory.workflow.auth_token', 'rotated-token');

    deleteSessionValue(session, 'granted_memory.workflow.auth_token');

    expect(session.executionTreeValues).toEqual({});
    expect(session.data.values['workflow.auth_token']).toBeUndefined();
    expect(session.data.values.execution_tree).toBeUndefined();
    expect(session.data.values.granted_memory).toBeUndefined();
    expect(session.data.values._granted_memory).toBeUndefined();
  });

  test('direct execution_tree writes keep granted aliases in sync', () => {
    const session = createSession();

    applyGrantedMemoryState(
      session,
      buildGrantedMemoryState([
        {
          path: 'workflow.auth_token',
          access: 'readwrite',
          value: 'initial-token',
          sourcePath: 'workflow.auth_token',
          sourceScope: 'execution_tree',
        },
      ]),
    );

    const applied = applyScopedMemoryWrite(session, 'workflow.auth_token', 'direct-update');

    expect(applied).toBe(true);
    expect(session.executionTreeValues).toEqual({ 'workflow.auth_token': 'direct-update' });
    expect(session.data.values._granted_memory).toEqual({
      'workflow.auth_token': 'direct-update',
    });
    expect(session.data.values.granted_memory).toEqual({
      workflow: { auth_token: 'direct-update' },
    });
  });
});
