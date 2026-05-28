/**
 * Regression tests for the suspendedDeferreds memory leak bug.
 *
 * Bug: When a client disconnects during a JIT auth suspension, the disconnect
 * handler calls cancelSession() but NOT cleanupSession(). cancelSession() does
 * NOT touch suspendedDeferreds, so the suspended entry leaks permanently.
 *
 * Additionally, suspendedDeferreds has no TTL or max-size eviction, so even
 * without the cancelSession() gap, long-lived entries are never cleaned up.
 *
 * All assertions test the CORRECT expected behavior. Tests FAIL until the
 * bug is fixed — they are regression tests, not documentation of buggy state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExecutionCoordinator } from '../services/execution/execution-coordinator.js';
import { InMemoryExecutionQueue } from '@agent-platform/execution';
import { InMemoryDedupStore, ExecutionDedup } from '../services/execution/execution-dedup.js';

describe('ExecutionCoordinator — suspendedDeferreds memory leak', () => {
  let coordinator: ExecutionCoordinator;
  let queue: InMemoryExecutionQueue;
  let mockExecutor: {
    executeMessage: ReturnType<typeof vi.fn>;
  };
  let mockSessionLoader: ReturnType<typeof vi.fn>;

  /**
   * Helper: access private suspendedDeferreds map for assertions.
   * Accessing private state is acceptable in a regression test proving a bug.
   */
  function getSuspendedDeferreds(): Map<string, unknown> {
    return (coordinator as any).suspendedDeferreds as Map<string, unknown>;
  }

  /** Helper: access private inflight map for assertions */
  function getInflight(): Map<string, unknown> {
    return (coordinator as any).inflight as Map<string, unknown>;
  }

  /**
   * Helper: wait for suspensions to register without flaky setTimeout.
   * Uses a bounded polling loop on microtasks.
   */
  async function waitForSuspensions(expectedSize: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (getSuspendedDeferreds().size < expectedSize) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for ${expectedSize} suspension(s) ` +
            `(current: ${getSuspendedDeferreds().size})`,
        );
      }
      // Yield to event loop to let async execution chain proceed
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  beforeEach(() => {
    queue = new InMemoryExecutionQueue();
    const dedup = new ExecutionDedup(new InMemoryDedupStore());

    // Default executor that returns a suspend action (simulating JIT auth challenge)
    mockExecutor = {
      executeMessage: vi.fn().mockResolvedValue({
        response: 'Authentication required. Please authorize.',
        action: {
          type: 'suspend',
          suspensionId: 'susp-jit-auth-001',
          reason: {
            type: 'human_approval',
            prompt: 'Please authorize access',
            callbackId: 'cb-001',
            timeout: 300_000,
          },
        },
      }),
    };

    mockSessionLoader = vi.fn().mockResolvedValue({
      agentName: 'test_agent',
      agentIR: {
        execution: { concurrency: 'serial' },
      },
    });

    coordinator = new ExecutionCoordinator({
      queue,
      dedup,
      executor: mockExecutor as any,
      sessionLoader: mockSessionLoader,
    });
  });

  afterEach(() => {
    // Ensure fake timers are always restored (TTL test uses vi.useFakeTimers)
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('cancelSession does not clean up suspendedDeferreds (the bug)', () => {
    it('should clean up suspendedDeferreds when cancelSession is called', async () => {
      // 1. Submit a message that will trigger a suspension (JIT auth challenge)
      const submitPromise = coordinator.submit('sess-leak-1', 'do something requiring auth', {
        tenantId: 'tenant-1',
      });

      // 2. Wait for the suspension to register (non-flaky)
      await waitForSuspensions(1);

      // 3. Verify the suspension was registered
      expect(getSuspendedDeferreds().size).toBe(1);
      expect(getSuspendedDeferreds().has('susp-jit-auth-001')).toBe(true);
      expect(getInflight().size).toBe(1);

      // 4. Simulate client disconnect by calling cancelSession()
      await coordinator.cancelSession('sess-leak-1');

      // 5. CORRECT behavior: cancelSession() should clean up suspendedDeferreds.
      //    BUG: This FAILS because cancelSession() doesn't touch suspendedDeferreds.
      expect(getSuspendedDeferreds().size).toBe(0);
      expect(getInflight().size).toBe(0);

      // Cleanup: use cleanupSession (which DOES work) to prevent test hanging
      coordinator.cleanupSession('sess-leak-1');
      await submitPromise.catch((err: unknown) => {
        // Expected: cleanupSession rejects the deferred as cancelled
        expect(err).toBeDefined();
      });
    });

    it('should resolve the suspended deferred as cancelled when cancelSession is called', async () => {
      const submitPromise = coordinator.submit('sess-leak-2', 'auth-required action', {
        tenantId: 'tenant-1',
      });

      await waitForSuspensions(1);
      expect(getSuspendedDeferreds().size).toBe(1);

      // Simulate client disconnect
      await coordinator.cancelSession('sess-leak-2');

      // CORRECT behavior: After cancel, suspended entries should be cleaned up.
      // BUG: This FAILS — cancelSession doesn't touch suspendedDeferreds.
      expect(getSuspendedDeferreds().size).toBe(0);

      // Cleanup to prevent hanging
      coordinator.cleanupSession('sess-leak-2');
      const execution = await submitPromise;
      expect(execution.status).toBe('cancelled');
    });
  });

  describe('multiple suspended sessions leak independently', () => {
    it('should not accumulate leaked entries across multiple session cancellations', async () => {
      const suspensionIds = ['susp-multi-001', 'susp-multi-002', 'susp-multi-003'];
      const promises: Promise<any>[] = [];

      for (let i = 0; i < 3; i++) {
        mockExecutor.executeMessage.mockResolvedValueOnce({
          response: 'Auth required',
          action: {
            type: 'suspend',
            suspensionId: suspensionIds[i],
            reason: {
              type: 'human_approval',
              prompt: 'Authorize',
              callbackId: `cb-${i}`,
              timeout: 300_000,
            },
          },
        });

        promises.push(
          coordinator.submit(`sess-multi-${i}`, `message-${i}`, {
            tenantId: 'tenant-1',
          }),
        );
      }

      await waitForSuspensions(3);
      expect(getSuspendedDeferreds().size).toBe(3);

      // Cancel all 3 sessions
      for (let i = 0; i < 3; i++) {
        await coordinator.cancelSession(`sess-multi-${i}`);
      }

      // CORRECT behavior: All entries should be cleaned up.
      // BUG: This FAILS — all 3 entries leak.
      expect(getSuspendedDeferreds().size).toBe(0);

      // Cleanup
      for (let i = 0; i < 3; i++) {
        coordinator.cleanupSession(`sess-multi-${i}`);
      }
      await Promise.allSettled(promises);
    });
  });

  describe('no TTL on suspendedDeferreds (missing eviction)', () => {
    it('should evict stale suspended entries after a reasonable TTL', async () => {
      vi.useFakeTimers();

      const freshCoordinator = new ExecutionCoordinator({
        queue: new InMemoryExecutionQueue(),
        dedup: new ExecutionDedup(new InMemoryDedupStore()),
        executor: mockExecutor as any,
        sessionLoader: mockSessionLoader,
      });

      const suspendedMap = (freshCoordinator as any).suspendedDeferreds as Map<string, unknown>;

      const submitPromise = freshCoordinator.submit('sess-ttl-1', 'trigger auth', {
        tenantId: 'tenant-1',
      });

      // Flush async execution via fake timers
      await vi.advanceTimersByTimeAsync(100);
      expect(suspendedMap.size).toBe(1);

      // Advance time well past any reasonable TTL (10 minutes)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      // CORRECT behavior: Stale entries should be evicted by a TTL mechanism.
      // BUG: This FAILS because no TTL or eviction exists.
      expect(suspendedMap.size).toBe(0);

      // Cleanup
      freshCoordinator.cleanupSession('sess-ttl-1');
      await vi.advanceTimersByTimeAsync(100);
      await submitPromise.catch((err: unknown) => {
        expect(err).toBeDefined();
      });

      vi.useRealTimers();
    });
  });

  describe('cleanupSession correctly handles suspendedDeferreds (contrast)', () => {
    it('cleanupSession DOES clean up suspendedDeferreds — proving the gap in cancelSession', async () => {
      // This test PASSES — it proves cleanupSession handles the case correctly.
      // The bug is that cancelSession (called on disconnect) does NOT.
      const submitPromise = coordinator.submit('sess-cleanup-1', 'trigger auth', {
        tenantId: 'tenant-1',
      });

      await waitForSuspensions(1);
      expect(getSuspendedDeferreds().size).toBe(1);
      expect(getInflight().size).toBe(1);

      // Call cleanupSession (the correct handler, NOT called on disconnect)
      coordinator.cleanupSession('sess-cleanup-1');

      // cleanupSession DOES iterate suspendedDeferreds and clean them up
      expect(getSuspendedDeferreds().size).toBe(0);
      expect(getInflight().size).toBe(0);

      const execution = await submitPromise;
      expect(execution.status).toBe('cancelled');
    });
  });
});
