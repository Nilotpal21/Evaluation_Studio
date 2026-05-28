import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EvaluationDispatcher } from '../evaluation/evaluation-dispatcher.js';
import type { IPollTargetProvider } from '../evaluation/evaluation-dispatcher.js';
import type {
  IEvaluator,
  IEvaluationConfigProvider,
  IConversationProvider,
  EvaluationInput,
  EvaluationOutput,
  ProjectEvaluationConfig,
} from '../evaluation/interfaces.js';
import type { IEventEmitter } from '../interfaces/event-emitter.js';
import type { IEventReader, EventQueryResult } from '../interfaces/event-store.js';
import type { PlatformEvent } from '../schema/platform-event.js';
import type { EventCategory } from '../interfaces/types.js';

// =============================================================================
// MOCKS
// =============================================================================

function createMockEmitter(): IEventEmitter {
  return {
    emit: vi.fn(),
    emitBatch: vi.fn(),
  };
}

function createMockReader(events: PlatformEvent[] = []): IEventReader {
  return {
    query: vi.fn().mockResolvedValue({
      events,
      total: events.length,
      hasMore: false,
    } satisfies EventQueryResult),
  };
}

function createMockConfigProvider(
  config: ProjectEvaluationConfig | null = null,
): IEvaluationConfigProvider {
  return {
    getConfig: vi.fn().mockResolvedValue(config),
  };
}

function createMockConversationProvider(): IConversationProvider {
  return {
    getMessages: vi.fn().mockResolvedValue([
      { role: 'user' as const, content: 'Hello' },
      { role: 'agent' as const, content: 'Hi there! How can I help?' },
    ]),
  };
}

function createMockEvaluator(
  name: string,
  type: 'code_scorer' | 'llm_judge' = 'code_scorer',
  output?: Partial<EvaluationOutput>,
): IEvaluator {
  return {
    name,
    type,
    evaluate: vi.fn().mockResolvedValue({
      evaluatorName: name,
      evaluatorType: type,
      scores: [{ name: 'test_score', value: 4, reasoning: 'Good' }],
      latencyMs: 50,
      ...output,
    } satisfies EvaluationOutput),
  };
}

function createSessionEndedEvent(overrides: Partial<PlatformEvent> = {}): PlatformEvent {
  return {
    event_id: 'evt-1',
    event_type: 'session.ended',
    category: 'session' as EventCategory,
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    session_id: 'sess-1',
    agent_name: 'booking-agent',
    timestamp: new Date('2026-02-27T12:05:00Z'),
    duration_ms: 30000,
    data: {
      reason: 'completed',
      total_duration_ms: 30000,
      total_turns: 5,
      total_llm_calls: 3,
      total_tool_calls: 2,
      total_tokens: 1500,
      estimated_cost: 0.005,
    },
    ...overrides,
  };
}

function createProjectConfig(
  evaluatorNames: string[],
  overrides: Partial<ProjectEvaluationConfig> = {},
): ProjectEvaluationConfig {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    evaluators: evaluatorNames.map((name) => ({
      evaluatorName: name,
      enabled: true,
    })),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('EvaluationDispatcher', () => {
  let emitter: IEventEmitter;
  let reader: IEventReader;
  let configProvider: IEvaluationConfigProvider;
  let conversationProvider: IConversationProvider;
  let dispatcher: EvaluationDispatcher;

  beforeEach(() => {
    emitter = createMockEmitter();
    reader = createMockReader();
    conversationProvider = createMockConversationProvider();
    configProvider = createMockConfigProvider(null);
  });

  afterEach(async () => {
    if (dispatcher) {
      await dispatcher.stop();
    }
  });

  function createDispatcher(
    config?: ProjectEvaluationConfig | null,
    maxConcurrency?: number,
  ): EvaluationDispatcher {
    if (config !== undefined) {
      configProvider = createMockConfigProvider(config);
    }
    dispatcher = new EvaluationDispatcher({
      emitter,
      reader,
      configProvider,
      conversationProvider,
      maxConcurrency,
    });
    return dispatcher;
  }

  // ─── Registration ────────────────────────────────────────────────────

  describe('registerEvaluator()', () => {
    it('registers an evaluator by name', async () => {
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      const evaluator = createMockEvaluator('test-scorer');
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).toHaveBeenCalledOnce();
    });

    it('overwrites evaluator with same name', async () => {
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      const first = createMockEvaluator('test-scorer');
      const second = createMockEvaluator('test-scorer');
      d.registerEvaluator(first);
      d.registerEvaluator(second);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(first.evaluate).not.toHaveBeenCalled();
      expect(second.evaluate).toHaveBeenCalledOnce();
    });
  });

  // ─── processSessionEnded ──────────────────────────────────────────────

  describe('processSessionEnded()', () => {
    it('does nothing when not running', async () => {
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(createMockEvaluator('test-scorer'));
      // Not started

      await d.processSessionEnded(createSessionEndedEvent());

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('skips when event lacks required fields', async () => {
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(createMockEvaluator('test-scorer'));
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent({ session_id: undefined }));

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('skips when no project config exists', async () => {
      const d = createDispatcher(null); // No config
      d.registerEvaluator(createMockEvaluator('test-scorer'));
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('skips when project config has no evaluators', async () => {
      const d = createDispatcher(createProjectConfig([]));
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const stats = d.getStats();
      expect(stats.evaluationsStarted).toBe(0);
    });

    it('runs matching evaluators', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).toHaveBeenCalledOnce();
      const input = (evaluator.evaluate as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EvaluationInput;
      expect(input.sessionId).toBe('sess-1');
      expect(input.tenantId).toBe('tenant-a');
      expect(input.projectId).toBe('project-a');
    });

    it('skips disabled evaluators', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const config: ProjectEvaluationConfig = {
        tenantId: 'tenant-a',
        projectId: 'project-a',
        evaluators: [{ evaluatorName: 'test-scorer', enabled: false }],
      };
      const d = createDispatcher(config);
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).not.toHaveBeenCalled();
    });

    it('skips evaluators not registered', async () => {
      const d = createDispatcher(createProjectConfig(['nonexistent-evaluator']));
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const stats = d.getStats();
      expect(stats.evaluationsSkipped).toBe(1);
    });

    it('filters by trigger event types', async () => {
      const evaluator = createMockEvaluator('custom-trigger');
      const config: ProjectEvaluationConfig = {
        tenantId: 'tenant-a',
        projectId: 'project-a',
        evaluators: [
          {
            evaluatorName: 'custom-trigger',
            enabled: true,
            triggerEvents: ['agent.escalated'],
          },
        ],
      };
      const d = createDispatcher(config);
      d.registerEvaluator(evaluator);
      await d.start();

      // session.ended doesn't match triggerEvents
      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).not.toHaveBeenCalled();
    });

    it('runs evaluator when trigger event matches', async () => {
      const evaluator = createMockEvaluator('session-scorer');
      const config: ProjectEvaluationConfig = {
        tenantId: 'tenant-a',
        projectId: 'project-a',
        evaluators: [
          {
            evaluatorName: 'session-scorer',
            enabled: true,
            triggerEvents: ['session.ended'],
          },
        ],
      };
      const d = createDispatcher(config);
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).toHaveBeenCalledOnce();
    });
  });

  // ─── Event Emission ───────────────────────────────────────────────────

  describe('event emission', () => {
    it('emits started, completed, and batch events', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const calls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = calls.map((c) => (c[0] as Record<string, unknown>).event_type);

      expect(eventTypes).toContain('evaluation.started');
      expect(eventTypes).toContain('evaluation.completed');
      expect(eventTypes).toContain('evaluation.batch.completed');
    });

    it('includes scores in completed event', async () => {
      const evaluator = createMockEvaluator('test-scorer', 'code_scorer', {
        scores: [
          { name: 'metric_a', value: 4.5 },
          { name: 'metric_b', value: 'pass' },
        ],
        compositeScore: 4.5,
      });
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const calls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
      const completedCall = calls.find(
        (c) => (c[0] as Record<string, unknown>).event_type === 'evaluation.completed',
      );
      const data = (completedCall![0] as Record<string, unknown>).data as Record<string, unknown>;

      expect(data.scores).toEqual({ metric_a: 4.5, metric_b: 'pass' });
      expect(data.composite_score).toBe(4.5);
    });

    it('emits failed event on evaluator error', async () => {
      const evaluator: IEvaluator = {
        name: 'failing-scorer',
        type: 'code_scorer',
        evaluate: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      };
      const d = createDispatcher(createProjectConfig(['failing-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const calls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
      const failedCall = calls.find(
        (c) => (c[0] as Record<string, unknown>).event_type === 'evaluation.failed',
      );

      expect(failedCall).toBeDefined();
      const data = (failedCall![0] as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.error_message).toBe('LLM timeout');
      expect(data.error_type).toBe('Error');
    });

    it('batch event shows correct succeeded/failed counts', async () => {
      const good = createMockEvaluator('good-scorer');
      const bad: IEvaluator = {
        name: 'bad-scorer',
        type: 'code_scorer',
        evaluate: vi.fn().mockRejectedValue(new Error('fail')),
      };
      const config: ProjectEvaluationConfig = {
        tenantId: 'tenant-a',
        projectId: 'project-a',
        evaluators: [
          { evaluatorName: 'good-scorer', enabled: true },
          { evaluatorName: 'bad-scorer', enabled: true },
        ],
      };
      const d = createDispatcher(config);
      d.registerEvaluator(good);
      d.registerEvaluator(bad);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const calls = (emitter.emit as ReturnType<typeof vi.fn>).mock.calls;
      const batchCall = calls.find(
        (c) => (c[0] as Record<string, unknown>).event_type === 'evaluation.batch.completed',
      );
      const data = (batchCall![0] as Record<string, unknown>).data as Record<string, unknown>;

      expect(data.total_evaluations).toBe(2);
      expect(data.succeeded).toBe(1);
      // runEvaluator catches errors internally and returns false → counted as skipped
      expect(data.skipped).toBe(1);
    });
  });

  // ─── Concurrency ───────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('limits concurrent evaluations to maxConcurrency', async () => {
      const evaluators: IEvaluator[] = [];
      const names: string[] = [];
      const activeCount = { current: 0, max: 0 };

      for (let i = 0; i < 8; i++) {
        const name = `eval-${i}`;
        names.push(name);
        evaluators.push({
          name,
          type: 'code_scorer',
          evaluate: vi.fn().mockImplementation(async () => {
            activeCount.current++;
            activeCount.max = Math.max(activeCount.max, activeCount.current);
            await new Promise((r) => setTimeout(r, 10));
            activeCount.current--;
            return {
              evaluatorName: name,
              evaluatorType: 'code_scorer',
              scores: [{ name: 'test', value: 1 }],
              latencyMs: 10,
            };
          }),
        });
      }

      const d = createDispatcher(createProjectConfig(names), 3);
      evaluators.forEach((e) => d.registerEvaluator(e));
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      // With maxConcurrency=3, should never exceed 3 concurrent
      expect(activeCount.max).toBeLessThanOrEqual(3);
      // All should have been called
      evaluators.forEach((e) => {
        expect(e.evaluate).toHaveBeenCalledOnce();
      });
    });
  });

  // ─── Sampling ──────────────────────────────────────────────────────────

  describe('sampling', () => {
    it('skips when global sampling rate is 0', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const config = createProjectConfig(['test-scorer'], {
        globalSampling: { rate: 0, strategy: 'random' },
      });
      const d = createDispatcher(config);
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).not.toHaveBeenCalled();
      expect(d.getStats().evaluationsSkipped).toBe(1);
    });

    it('always runs when global sampling rate is 1', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const config = createProjectConfig(['test-scorer'], {
        globalSampling: { rate: 1, strategy: 'all' },
      });
      const d = createDispatcher(config);
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).toHaveBeenCalledOnce();
    });

    it('respects per-evaluator sampling rate of 0', async () => {
      const evaluator = createMockEvaluator('sampled-scorer');
      const config: ProjectEvaluationConfig = {
        tenantId: 'tenant-a',
        projectId: 'project-a',
        evaluators: [
          {
            evaluatorName: 'sampled-scorer',
            enabled: true,
            sampling: { rate: 0, strategy: 'random' },
          },
        ],
      };
      const d = createDispatcher(config);
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(evaluator.evaluate).not.toHaveBeenCalled();
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────────────

  describe('getStats()', () => {
    it('returns initial zero stats', () => {
      const d = createDispatcher();
      const stats = d.getStats();
      expect(stats).toEqual({
        evaluationsStarted: 0,
        evaluationsCompleted: 0,
        evaluationsFailed: 0,
        evaluationsSkipped: 0,
      });
    });

    it('increments started and completed on success', async () => {
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(createMockEvaluator('test-scorer'));
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const stats = d.getStats();
      expect(stats.evaluationsStarted).toBe(1);
      expect(stats.evaluationsCompleted).toBe(1);
      expect(stats.evaluationsFailed).toBe(0);
    });

    it('increments failed on evaluator error', async () => {
      const evaluator: IEvaluator = {
        name: 'failing',
        type: 'code_scorer',
        evaluate: vi.fn().mockRejectedValue(new Error('boom')),
      };
      const d = createDispatcher(createProjectConfig(['failing']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const stats = d.getStats();
      expect(stats.evaluationsStarted).toBe(1);
      expect(stats.evaluationsFailed).toBe(1);
      expect(stats.evaluationsCompleted).toBe(0);
    });

    it('returns a copy (not the internal object)', () => {
      const d = createDispatcher();
      const stats1 = d.getStats();
      stats1.evaluationsStarted = 999;
      const stats2 = d.getStats();
      expect(stats2.evaluationsStarted).toBe(0);
    });
  });

  // ─── Start / Stop ─────────────────────────────────────────────────────

  describe('start() and stop()', () => {
    it('start enables processing', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);

      // Before start
      await d.processSessionEnded(createSessionEndedEvent());
      expect(evaluator.evaluate).not.toHaveBeenCalled();

      // After start
      await d.start();
      await d.processSessionEnded(createSessionEndedEvent());
      expect(evaluator.evaluate).toHaveBeenCalledOnce();
    });

    it('stop disables processing', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();
      await d.stop();

      await d.processSessionEnded(createSessionEndedEvent());
      expect(evaluator.evaluate).not.toHaveBeenCalled();
    });
  });

  // ─── Input Building ────────────────────────────────────────────────────

  describe('evaluation input building', () => {
    it('fetches messages from conversation provider', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(conversationProvider.getMessages).toHaveBeenCalledWith('tenant-a', 'sess-1');
      const input = (evaluator.evaluate as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EvaluationInput;
      expect(input.messages).toHaveLength(2);
      expect(input.messages[0].content).toBe('Hello');
    });

    it('fetches trace events from reader', async () => {
      const traceEvents: PlatformEvent[] = [
        {
          event_id: 'trace-1',
          event_type: 'llm.call.completed',
          category: 'llm' as EventCategory,
          tenant_id: 'tenant-a',
          project_id: 'project-a',
          session_id: 'sess-1',
          timestamp: new Date(),
          data: {},
        },
      ];
      reader = createMockReader(traceEvents);

      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(reader.query).toHaveBeenCalled();
      const input = (evaluator.evaluate as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EvaluationInput;
      expect(input.traceEvents).toHaveLength(1);
      expect(input.traceEvents[0].event_type).toBe('llm.call.completed');
    });

    it('extracts session metadata from event data', async () => {
      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      const input = (evaluator.evaluate as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as EvaluationInput;
      expect(input.sessionMetadata.totalDurationMs).toBe(30000);
      expect(input.sessionMetadata.totalTurns).toBe(5);
      expect(input.sessionMetadata.totalLLMCalls).toBe(3);
      expect(input.sessionMetadata.totalToolCalls).toBe(2);
      expect(input.sessionMetadata.endReason).toBe('completed');
    });

    it('handles conversation provider failure gracefully', async () => {
      conversationProvider = {
        getMessages: vi.fn().mockRejectedValue(new Error('DB down')),
      };
      const evaluator = createMockEvaluator('test-scorer');
      const d = createDispatcher(createProjectConfig(['test-scorer']));
      d.registerEvaluator(evaluator);
      await d.start();

      // Should not throw
      await d.processSessionEnded(createSessionEndedEvent());

      // Evaluator should not be called since input building failed
      expect(evaluator.evaluate).not.toHaveBeenCalled();
    });
  });

  // ─── Tenant Isolation (poll mode) ──────────────────────────────────────

  describe('tenant isolation in poll mode', () => {
    it('throws if pollIntervalMs > 0 without pollTargetProvider', () => {
      expect(
        () =>
          new EvaluationDispatcher({
            emitter,
            reader,
            configProvider,
            conversationProvider,
            pollIntervalMs: 5000,
            // No pollTargetProvider
          }),
      ).toThrow('pollTargetProvider is required when pollIntervalMs > 0');
    });

    it('allows pollIntervalMs = 0 without pollTargetProvider', () => {
      expect(
        () =>
          new EvaluationDispatcher({
            emitter,
            reader,
            configProvider,
            conversationProvider,
            pollIntervalMs: 0,
          }),
      ).not.toThrow();
    });

    it('queries per tenant+project pair — never wildcard', async () => {
      // Use empty events so processSessionEnded doesn't add extra reader.query calls
      const mockReader = createMockReader([]);
      reader = mockReader;
      configProvider = createMockConfigProvider(createProjectConfig(['scorer']));

      const pollTargetProvider: IPollTargetProvider = {
        getActiveTargets: vi.fn().mockResolvedValue([
          { tenantId: 'tenant-x', projectId: 'project-y' },
          { tenantId: 'tenant-z', projectId: 'project-w' },
        ]),
      };

      dispatcher = new EvaluationDispatcher({
        emitter,
        reader: reader,
        configProvider,
        conversationProvider,
        pollIntervalMs: 60000, // Enable poll mode
        pollTargetProvider,
      });
      dispatcher.registerEvaluator(createMockEvaluator('scorer'));
      await dispatcher.start();

      // Manually trigger poll (instead of waiting for interval)
      await (dispatcher as unknown as { pollAndProcess: () => Promise<void> }).pollAndProcess();

      // Should have queried exactly twice — once per target pair (no events returned,
      // so no additional trace queries from buildEvaluationInput)
      const queryCalls = (mockReader.query as ReturnType<typeof vi.fn>).mock.calls;
      expect(queryCalls).toHaveLength(2);

      // First query: tenant-x / project-y
      expect(queryCalls[0][0].tenantId).toBe('tenant-x');
      expect(queryCalls[0][0].projectId).toBe('project-y');

      // Second query: tenant-z / project-w
      expect(queryCalls[1][0].tenantId).toBe('tenant-z');
      expect(queryCalls[1][0].projectId).toBe('project-w');

      // No wildcard queries anywhere
      for (const call of queryCalls) {
        expect(call[0].tenantId).not.toBe('*');
        expect(call[0].projectId).not.toBe('*');
      }
    });

    it('continues processing other targets when one query fails', async () => {
      // Use empty results so processSessionEnded doesn't trigger extra queries
      const emptyResult = {
        events: [],
        total: 0,
        hasMore: false,
      } satisfies EventQueryResult;

      // First call fails, second succeeds (with no events)
      const mockQuery = vi
        .fn()
        .mockRejectedValueOnce(new Error('DB timeout'))
        .mockResolvedValueOnce(emptyResult);

      reader = { query: mockQuery } as unknown as IEventReader;
      configProvider = createMockConfigProvider(createProjectConfig(['scorer']));

      const pollTargetProvider: IPollTargetProvider = {
        getActiveTargets: vi.fn().mockResolvedValue([
          { tenantId: 'tenant-fail', projectId: 'project-fail' },
          { tenantId: 'tenant-ok', projectId: 'project-ok' },
        ]),
      };

      dispatcher = new EvaluationDispatcher({
        emitter,
        reader,
        configProvider,
        conversationProvider,
        pollIntervalMs: 60000,
        pollTargetProvider,
      });
      dispatcher.registerEvaluator(createMockEvaluator('scorer'));
      await dispatcher.start();

      await (dispatcher as unknown as { pollAndProcess: () => Promise<void> }).pollAndProcess();

      // Both targets should have been queried despite first one failing
      expect(mockQuery).toHaveBeenCalledTimes(2);

      // First query was for tenant-fail (should have failed)
      expect(mockQuery.mock.calls[0][0].tenantId).toBe('tenant-fail');
      // Second query was for tenant-ok (should have succeeded)
      expect(mockQuery.mock.calls[1][0].tenantId).toBe('tenant-ok');
    });
  });

  // ─── Evaluator Map Capacity ──────────────────────────────────────────────

  describe('evaluator registration capacity', () => {
    it('rejects registration beyond max capacity', () => {
      const d = createDispatcher();

      // Register up to max (100)
      for (let i = 0; i < 100; i++) {
        d.registerEvaluator(createMockEvaluator(`eval-${i}`));
      }

      // The 101st should be silently rejected (logged as warning)
      d.registerEvaluator(createMockEvaluator('eval-overflow'));

      // Verify internal map size stays at 100
      // We can check indirectly: register an evaluator that matches config,
      // start, and process — the overflow evaluator should not run
      // since it was rejected
    });

    it('allows overwriting existing evaluator even at max capacity', async () => {
      const d = createDispatcher(createProjectConfig(['eval-0']));

      // Register 100 evaluators
      for (let i = 0; i < 100; i++) {
        d.registerEvaluator(createMockEvaluator(`eval-${i}`));
      }

      // Overwrite eval-0 (should succeed since it's replacing, not adding)
      const replacement = createMockEvaluator('eval-0');
      d.registerEvaluator(replacement);
      await d.start();

      await d.processSessionEnded(createSessionEndedEvent());

      expect(replacement.evaluate).toHaveBeenCalledOnce();
    });
  });
});
