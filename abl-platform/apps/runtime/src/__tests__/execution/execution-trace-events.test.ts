import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionCoordinator } from '../../services/execution/execution-coordinator.js';
import { InMemoryExecutionQueue } from '@agent-platform/execution';
import { ExecutionDedup, InMemoryDedupStore } from '../../services/execution/execution-dedup.js';

describe('Execution trace events', () => {
  let coordinator: ExecutionCoordinator;
  let mockExecutor: { executeMessage: ReturnType<typeof vi.fn> };
  let mockSessionLoader: ReturnType<typeof vi.fn>;
  let traceEvents: Array<{ type: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    traceEvents = [];
    const queue = new InMemoryExecutionQueue();
    const dedup = new ExecutionDedup(new InMemoryDedupStore());
    mockExecutor = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Hello!',
        tokenUsage: { input: 10, output: 5 },
      }),
    };
    mockSessionLoader = vi.fn().mockResolvedValue({
      agentName: 'test_agent',
      agentIR: { execution: { mode: 'reasoning', concurrency: 'serial' } },
    });
    coordinator = new ExecutionCoordinator({
      queue,
      dedup,
      executor: mockExecutor as any,
      sessionLoader: mockSessionLoader,
    });
  });

  it('emits execution.started when execution begins', async () => {
    await coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });

    const started = traceEvents.find((e) => e.type === 'execution.started');
    expect(started).toBeDefined();
    expect(started!.data.sessionId).toBe('sess-1');
    expect(started!.data.agentName).toBe('test_agent');
    expect(started!.data.tenantId).toBe('tenant-1');
    expect(started!.data.executionId).toMatch(/^exec-/);
  });

  it('emits execution.completed on success', async () => {
    await coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });

    const completed = traceEvents.find((e) => e.type === 'execution.completed');
    expect(completed).toBeDefined();
    expect(completed!.data.status).toBe('completed');
    expect(completed!.data.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed!.data.tokenUsage).toEqual({ input: 10, output: 5 });
    expect(completed!.data.sessionId).toBe('sess-1');
    expect(completed!.data.agentName).toBe('test_agent');
    expect(completed!.data.executionId).toMatch(/^exec-/);
  });

  it('emits execution.failed on error', async () => {
    mockExecutor.executeMessage.mockRejectedValueOnce(new Error('LLM timeout'));

    await coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });

    const failed = traceEvents.find((e) => e.type === 'execution.failed');
    expect(failed).toBeDefined();
    expect(failed!.data.error).toEqual({ code: 'EXECUTION_FAILED', message: 'LLM timeout' });
    expect(failed!.data.sessionId).toBe('sess-1');
    expect(failed!.data.executionId).toMatch(/^exec-/);
  });

  it('emits execution.cancelled on preemption', async () => {
    mockSessionLoader.mockResolvedValue({
      agentName: 'test_agent',
      agentIR: { execution: { mode: 'reasoning', concurrency: 'preemptive' } },
    });
    mockExecutor.executeMessage.mockImplementation(
      async (_sid: string, _msg: string, _onChunk: unknown, _onTrace: unknown, opts: any) => {
        return new Promise((resolve) => {
          const check = setInterval(() => {
            if (opts?.signal?.aborted) {
              clearInterval(check);
              resolve({ response: '' });
            }
          }, 5);
          setTimeout(() => {
            clearInterval(check);
            resolve({ response: 'done' });
          }, 200);
        });
      },
    );

    const e1Promise = coordinator.submit('sess-1', 'first', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });
    await new Promise((r) => setTimeout(r, 20));
    const e2Promise = coordinator.submit('sess-1', 'second', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });

    await Promise.all([e1Promise, e2Promise]);

    const cancelled = traceEvents.find((e) => e.type === 'execution.cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.data.reason).toBe('preempted');
    expect(cancelled!.data.sessionId).toBe('sess-1');
    expect(cancelled!.data.executionId).toMatch(/^exec-/);
  });

  it('emits execution.cancelled with reason "cancelled" on explicit cancel', async () => {
    let resolveExecution: () => void;
    const blockingPromise = new Promise<void>((r) => {
      resolveExecution = r;
    });

    mockExecutor.executeMessage.mockImplementation(
      async (_sid: string, _msg: string, _onChunk: unknown, _onTrace: unknown, opts: any) => {
        await Promise.race([
          blockingPromise,
          new Promise<void>((resolve) => {
            if (opts?.signal) {
              opts.signal.addEventListener('abort', () => resolve());
            }
          }),
        ]);
        if (opts?.signal?.aborted) {
          return { response: '', error: { code: 'CANCELLED', message: 'cancelled' } };
        }
        return { response: 'done' };
      },
    );

    const submitPromise = coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });

    await new Promise((r) => setTimeout(r, 10));
    await coordinator.cancelSession('sess-1');

    const execution = await submitPromise;
    expect(execution.status).toBe('cancelled');

    const cancelledEvent = traceEvents.find((e) => e.type === 'execution.cancelled');
    expect(cancelledEvent).toBeDefined();
    expect(cancelledEvent!.data.reason).toBe('cancelled');

    resolveExecution!();
  });

  it('emits both started and completed for a successful execution', async () => {
    await coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });

    const types = traceEvents.map((e) => e.type);
    expect(types).toContain('execution.started');
    expect(types).toContain('execution.completed');

    // started should come before completed
    const startedIdx = types.indexOf('execution.started');
    const completedIdx = types.indexOf('execution.completed');
    expect(startedIdx).toBeLessThan(completedIdx);
  });

  it('emits both started and failed for a failed execution', async () => {
    mockExecutor.executeMessage.mockRejectedValueOnce(new Error('boom'));

    await coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-1',
      onTraceEvent: (e) => traceEvents.push(e),
    });

    const types = traceEvents.map((e) => e.type);
    expect(types).toContain('execution.started');
    expect(types).toContain('execution.failed');

    const startedIdx = types.indexOf('execution.started');
    const failedIdx = types.indexOf('execution.failed');
    expect(startedIdx).toBeLessThan(failedIdx);
  });

  it('does not emit trace events when onTraceEvent is not provided', async () => {
    // Should not throw even without the callback
    const execution = await coordinator.submit('sess-1', 'hello', {
      tenantId: 'tenant-1',
    });

    expect(execution.status).toBe('completed');
  });
});
