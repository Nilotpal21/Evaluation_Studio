/**
 * Tests for ExecutionCoordinator wiring:
 * - Singleton get/set/reset
 * - Coordinator is accessible from handler import paths
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getExecutionCoordinator,
  setExecutionCoordinator,
  isCoordinatorAvailable,
  resetCoordinatorSingleton,
} from '../services/execution/coordinator-singleton.js';
import { ExecutionCoordinator } from '../services/execution/execution-coordinator.js';
import { InMemoryExecutionQueue } from '@agent-platform/execution';
import { ExecutionDedup, InMemoryDedupStore } from '../services/execution/execution-dedup.js';

describe('ExecutionCoordinator singleton', () => {
  beforeEach(() => {
    resetCoordinatorSingleton();
  });

  it('isCoordinatorAvailable returns false before set', () => {
    expect(isCoordinatorAvailable()).toBe(false);
  });

  it('getExecutionCoordinator throws before set', () => {
    expect(() => getExecutionCoordinator()).toThrow('ExecutionCoordinator not initialized');
  });

  it('setExecutionCoordinator makes it available', () => {
    const coordinator = createTestCoordinator();
    setExecutionCoordinator(coordinator);

    expect(isCoordinatorAvailable()).toBe(true);
    expect(getExecutionCoordinator()).toBe(coordinator);
  });

  it('resetCoordinatorSingleton clears the instance', () => {
    const coordinator = createTestCoordinator();
    setExecutionCoordinator(coordinator);
    expect(isCoordinatorAvailable()).toBe(true);

    resetCoordinatorSingleton();
    expect(isCoordinatorAvailable()).toBe(false);
  });
});

describe('ExecutionCoordinator submit flow', () => {
  beforeEach(() => {
    resetCoordinatorSingleton();
  });

  it('submit calls executor.executeMessage and returns Execution with response', async () => {
    const mockExecuteMessage = async (
      sessionId: string,
      message: string,
      onChunk?: (chunk: string) => void,
    ) => {
      if (onChunk) onChunk('Hello');
      return {
        response: 'Hello from agent',
        action: { type: 'continue' },
      };
    };

    const coordinator = new ExecutionCoordinator({
      queue: new InMemoryExecutionQueue(),
      dedup: new ExecutionDedup(new InMemoryDedupStore()),
      executor: { executeMessage: mockExecuteMessage },
      sessionLoader: async (sessionId) => ({
        agentName: 'test-agent',
        agentIR: { execution: { concurrency: undefined } },
      }),
    });
    setExecutionCoordinator(coordinator);

    const chunks: string[] = [];
    const execution = await coordinator.submit('session-1', 'Hi', {
      tenantId: 'tenant-1',
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(execution.status).toBe('completed');
    expect(execution.response).toBe('Hello from agent');
    expect(chunks).toEqual(['Hello']);

    // resultData should contain the full ExecutionResult
    expect(execution.resultData).toBeDefined();
    expect((execution.resultData as Record<string, unknown>).response).toBe('Hello from agent');
    expect((execution.resultData as Record<string, unknown>).action).toEqual({ type: 'continue' });
  });

  it('submit returns failed execution for unknown session', async () => {
    const coordinator = new ExecutionCoordinator({
      queue: new InMemoryExecutionQueue(),
      dedup: new ExecutionDedup(new InMemoryDedupStore()),
      executor: {
        executeMessage: async () => ({ response: '', action: { type: 'continue' } }),
      },
      sessionLoader: async () => null, // session not found
    });
    setExecutionCoordinator(coordinator);

    const execution = await coordinator.submit('unknown-session', 'Hi', {
      tenantId: 'tenant-1',
    });

    expect(execution.status).toBe('failed');
    expect(execution.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('cancel returns false for non-existent executionId', async () => {
    const coordinator = createTestCoordinator();
    setExecutionCoordinator(coordinator);

    const cancelled = await coordinator.cancel('non-existent');
    expect(cancelled).toBe(false);
  });
});

function createTestCoordinator(): ExecutionCoordinator {
  return new ExecutionCoordinator({
    queue: new InMemoryExecutionQueue(),
    dedup: new ExecutionDedup(new InMemoryDedupStore()),
    executor: {
      executeMessage: async () => ({
        response: 'test response',
        action: { type: 'continue' },
      }),
    },
    sessionLoader: async () => ({
      agentName: 'test-agent',
      agentIR: { execution: {} },
    }),
  });
}
