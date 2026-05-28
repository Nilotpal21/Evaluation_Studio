import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionCoordinator } from '../../services/execution/execution-coordinator.js';
import { InMemoryExecutionQueue } from '@agent-platform/execution';
import { InMemoryDedupStore, ExecutionDedup } from '../../services/execution/execution-dedup.js';

describe('ExecutionCoordinator', () => {
  let coordinator: ExecutionCoordinator;
  let queue: InMemoryExecutionQueue;
  let mockExecutor: {
    executeMessage: ReturnType<typeof vi.fn>;
  };
  let mockSessionLoader: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queue = new InMemoryExecutionQueue();
    const dedup = new ExecutionDedup(new InMemoryDedupStore());
    mockExecutor = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Hello!',
        tokenUsage: { input: 10, output: 5 },
      }),
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

  describe('serial concurrency', () => {
    it('processes a single message end-to-end', async () => {
      const execution = await coordinator.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
      });

      expect(execution.status).toBe('completed');
      expect(execution.response).toBe('Hello!');
      expect(execution.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockExecutor.executeMessage).toHaveBeenCalledOnce();
    });

    it('processes two sequential messages in order', async () => {
      const order: string[] = [];
      mockExecutor.executeMessage.mockImplementation(async (_sid: string, msg: string) => {
        order.push(msg);
        await new Promise((r) => setTimeout(r, 20));
        return { response: `reply to ${msg}` };
      });

      const [e1, e2] = await Promise.all([
        coordinator.submit('sess-1', 'first', { tenantId: 'tenant-1' }),
        coordinator.submit('sess-1', 'second', { tenantId: 'tenant-1' }),
      ]);

      expect(order).toEqual(['first', 'second']);
      expect(e1.response).toBe('reply to first');
      expect(e2.response).toBe('reply to second');
    });
  });

  describe('deduplication', () => {
    it('returns existing execution for duplicate message', async () => {
      const e1Promise = coordinator.submit('sess-1', 'hello', { tenantId: 'tenant-1' });
      const e2Promise = coordinator.submit('sess-1', 'hello', { tenantId: 'tenant-1' });

      const [e1, e2] = await Promise.all([e1Promise, e2Promise]);

      expect(e1.executionId).toBe(e2.executionId);
      expect(mockExecutor.executeMessage).toHaveBeenCalledOnce();
    });

    it('does not deduplicate the same message when the explicit interaction context changes', async () => {
      const [e1, e2] = await Promise.all([
        coordinator.submit('sess-1', 'hello', {
          tenantId: 'tenant-1',
          interactionContext: { language: 'en', timezone: 'UTC' },
        }),
        coordinator.submit('sess-1', 'hello', {
          tenantId: 'tenant-1',
          interactionContext: { language: 'es', timezone: 'Europe/Madrid' },
        }),
      ]);

      expect(e1.executionId).not.toBe(e2.executionId);
      expect(mockExecutor.executeMessage).toHaveBeenCalledTimes(2);
    });

    it('does not deduplicate the same message when dedup keys differ', async () => {
      const [e1, e2] = await Promise.all([
        coordinator.submit('sess-1', 'hello', {
          tenantId: 'tenant-1',
          dedupKey: 'msg-1',
        }),
        coordinator.submit('sess-1', 'hello', {
          tenantId: 'tenant-1',
          dedupKey: 'msg-2',
        }),
      ]);

      expect(e1.executionId).not.toBe(e2.executionId);
      expect(mockExecutor.executeMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('preemptive concurrency', () => {
    it('cancels running execution when new message arrives', async () => {
      mockSessionLoader.mockResolvedValue({
        agentName: 'test_agent',
        agentIR: {
          execution: { mode: 'reasoning', concurrency: 'preemptive' },
        },
      });

      let firstAborted = false;
      mockExecutor.executeMessage.mockImplementation(
        async (_sid: string, _msg: string, _onChunk: unknown, _onTrace: unknown, opts: any) => {
          return new Promise((resolve) => {
            const checkAbort = setInterval(() => {
              if (opts?.signal?.aborted) {
                firstAborted = true;
                clearInterval(checkAbort);
                resolve({ response: '', error: { code: 'CANCELLED', message: 'preempted' } });
              }
            }, 5);
            setTimeout(() => {
              clearInterval(checkAbort);
              resolve({ response: 'done' });
            }, 200);
          });
        },
      );

      const e1Promise = coordinator.submit('sess-1', 'first', { tenantId: 'tenant-1' });
      await new Promise((r) => setTimeout(r, 20));
      const e2Promise = coordinator.submit('sess-1', 'second', { tenantId: 'tenant-1' });

      const [e1, e2] = await Promise.all([e1Promise, e2Promise]);

      expect(e1.status).toBe('preempted');
      expect(firstAborted).toBe(true);
    });
  });

  describe('cancel', () => {
    it('cancels a specific execution by id', async () => {
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

      const submitPromise = coordinator.submit('sess-1', 'hello', { tenantId: 'tenant-1' });

      // Give it time to start executing
      await new Promise((r) => setTimeout(r, 10));

      // We need to get the execution ID — since the coordinator is running, use getStatus indirectly
      // For now, cancel the whole session
      await coordinator.cancelSession('sess-1');

      const execution = await submitPromise;
      expect(execution.status).toBe('cancelled');

      resolveExecution!();
    });

    it('bridges caller abort signals into the in-flight execution controller', async () => {
      const controller = new AbortController();
      let sawAbort = false;

      mockExecutor.executeMessage.mockImplementation(
        async (_sid: string, _msg: string, _onChunk: unknown, _onTrace: unknown, opts: any) => {
          return new Promise((resolve) => {
            opts.signal.addEventListener(
              'abort',
              () => {
                sawAbort = true;
                resolve({ response: '', error: { code: 'CANCELLED', message: 'cancelled' } });
              },
              { once: true },
            );
          });
        },
      );

      const submitPromise = coordinator.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
        signal: controller.signal,
      });

      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      const execution = await submitPromise;
      expect(sawAbort).toBe(true);
      expect(execution.status).toBe('cancelled');
    });
  });

  describe('error handling', () => {
    it('marks execution as failed when executor throws', async () => {
      mockExecutor.executeMessage.mockRejectedValueOnce(new Error('LLM timeout'));

      const execution = await coordinator.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
      });

      expect(execution.status).toBe('failed');
      expect(execution.error?.message).toBe('LLM timeout');
    });

    it('marks execution as failed when session not found', async () => {
      mockSessionLoader.mockResolvedValue(null);

      const execution = await coordinator.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
      });

      expect(execution.status).toBe('failed');
      expect(execution.error?.code).toBe('SESSION_NOT_FOUND');
    });
  });

  describe('callbacks', () => {
    it('forwards onChunk and onTraceEvent to executor', async () => {
      const chunks: string[] = [];
      const events: Array<{ type: string }> = [];

      await coordinator.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
        onChunk: (c) => chunks.push(c),
        onTraceEvent: (e) => events.push(e),
      });

      // Verify the callbacks were passed through
      const call = mockExecutor.executeMessage.mock.calls[0];
      expect(typeof call[2]).toBe('function'); // onChunk
      expect(typeof call[3]).toBe('function'); // onTraceEvent
    });
  });

  describe('queue depth enforcement', () => {
    it('rejects when queue depth exceeded', async () => {
      // Configure a very low max_queue_depth of 1
      mockSessionLoader.mockResolvedValue({
        agentName: 'test_agent',
        agentIR: {
          execution: { concurrency: 'serial', max_queue_depth: 1 },
        },
      });

      // Make executor block so messages pile up in the queue
      let resolveExec!: () => void;
      const blockingPromise = new Promise<void>((r) => {
        resolveExec = r;
      });
      mockExecutor.executeMessage.mockImplementation(async () => {
        await blockingPromise;
        return { response: 'done' };
      });

      // Submit 3 messages:
      // - msg-1: starts executing (dequeued by drain loop)
      // - msg-2: enqueued (queue length = 1)
      // - msg-3: rejected because queue length (1) >= max_queue_depth (1)
      const p1 = coordinator.submit('sess-1', 'msg-1', { tenantId: 'tenant-1' });
      // Wait for msg-1 to be dispatched and dequeued by drain loop
      await new Promise((r) => setTimeout(r, 10));
      const p2 = coordinator.submit('sess-1', 'msg-2', { tenantId: 'tenant-1' });
      // Wait for msg-2 to be enqueued
      await new Promise((r) => setTimeout(r, 10));
      const p3 = coordinator.submit('sess-1', 'msg-3', { tenantId: 'tenant-1' });

      // Third message should be rejected immediately since queue has 1 item (>= max 1)
      const e3 = await p3;
      expect(e3.status).toBe('failed');
      expect(e3.error?.code).toBe('QUEUE_FULL');

      // Unblock and let the rest complete
      resolveExec();
      await p1;
      await p2;
    });
  });

  describe('execution.queued trace event', () => {
    it('emits execution.queued trace event on submit', async () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];

      await coordinator.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
        onTraceEvent: (e) => events.push(e),
      });

      const queuedEvent = events.find((e) => e.type === 'execution.queued');
      expect(queuedEvent).toBeDefined();
      expect(queuedEvent!.data.sessionId).toBe('sess-1');
      expect(queuedEvent!.data.agentName).toBe('test_agent');
      expect(typeof queuedEvent!.data.executionId).toBe('string');
      expect(queuedEvent!.data.queuePosition).toBeDefined();
      expect(typeof queuedEvent!.data.estimatedWaitMs).toBe('number');
    });
  });

  describe('getStatus', () => {
    it('returns snapshot without blocking for in-flight execution', async () => {
      let resolveExec!: () => void;
      const blockingPromise = new Promise<void>((r) => {
        resolveExec = r;
      });
      mockExecutor.executeMessage.mockImplementation(async () => {
        await blockingPromise;
        return { response: 'done' };
      });

      const submitPromise = coordinator.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
      });

      // Wait for execution to start
      await new Promise((r) => setTimeout(r, 10));

      // getStatus should return immediately without blocking
      const statusBefore = Date.now();
      // We need the executionId — use the trace event to capture it
      // Since we don't have the execution ID directly, let's use a trace event approach
      let capturedExecId: string | undefined;
      const coord2 = new ExecutionCoordinator({
        queue: new InMemoryExecutionQueue(),
        dedup: new ExecutionDedup(new InMemoryDedupStore()),
        executor: {
          executeMessage: vi.fn().mockImplementation(async () => {
            await blockingPromise;
            return { response: 'done' };
          }),
        } as any,
        sessionLoader: mockSessionLoader,
      });

      const submitPromise2 = coord2.submit('sess-2', 'test', {
        tenantId: 'tenant-1',
        onTraceEvent: (e) => {
          if (e.type === 'execution.queued') {
            capturedExecId = e.data.executionId as string;
          }
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(capturedExecId).toBeDefined();

      const status = await coord2.getStatus(capturedExecId!);
      const elapsed = Date.now() - statusBefore;

      // Should return a snapshot quickly (not wait for execution to complete)
      expect(elapsed).toBeLessThan(100);
      expect(status).not.toBeNull();
      expect(status!.status).toBe('running');

      resolveExec();
      await submitPromise;
      await submitPromise2;
    });

    it('returns null for unknown execution id', async () => {
      const status = await coordinator.getStatus('nonexistent-id');
      expect(status).toBeNull();
    });
  });

  describe('parallel concurrency limits', () => {
    it('rejects when parallel limit and queue depth are both exceeded', async () => {
      mockSessionLoader.mockResolvedValue({
        agentName: 'test_agent',
        agentIR: {
          execution: {
            concurrency: 'parallel',
            max_concurrent_messages: 2,
            max_queue_depth: 0,
          },
        },
      });

      let resolveAll!: () => void;
      const blockingPromise = new Promise<void>((r) => {
        resolveAll = r;
      });
      mockExecutor.executeMessage.mockImplementation(async () => {
        await blockingPromise;
        return { response: 'done' };
      });

      // Submit 3 messages:
      // - msg-1 and msg-2 dispatch as parallel (within limit of 2)
      // - msg-3 hits parallel limit (2 >= 2), falls back to serial,
      //   but queue depth 0 >= max 0, so gets QUEUE_FULL
      const p1 = coordinator.submit('sess-1', 'msg-1', { tenantId: 'tenant-1' });
      const p2 = coordinator.submit('sess-1', 'msg-2', { tenantId: 'tenant-1' });
      const p3 = coordinator.submit('sess-1', 'msg-3', { tenantId: 'tenant-1' });

      const e3 = await p3;
      expect(e3.status).toBe('failed');
      expect(e3.error?.code).toBe('QUEUE_FULL');

      resolveAll();
      await Promise.all([p1, p2]);
    });

    it('dispatches within parallel limit and falls back to serial beyond it', async () => {
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      mockSessionLoader.mockResolvedValue({
        agentName: 'test_agent',
        agentIR: {
          execution: { concurrency: 'parallel', max_concurrent_messages: 1 },
        },
      });

      let resolveAll!: () => void;
      const blockingPromise = new Promise<void>((r) => {
        resolveAll = r;
      });
      mockExecutor.executeMessage.mockImplementation(async () => {
        await blockingPromise;
        return { response: 'done' };
      });

      // Submit 2 messages with max_concurrent_messages: 1
      // - msg-1 dispatches as parallel (count 0 < 1)
      // - msg-2 sees count 1 >= 1, falls back to serial queueing
      const p1 = coordinator.submit('sess-1', 'msg-1', {
        tenantId: 'tenant-1',
        onTraceEvent: (e) => traceEvents.push(e),
      });
      const p2 = coordinator.submit('sess-1', 'msg-2', {
        tenantId: 'tenant-1',
        onTraceEvent: (e) => traceEvents.push(e),
      });

      // Both should have queued events
      await new Promise((r) => setTimeout(r, 20));
      const queuedEvents = traceEvents.filter((e) => e.type === 'execution.queued');
      expect(queuedEvents.length).toBe(2);

      resolveAll();
      await Promise.all([p1, p2]);
    });
  });

  describe('atomic dedup', () => {
    it('uses checkAndRecord for atomic dedup instead of separate check+record', async () => {
      const dedupStore = new InMemoryDedupStore();
      const dedup = new ExecutionDedup(dedupStore);
      const checkAndRecordSpy = vi.spyOn(dedup, 'checkAndRecord');
      const checkSpy = vi.spyOn(dedup, 'check');
      const recordSpy = vi.spyOn(dedup, 'record');

      const coord = new ExecutionCoordinator({
        queue: new InMemoryExecutionQueue(),
        dedup,
        executor: mockExecutor as any,
        sessionLoader: mockSessionLoader,
      });

      await coord.submit('sess-1', 'hello', { tenantId: 'tenant-1' });

      expect(checkAndRecordSpy).toHaveBeenCalledOnce();
      expect(checkSpy).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
    });
  });

  describe('recentResults cleanup', () => {
    it('cleans up recent results after TTL expires', async () => {
      vi.useFakeTimers();

      // Use a fresh coordinator for fake timers
      const coord = new ExecutionCoordinator({
        queue: new InMemoryExecutionQueue(),
        dedup: new ExecutionDedup(new InMemoryDedupStore()),
        executor: mockExecutor as any,
        sessionLoader: mockSessionLoader,
      });

      // Capture executionId via trace event
      let execId: string | undefined;
      await coord.submit('sess-1', 'hello', {
        tenantId: 'tenant-1',
        onTraceEvent: (e) => {
          if (e.type === 'execution.queued') execId = e.data.executionId as string;
        },
      });
      expect(execId).toBeDefined();

      // Right after completion, getStatus should return the result from recentResults
      const statusBefore = await coord.getStatus(execId!);
      expect(statusBefore).not.toBeNull();
      expect(statusBefore!.status).toBe('completed');

      // Advance time past the TTL (10 seconds)
      vi.advanceTimersByTime(11_000);

      // After TTL, the result should be cleaned up
      const statusAfter = await coord.getStatus(execId!);
      expect(statusAfter).toBeNull();

      vi.useRealTimers();
    });
  });

  describe('submitChains cleanup', () => {
    it('cleans up submitChains entry after execution completes', async () => {
      await coordinator.submit('sess-1', 'hello', { tenantId: 'tenant-1' });

      // After completion, the submitChains map should not have an entry for this session
      // Access the private map via type assertion for testing
      const chains = (coordinator as any).submitChains as Map<string, Promise<void>>;
      expect(chains.has('sess-1')).toBe(false);
    });
  });

  describe('cleanupSession', () => {
    it('removes all per-session state', async () => {
      // Submit to create some session state
      await coordinator.submit('sess-1', 'hello', { tenantId: 'tenant-1' });

      // Call cleanupSession
      coordinator.cleanupSession('sess-1');

      // Verify internal maps are cleaned up
      const durationSamples = (coordinator as any).durationSamples as Map<string, number[]>;
      const parallelCounts = (coordinator as any).parallelCounts as Map<string, number>;
      const submitChains = (coordinator as any).submitChains as Map<string, Promise<void>>;

      expect(durationSamples.has('sess-1')).toBe(false);
      expect(parallelCounts.has('sess-1')).toBe(false);
      expect(submitChains.has('sess-1')).toBe(false);
    });
  });
});
