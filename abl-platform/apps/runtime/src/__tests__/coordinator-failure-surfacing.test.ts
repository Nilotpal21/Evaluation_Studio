/**
 * Coordinator Failure Surfacing Tests
 *
 * Validates that execution failures from the coordinator are properly
 * surfaced to clients instead of silently returning empty responses.
 *
 * The ExecutionCoordinator resolves (not rejects) its deferred on failure,
 * so handlers must explicitly check execution.status === 'failed'.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ExecutionCoordinator } from '../services/execution/execution-coordinator.js';
import { InMemoryExecutionQueue } from '@agent-platform/execution';
import { InMemoryDedupStore, ExecutionDedup } from '../services/execution/execution-dedup.js';

describe('Coordinator failure surfacing', () => {
  let coordinator: ExecutionCoordinator;
  let mockExecutor: { executeMessage: ReturnType<typeof vi.fn> };
  let mockSessionLoader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const queue = new InMemoryExecutionQueue();
    const dedup = new ExecutionDedup(new InMemoryDedupStore());
    mockExecutor = {
      executeMessage: vi.fn(),
    };
    mockSessionLoader = vi.fn().mockResolvedValue({
      agentName: 'test_agent',
      agentIR: {
        execution: { mode: 'reasoning', concurrency: 'serial' },
      },
    });
    coordinator = new ExecutionCoordinator({
      queue,
      dedup,
      executor: mockExecutor as any,
      sessionLoader: mockSessionLoader,
    });
  });

  test('executor throw results in failed status with error details (not a rejected promise)', async () => {
    // This simulates what happens when LLM client is not configured —
    // the coordinator catches the error and resolves (not rejects) with status: 'failed'
    mockExecutor.executeMessage.mockRejectedValueOnce(
      new Error('Session LLM client not configured'),
    );

    const execution = await coordinator.submit('sess-1', 'find hotels in paris', {
      tenantId: 'tenant-1',
    });

    // The promise resolves (not rejects) — this is the root cause of silent failures
    expect(execution.status).toBe('failed');
    expect(execution.error).toBeDefined();
    expect(execution.error?.message).toBe('Session LLM client not configured');
    expect(execution.error?.code).toBe('EXECUTION_FAILED');

    // resultData is undefined on failure — handlers must check status before using it
    expect(execution.resultData).toBeUndefined();
    // response is also undefined on failure
    expect(execution.response).toBeUndefined();
  });

  test('handlers can distinguish QUEUE_FULL from other failures', async () => {
    // Simulate queue-full by overloading
    mockSessionLoader.mockResolvedValue({
      agentName: 'test_agent',
      agentIR: {
        execution: { mode: 'reasoning', concurrency: 'serial', max_queue_depth: 1 },
      },
    });

    // Block the first execution
    let resolveFirst: () => void;
    const blockingPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });
    mockExecutor.executeMessage.mockImplementationOnce(async () => {
      await blockingPromise;
      return { response: 'done' };
    });

    // Submit first (starts executing, blocks)
    const e1Promise = coordinator.submit('sess-1', 'first', { tenantId: 'tenant-1' });
    await new Promise((r) => setTimeout(r, 10));

    // Submit second (goes into queue, queue depth = 1 so this is fine)
    const e2Promise = coordinator.submit('sess-1', 'second', { tenantId: 'tenant-1' });
    await new Promise((r) => setTimeout(r, 10));

    // Submit third — exceeds max_queue_depth
    const e3 = await coordinator.submit('sess-1', 'third', { tenantId: 'tenant-1' });

    expect(e3.status).toBe('failed');
    expect(e3.error?.code).toBe('QUEUE_FULL');

    // Clean up
    resolveFirst!();
    await Promise.all([e1Promise, e2Promise]);
  });

  test('failed execution error message contains actionable info for credential failures', async () => {
    // Simulate the actual error chain: model resolution → no credential → AppError
    const credError = new Error(
      "No credential found for provider 'openai' in tenant 'tenant-abc'. " +
        'Configure a TenantModel with a connection or add an LLMCredential. ' +
        '[Debug: policy=user_only, db=true, enc=true; tenant_cred(tenant-abc,openai)=null; tm_by_provider(tenant-abc,openai)=not_found]',
    );

    mockExecutor.executeMessage.mockRejectedValueOnce(credError);

    const execution = await coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-abc',
    });

    expect(execution.status).toBe('failed');
    // The error message should contain the diagnostic info — this is what our fix now surfaces
    expect(execution.error?.message).toContain('No credential found');
    expect(execution.error?.message).toContain('tm_by_provider');
  });

  test('successful execution has resultData and response set', async () => {
    mockExecutor.executeMessage.mockResolvedValueOnce({
      response: 'Here are hotels in Paris',
      tokenUsage: { input: 100, output: 50 },
    });

    const execution = await coordinator.submit('sess-1', 'find hotels', {
      tenantId: 'tenant-1',
    });

    expect(execution.status).toBe('completed');
    expect(execution.response).toBe('Here are hotels in Paris');
    expect(execution.resultData).toBeDefined();
    expect(execution.error).toBeUndefined();
  });
});
