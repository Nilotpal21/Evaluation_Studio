/**
 * Unit tests for SyncExecutionService.
 *
 * Mocks: Redis subscriber (EventEmitter-based), WorkflowExecution model (vi.mock).
 * Tests: completion, timeout, failure, cancellation, client disconnect,
 *        event filtering, concurrency limit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { SyncExecutionService } from '../services/sync-execution.js';

// ─── Mock: @agent-platform/database/models ─────────────────────────
const mockFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  WorkflowExecution: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockFindOne(...args),
    }),
  },
}));

// ─── Mock Redis Subscriber ─────────────────────────────────────────
function createMockSubscriber() {
  const emitter = new EventEmitter();
  return {
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    /** Simulate a Redis Pub/Sub message on a channel. */
    simulateMessage(channel: string, data: Record<string, unknown>) {
      emitter.emit('message', channel, JSON.stringify(data));
    },
    _emitter: emitter,
  };
}

// ─── Test Suite ────────────────────────────────────────────────────
describe('SyncExecutionService', () => {
  const tenantId = 'tenant-abc';
  const executionId = 'exec-123';
  const channel = `workflow:${tenantId}:execution:${executionId}:status`;

  let subscriber: ReturnType<typeof createMockSubscriber>;
  let service: SyncExecutionService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    subscriber = createMockSubscriber();
    service = new SyncExecutionService({ redisSubscriber: subscriber });
  });

  // ── 1. Successful completion ──────────────────────────────────────
  it('returns completed result when workflow.completed event is received', async () => {
    const expectedOutput = { answer: 42 };

    mockFindOne.mockResolvedValue({
      _id: executionId,
      tenantId,
      status: 'completed',
      output: expectedOutput,
    });

    const promise = service.waitForCompletion(tenantId, executionId, 30_000);

    // Allow the subscribe call to resolve
    await vi.advanceTimersByTimeAsync(0);

    subscriber.simulateMessage(channel, { type: 'workflow.completed' });

    const result = await promise;

    expect(result).toEqual({
      status: 'completed',
      result: expectedOutput,
    });
    expect(subscriber.subscribe).toHaveBeenCalledWith(channel);
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(channel);
    expect(mockFindOne).toHaveBeenCalledWith({ _id: executionId, tenantId });
    expect(service.activeCount).toBe(0);
  });

  // ── 2. Timeout → async promotion ─────────────────────────────────
  it('returns timeout when no event is received within timeoutMs', async () => {
    const promise = service.waitForCompletion(tenantId, executionId, 5_000);

    // Let subscribe resolve, then advance past timeout
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await promise;

    expect(result).toEqual({ status: 'timeout' });
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(channel);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(service.activeCount).toBe(0);
  });

  // ── 3. Workflow failure ───────────────────────────────────────────
  it('returns failed result when workflow.failed event is received', async () => {
    const errorPayload = { code: 'STEP_ERROR', message: 'Step X crashed' };

    mockFindOne.mockResolvedValue({
      _id: executionId,
      tenantId,
      status: 'failed',
      error: errorPayload,
    });

    const promise = service.waitForCompletion(tenantId, executionId, 30_000);
    await vi.advanceTimersByTimeAsync(0);

    subscriber.simulateMessage(channel, { type: 'workflow.failed' });

    const result = await promise;

    expect(result).toEqual({
      status: 'failed',
      error: errorPayload,
    });
    expect(service.activeCount).toBe(0);
  });

  // ── 4. Client disconnect cleanup ─────────────────────────────────
  it('returns timeout and cleans up when abort signal fires', async () => {
    const controller = new AbortController();

    const promise = service.waitForCompletion(tenantId, executionId, 30_000, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    // Simulate client disconnect
    controller.abort();

    const result = await promise;

    expect(result).toEqual({ status: 'timeout' });
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(channel);
    expect(service.activeCount).toBe(0);
  });

  // ── 5. Event filtering — step-level events are ignored ────────────
  it('ignores non-terminal events like step.completed', async () => {
    mockFindOne.mockResolvedValue({
      _id: executionId,
      tenantId,
      status: 'completed',
      output: { done: true },
    });

    const promise = service.waitForCompletion(tenantId, executionId, 5_000);
    await vi.advanceTimersByTimeAsync(0);

    // Send non-terminal events — these should be ignored
    subscriber.simulateMessage(channel, {
      type: 'step.completed',
      stepId: 'step-1',
    });
    subscriber.simulateMessage(channel, {
      type: 'step.started',
      stepId: 'step-2',
    });
    subscriber.simulateMessage(channel, {
      type: 'workflow.progress',
      progress: 50,
    });

    // MongoDB should not be called yet — only terminal events trigger fetch
    expect(mockFindOne).not.toHaveBeenCalled();

    // Now send terminal event
    subscriber.simulateMessage(channel, { type: 'workflow.completed' });

    const result = await promise;

    expect(result).toEqual({
      status: 'completed',
      result: { done: true },
    });
    // findOne called exactly once — on terminal event
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  // ── 6. Concurrency limit ─────────────────────────────────────────
  it('throws SYNC_LIMIT_EXCEEDED when concurrency limit is reached', async () => {
    const smallService = new SyncExecutionService({ redisSubscriber: subscriber }, 2);

    // Start 2 subscriptions (they won't resolve — no terminal events)
    smallService.waitForCompletion(tenantId, 'exec-1', 60_000);
    await vi.advanceTimersByTimeAsync(0);
    smallService.waitForCompletion(tenantId, 'exec-2', 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(smallService.activeCount).toBe(2);

    // Third should throw
    await expect(smallService.waitForCompletion(tenantId, 'exec-3', 60_000)).rejects.toThrow(
      'SYNC_LIMIT_EXCEEDED',
    );
  });

  // ── 7. Workflow cancelled ─────────────────────────────────────────
  it('returns cancelled result when workflow.cancelled event is received', async () => {
    mockFindOne.mockResolvedValue({
      _id: executionId,
      tenantId,
      status: 'cancelled',
    });

    const promise = service.waitForCompletion(tenantId, executionId, 30_000);
    await vi.advanceTimersByTimeAsync(0);

    subscriber.simulateMessage(channel, { type: 'workflow.cancelled' });

    const result = await promise;

    expect(result).toEqual({
      status: 'cancelled',
      error: {
        code: 'EXECUTION_CANCELLED',
        message: 'Workflow was cancelled',
      },
    });
    expect(service.activeCount).toBe(0);
  });

  // ── 8. Execution not found in MongoDB ─────────────────────────────
  it('returns failed with EXECUTION_NOT_FOUND when MongoDB record is missing', async () => {
    mockFindOne.mockResolvedValue(null);

    const promise = service.waitForCompletion(tenantId, executionId, 30_000);
    await vi.advanceTimersByTimeAsync(0);

    subscriber.simulateMessage(channel, { type: 'workflow.completed' });

    const result = await promise;

    expect(result).toEqual({
      status: 'failed',
      error: {
        code: 'EXECUTION_NOT_FOUND',
        message: 'Execution record not found',
      },
    });
  });

  // ── 9. Messages on wrong channel are ignored ──────────────────────
  it('ignores messages on a different channel', async () => {
    mockFindOne.mockResolvedValue({
      _id: executionId,
      tenantId,
      status: 'completed',
      output: { value: 1 },
    });

    const promise = service.waitForCompletion(tenantId, executionId, 5_000);
    await vi.advanceTimersByTimeAsync(0);

    // Message on a different execution's channel
    const wrongChannel = `workflow:${tenantId}:execution:other-exec:status`;
    subscriber.simulateMessage(wrongChannel, { type: 'workflow.completed' });

    expect(mockFindOne).not.toHaveBeenCalled();

    // Timeout should fire
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await promise;
    expect(result).toEqual({ status: 'timeout' });
  });

  // ── 10. Shutdown ──────────────────────────────────────────────────
  it('shutdown calls unsubscribe and quit on the subscriber', async () => {
    await service.shutdown();

    expect(subscriber.unsubscribe).toHaveBeenCalledWith();
    expect(subscriber.quit).toHaveBeenCalledWith();
  });

  // ── 11. Subscribe failure returns timeout ─────────────────────────
  it('returns timeout when subscribe fails', async () => {
    subscriber.subscribe.mockRejectedValueOnce(new Error('Redis down'));

    const promise = service.waitForCompletion(tenantId, executionId, 30_000);
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;

    expect(result).toEqual({ status: 'timeout' });
    expect(service.activeCount).toBe(0);
  });
});
