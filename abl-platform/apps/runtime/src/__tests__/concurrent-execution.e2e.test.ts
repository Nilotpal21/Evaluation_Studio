import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionCoordinator } from '../services/execution/execution-coordinator.js';
import { InMemoryExecutionQueue } from '@agent-platform/execution';
import { ExecutionDedup, InMemoryDedupStore } from '../services/execution/execution-dedup.js';

describe('Concurrent Execution E2E', () => {
  function createCoordinator(
    concurrency: string = 'serial',
    executorImpl?: (
      sessionId: string,
      msg: string,
      onChunk?: (chunk: string) => void,
      onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      opts?: { attachmentIds?: string[]; signal?: AbortSignal },
    ) => Promise<{ response: string; tokenUsage?: { input: number; output: number } }>,
  ) {
    const queue = new InMemoryExecutionQueue();
    const dedup = new ExecutionDedup(new InMemoryDedupStore());
    const mockExecutor = {
      executeMessage: vi.fn().mockImplementation(
        executorImpl ??
          (async (_sid: string, msg: string) => ({
            response: `reply to ${msg}`,
            tokenUsage: { input: 10, output: 5 },
          })),
      ),
    };
    const mockSessionLoader = vi.fn().mockResolvedValue({
      agentName: 'test_agent',
      agentIR: { execution: { mode: 'reasoning', concurrency } },
    });
    const coordinator = new ExecutionCoordinator({
      queue,
      dedup,
      executor: mockExecutor as any,
      sessionLoader: mockSessionLoader,
    });
    return { coordinator, mockExecutor, queue };
  }

  describe('serial mode — 5 concurrent messages', () => {
    it('processes all 5 in FIFO order without corruption', async () => {
      const executionOrder: string[] = [];
      const { coordinator } = createCoordinator('serial', async (_sid: string, msg: string) => {
        executionOrder.push(msg);
        await new Promise((r) => setTimeout(r, 10));
        return { response: `reply to ${msg}` };
      });

      const promises = Array.from({ length: 5 }, (_, i) =>
        coordinator.submit('sess-1', `msg-${i}`, { tenantId: 'tenant-1' }),
      );

      const results = await Promise.all(promises);

      // All complete
      expect(results.every((r) => r.status === 'completed')).toBe(true);
      // FIFO order
      expect(executionOrder).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
      // Each has unique executionId
      const ids = new Set(results.map((r) => r.executionId));
      expect(ids.size).toBe(5);
      // Each has correct response
      results.forEach((r, i) => expect(r.response).toBe(`reply to msg-${i}`));
    });
  });

  describe('preemptive mode — rapid fire', () => {
    it('new message preempts the currently running one', async () => {
      const { coordinator } = createCoordinator(
        'preemptive',
        async (
          _sid: string,
          msg: string,
          _onChunk?: unknown,
          _onTrace?: unknown,
          opts?: { signal?: AbortSignal },
        ) => {
          return new Promise((resolve) => {
            const check = setInterval(() => {
              if (opts?.signal?.aborted) {
                clearInterval(check);
                resolve({ response: '' });
              }
            }, 5);
            setTimeout(() => {
              clearInterval(check);
              resolve({ response: `reply to ${msg}` });
            }, 500);
          });
        },
      );

      // Submit first, wait for it to start and become active
      const e1Promise = coordinator.submit('sess-1', 'first', { tenantId: 't1' });
      await new Promise((r) => setTimeout(r, 50));

      // Submit second — should preempt first
      const e2Promise = coordinator.submit('sess-1', 'second', { tenantId: 't1' });

      const [e1, e2] = await Promise.all([e1Promise, e2Promise]);

      // First should be preempted, second should complete
      expect(e1.status).toBe('preempted');
      expect(e2.status).toBe('completed');
      expect(e2.response).toBe('reply to second');
    });

    it('triple rapid fire — first preempted, last completes', async () => {
      const statuses: string[] = [];
      const { coordinator } = createCoordinator(
        'preemptive',
        async (
          _sid: string,
          msg: string,
          _onChunk?: unknown,
          _onTrace?: unknown,
          opts?: { signal?: AbortSignal },
        ) => {
          return new Promise((resolve) => {
            const check = setInterval(() => {
              if (opts?.signal?.aborted) {
                clearInterval(check);
                resolve({ response: '' });
              }
            }, 5);
            setTimeout(() => {
              clearInterval(check);
              resolve({ response: `reply to ${msg}` });
            }, 500);
          });
        },
      );

      // Submit three messages with enough spacing for each to become active
      const e1Promise = coordinator.submit('sess-1', 'first', { tenantId: 't1' });
      await new Promise((r) => setTimeout(r, 50));
      const e2Promise = coordinator.submit('sess-1', 'second', { tenantId: 't1' });
      await new Promise((r) => setTimeout(r, 50));
      const e3Promise = coordinator.submit('sess-1', 'third', { tenantId: 't1' });

      const [e1, e2, e3] = await Promise.all([e1Promise, e2Promise, e3Promise]);

      statuses.push(e1.status, e2.status, e3.status);

      // First is always preempted (second message arrives while first is active)
      expect(e1.status).toBe('preempted');
      // Last always completes (nothing arrives after it)
      expect(e3.status).toBe('completed');
      expect(e3.response).toBe('reply to third');
      // Middle may be preempted or completed depending on timing of clearActive race.
      // The critical invariant is: first preempted, last completed.
      expect(['preempted', 'completed']).toContain(e2.status);
    });
  });

  describe('parallel mode — 3 concurrent on isolated threads', () => {
    it('all 3 execute concurrently and complete', async () => {
      const startTimes: number[] = [];
      const { coordinator } = createCoordinator('parallel', async (_sid: string, msg: string) => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 30));
        return { response: `reply to ${msg}` };
      });

      const promises = [
        coordinator.submit('sess-1', 'a', { tenantId: 't1' }),
        coordinator.submit('sess-1', 'b', { tenantId: 't1' }),
        coordinator.submit('sess-1', 'c', { tenantId: 't1' }),
      ];

      const results = await Promise.all(promises);

      // All complete
      expect(results.every((r) => r.status === 'completed')).toBe(true);
      // All started roughly at the same time (within 50ms of each other)
      expect(Math.max(...startTimes) - Math.min(...startTimes)).toBeLessThan(50);
    });
  });

  describe('dedup — double click protection', () => {
    it('identical messages within 5s window process only once', async () => {
      const { coordinator, mockExecutor } = createCoordinator('serial');

      const [e1, e2] = await Promise.all([
        coordinator.submit('sess-1', 'hello', { tenantId: 't1' }),
        coordinator.submit('sess-1', 'hello', { tenantId: 't1' }),
      ]);

      expect(e1.executionId).toBe(e2.executionId);
      expect(mockExecutor.executeMessage).toHaveBeenCalledOnce();
    });
  });

  describe('cross-session isolation', () => {
    it('concurrent messages to different sessions do not interfere', async () => {
      const sessionOrder: string[] = [];
      const { coordinator } = createCoordinator('serial', async (sid: string, msg: string) => {
        sessionOrder.push(`${sid}:${msg}`);
        await new Promise((r) => setTimeout(r, 10));
        return { response: `reply from ${sid}` };
      });

      const [r1, r2] = await Promise.all([
        coordinator.submit('sess-1', 'hello', { tenantId: 't1' }),
        coordinator.submit('sess-2', 'world', { tenantId: 't1' }),
      ]);

      expect(r1.status).toBe('completed');
      expect(r2.status).toBe('completed');
      expect(r1.response).toBe('reply from sess-1');
      expect(r2.response).toBe('reply from sess-2');
      // Both should have run (serial is per-session, not global)
      expect(sessionOrder).toContain('sess-1:hello');
      expect(sessionOrder).toContain('sess-2:world');
    });
  });

  describe('error handling under concurrency', () => {
    it('one failing message does not block subsequent serial messages', async () => {
      let callCount = 0;
      const { coordinator } = createCoordinator('serial', async (_sid: string, msg: string) => {
        callCount++;
        if (msg === 'msg-1') {
          throw new Error('LLM timeout');
        }
        await new Promise((r) => setTimeout(r, 5));
        return { response: `reply to ${msg}` };
      });

      const promises = [
        coordinator.submit('sess-1', 'msg-0', { tenantId: 't1' }),
        coordinator.submit('sess-1', 'msg-1', { tenantId: 't1' }),
        coordinator.submit('sess-1', 'msg-2', { tenantId: 't1' }),
      ];

      const [r0, r1, r2] = await Promise.all(promises);

      expect(r0.status).toBe('completed');
      expect(r0.response).toBe('reply to msg-0');
      expect(r1.status).toBe('failed');
      expect(r1.error?.message).toBe('LLM timeout');
      expect(r2.status).toBe('completed');
      expect(r2.response).toBe('reply to msg-2');
      expect(callCount).toBe(3);
    });
  });

  describe('execution metadata', () => {
    it('completed executions have timing and token usage', async () => {
      const { coordinator } = createCoordinator('serial', async (_sid: string, msg: string) => {
        await new Promise((r) => setTimeout(r, 5));
        return { response: `reply to ${msg}`, tokenUsage: { input: 100, output: 50 } };
      });

      const result = await coordinator.submit('sess-1', 'hello', { tenantId: 't1' });

      expect(result.status).toBe('completed');
      expect(result.executionId).toBeDefined();
      expect(result.sessionId).toBe('sess-1');
      expect(result.tenantId).toBe('t1');
      expect(result.message).toBe('hello');
      expect(result.agentName).toBe('test_agent');
      expect(result.queuedAt).toBeGreaterThan(0);
      expect(result.startedAt).toBeGreaterThan(0);
      expect(result.completedAt).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
    });
  });
});
