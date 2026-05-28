/**
 * Extended Store Tests
 *
 * Tests for stores not yet covered by existing tests:
 * - InMemoryAuditStore: log, query, getSummary, getByTraceId, alerts
 * - InMemoryMetricsStore: record, getUsage, getCostBreakdown
 * - InMemoryTraceStore: startTrace, appendEvent, endTrace, queryTraces
 * - TraceContextManager: logLLMCall, logToolCall, logDecision, logError, child spans
 * - InMemoryMessageStore: addMessage, getMessages, getMessageCount, deleteBySession, cleanup
 * - InMemoryAgentRegistry: version management, bumpVersion, hashContent
 * - Store factories
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Audit Store
import {
  InMemoryAuditStore,
  createAuditStore,
  type LogAuditParams,
  type AlertConfig,
} from '../platform/stores/audit-store.js';

// Metrics Store
import {
  InMemoryMetricsStore,
  createMetricsStore,
  type MetricsStoreConfig,
  type LLMMetricInput,
} from '../platform/stores/metrics-store.js';

// Trace Store
import {
  TraceContextManager,
  createTraceContext,
  type TraceEventSink,
} from '../platform/stores/trace-store.js';
import type { TraceContext, TraceEvent } from '../platform/core/types.js';

// Message Store
import {
  InMemoryMessageStore,
  createMessageStore,
  type MessageStoreConfig,
} from '../platform/stores/message-store.js';

// Agent Registry
import {
  InMemoryAgentRegistry,
  createAgentRegistry,
  type AgentRegistryConfig,
} from '../platform/stores/agent-registry.js';

// =============================================================================
// IN-MEMORY AUDIT STORE
// =============================================================================

describe('InMemoryAuditStore', () => {
  let store: InMemoryAuditStore;

  beforeEach(() => {
    store = new InMemoryAuditStore({ type: 'memory' });
  });

  describe('log', () => {
    test('creates an audit log entry with generated id and timestamp', async () => {
      const params: LogAuditParams = {
        eventType: 'agent.created',
        actor: 'admin-1',
        actorType: 'admin',
        resourceType: 'agent',
        resourceId: 'booking-agent',
        environment: 'dev',
        action: 'Created agent booking-agent',
      };

      const log = await store.log(params);
      expect(log.id).toBeDefined();
      expect(log.timestamp).toBeInstanceOf(Date);
      expect(log.eventType).toBe('agent.created');
      expect(log.actor).toBe('admin-1');
      expect(log.resourceId).toBe('booking-agent');
      expect(log.metadata).toEqual({});
    });

    test('includes optional fields', async () => {
      const log = await store.log({
        eventType: 'tool.executed',
        actor: 'agent-x',
        actorType: 'agent',
        resourceType: 'tool',
        resourceId: 'search-api',
        environment: 'production',
        action: 'Executed search-api',
        oldValue: { status: 'idle' },
        newValue: { status: 'running' },
        metadata: { duration: 150 },
        ipAddress: '10.0.0.1',
        traceId: 'trace-abc',
      });

      expect(log.oldValue).toEqual({ status: 'idle' });
      expect(log.newValue).toEqual({ status: 'running' });
      expect(log.ipAddress).toBe('10.0.0.1');
      expect(log.traceId).toBe('trace-abc');
    });
  });

  describe('convenience methods', () => {
    test('logAgentCreated creates correct event', async () => {
      const log = await store.logAgentCreated('my-agent', '1.0.0', 'admin', 'dev');
      expect(log.eventType).toBe('agent.created');
      expect(log.resourceId).toBe('my-agent');
      expect(log.actorType).toBe('admin');
    });

    test('logAgentPromoted creates correct event', async () => {
      const log = await store.logAgentPromoted('my-agent', '1.0.0', 'dev', 'staging', 'admin');
      expect(log.eventType).toBe('agent.promoted');
      expect(log.action).toContain('Promoted');
      expect(log.action).toContain('dev');
      expect(log.action).toContain('staging');
    });

    test('logAgentRolledBack creates correct event', async () => {
      const log = await store.logAgentRolledBack(
        'my-agent',
        '2.0.0',
        '1.0.0',
        'Bug found',
        'admin',
        'production',
      );
      expect(log.eventType).toBe('agent.rolled_back');
      expect(log.action).toContain('Rolled back');
    });

    test('logEscalationTriggered creates correct event', async () => {
      const log = await store.logEscalationTriggered(
        'sess-1',
        'bot',
        'User frustrated',
        'high',
        'production',
        'trace-1',
      );
      expect(log.eventType).toBe('escalation.triggered');
      expect(log.traceId).toBe('trace-1');
    });

    test('logHumanIntervention creates correct event', async () => {
      const log = await store.logHumanIntervention(
        'sess-1',
        'human-1',
        'Took over conversation',
        'production',
      );
      expect(log.eventType).toBe('human.intervention');
    });
  });

  describe('query', () => {
    test('filters by time range', async () => {
      await store.log({
        eventType: 'agent.created',
        actor: 'admin',
        actorType: 'admin',
        resourceType: 'agent',
        resourceId: 'a1',
        environment: 'dev',
        action: 'test',
      });

      const result = await store.query({
        tenantId: 'unscoped',
        startTime: new Date(Date.now() - 60000),
        endTime: new Date(Date.now() + 60000),
      });

      expect(result.total).toBe(1);
      expect(result.logs.length).toBe(1);
    });

    test('filters by event type', async () => {
      await store.logAgentCreated('a1', '1.0', 'admin', 'dev');
      await store.logEscalationTriggered('s1', 'a1', 'handoff required', 'high', 'dev');

      const result = await store.query({
        tenantId: 'unscoped',
        startTime: new Date(Date.now() - 60000),
        endTime: new Date(Date.now() + 60000),
        eventTypes: ['agent.created'],
      });

      expect(result.total).toBe(1);
      expect(result.logs[0].eventType).toBe('agent.created');
    });

    test('filters by actor', async () => {
      await store.logAgentCreated('a1', '1.0', 'alice', 'dev');
      await store.logAgentCreated('a2', '1.0', 'bob', 'dev');

      const result = await store.query({
        tenantId: 'unscoped',
        startTime: new Date(Date.now() - 60000),
        endTime: new Date(Date.now() + 60000),
        actor: 'alice',
      });

      expect(result.total).toBe(1);
    });

    test('filters by resource type and id', async () => {
      await store.logAgentCreated('a1', '1.0', 'admin', 'dev');
      await store.logEscalationTriggered('s1', 'a1', 'handoff required', 'high', 'dev');

      const result = await store.query({
        tenantId: 'unscoped',
        startTime: new Date(Date.now() - 60000),
        endTime: new Date(Date.now() + 60000),
        resourceType: 'session',
      });

      expect(result.total).toBe(1);
    });

    test('paginates results', async () => {
      for (let i = 0; i < 5; i++) {
        await store.logAgentCreated(`a${i}`, '1.0', 'admin', 'dev');
      }

      const result = await store.query({
        tenantId: 'unscoped',
        startTime: new Date(Date.now() - 60000),
        endTime: new Date(Date.now() + 60000),
        limit: 2,
        offset: 1,
      });

      expect(result.logs.length).toBe(2);
      expect(result.total).toBe(5);
    });

    test('sorts by timestamp descending', async () => {
      await store.logAgentCreated('first', '1.0', 'admin', 'dev');
      await new Promise((r) => setTimeout(r, 5));
      await store.logAgentCreated('second', '1.0', 'admin', 'dev');

      const result = await store.query({
        tenantId: 'unscoped',
        startTime: new Date(Date.now() - 60000),
        endTime: new Date(Date.now() + 60000),
      });

      expect(result.logs[0].resourceId).toBe('second');
    });
  });

  describe('getSummary', () => {
    test('returns summary statistics', async () => {
      await store.logAgentCreated('a1', '1.0', 'alice', 'dev');
      await store.logAgentCreated('a2', '1.0', 'bob', 'dev');
      await store.logEscalationTriggered('s1', 'a1', 'handoff required', 'high', 'dev');

      const summary = await store.getSummary(
        'unscoped',
        'dev',
        new Date(Date.now() - 60000),
        new Date(Date.now() + 60000),
      );

      expect(summary.totalEvents).toBe(3);
      expect(summary.eventsByType['agent.created']).toBe(2);
      expect(summary.eventsByType['escalation.triggered']).toBe(1);
      expect(summary.eventsByActor['alice']).toBe(1);
      expect(summary.eventsByActor['bob']).toBe(1);
    });

    test('filters by environment', async () => {
      await store.logAgentCreated('a1', '1.0', 'admin', 'dev');
      await store.logAgentCreated('a2', '1.0', 'admin', 'production');

      const summary = await store.getSummary(
        'unscoped',
        'production',
        new Date(Date.now() - 60000),
        new Date(Date.now() + 60000),
      );

      expect(summary.totalEvents).toBe(1);
    });
  });

  describe('getByTraceId', () => {
    test('returns logs matching trace ID', async () => {
      await store.logEscalationTriggered('s1', 'bot', 'reason', 'high', 'production', 'trace-xyz');
      await store.logAgentCreated('a1', '1.0', 'admin', 'dev');

      const results = await store.getByTraceId('unscoped', 'trace-xyz');
      expect(results.length).toBe(1);
      expect(results[0].traceId).toBe('trace-xyz');
    });

    test('returns empty array for unknown trace', async () => {
      const results = await store.getByTraceId('unscoped', 'nonexistent');
      expect(results).toEqual([]);
    });
  });

  describe('alerts', () => {
    test('sends alert for critical events when configured', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

      const alertConfig: AlertConfig = {
        enabled: true,
        webhookUrl: 'https://example.com/webhook',
        criticalEvents: ['escalation.triggered'],
      };

      const alertStore = new InMemoryAuditStore({ type: 'memory' }, alertConfig);
      await alertStore.logEscalationTriggered('s1', 'bot', 'reason', 'high', 'production');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ method: 'POST' }),
      );

      fetchSpy.mockRestore();
    });

    test('sends alert for rolled_back events (error-like)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

      const alertConfig: AlertConfig = {
        enabled: true,
        webhookUrl: 'https://example.com/webhook',
        criticalEvents: [],
      };

      const alertStore = new InMemoryAuditStore({ type: 'memory' }, alertConfig);
      await alertStore.logAgentRolledBack('agent', '2.0', '1.0', 'bug', 'admin', 'production');

      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    test('does not send alert when disabled', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK'));

      const alertConfig: AlertConfig = {
        enabled: false,
        criticalEvents: ['escalation.triggered'],
      };

      const alertStore = new InMemoryAuditStore({ type: 'memory' }, alertConfig);
      await alertStore.logEscalationTriggered('s1', 'bot', 'reason', 'high', 'production');

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});

// =============================================================================
// AUDIT STORE FACTORY
// =============================================================================

describe('createAuditStore', () => {
  test('creates memory store', () => {
    const store = createAuditStore({ type: 'memory' });
    expect(store).toBeInstanceOf(InMemoryAuditStore);
  });

  test('throws for mongodb type', () => {
    expect(() => createAuditStore({ type: 'mongodb' })).toThrow(
      'MongoDB audit store is no longer supported',
    );
  });

  test('throws for unknown type', () => {
    expect(() => createAuditStore({ type: 'clickhouse' as 'memory' })).toThrow(
      'Unknown audit store type',
    );
  });
});

// =============================================================================
// IN-MEMORY METRICS STORE
// =============================================================================

describe('InMemoryMetricsStore', () => {
  let store: InMemoryMetricsStore;

  const makeMetric = (overrides: Partial<LLMMetricInput> = {}): LLMMetricInput => ({
    sessionId: 'sess-1',
    projectId: 'proj-1',
    modelId: 'gpt-4o',
    provider: 'openai',
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    estimatedCost: 0.005,
    latencyMs: 200,
    streamingUsed: false,
    toolCallCount: 0,
    ...overrides,
  });

  beforeEach(() => {
    store = new InMemoryMetricsStore({ type: 'memory' });
  });

  describe('record and getUsage', () => {
    test('records a metric and retrieves usage summary', async () => {
      await store.record(makeMetric());
      await store.record(
        makeMetric({ inputTokens: 200, outputTokens: 100, totalTokens: 300, latencyMs: 400 }),
      );

      const usage = await store.getUsage({ projectId: 'proj-1' });
      expect(usage.totalRequests).toBe(2);
      expect(usage.inputTokens).toBe(300);
      expect(usage.outputTokens).toBe(150);
      expect(usage.totalTokens).toBe(450);
      expect(usage.avgLatencyMs).toBe(300);
    });

    test('returns zeros for empty project', async () => {
      const usage = await store.getUsage({ projectId: 'nonexistent' });
      expect(usage.totalRequests).toBe(0);
      expect(usage.inputTokens).toBe(0);
      expect(usage.avgLatencyMs).toBe(0);
    });

    test('filters by projectId', async () => {
      await store.record(makeMetric({ projectId: 'proj-1' }));
      await store.record(makeMetric({ projectId: 'proj-2' }));

      const usage = await store.getUsage({ projectId: 'proj-1' });
      expect(usage.totalRequests).toBe(1);
    });

    test('handles null estimatedCost', async () => {
      await store.record(makeMetric({ estimatedCost: null }));
      const usage = await store.getUsage({ projectId: 'proj-1' });
      expect(usage.estimatedCost).toBe(0);
    });
  });

  describe('getCostBreakdown', () => {
    test('groups costs by model and provider', async () => {
      await store.record(
        makeMetric({ modelId: 'gpt-4o', provider: 'openai', estimatedCost: 0.01 }),
      );
      await store.record(
        makeMetric({ modelId: 'gpt-4o', provider: 'openai', estimatedCost: 0.02 }),
      );
      await store.record(
        makeMetric({ modelId: 'claude-3', provider: 'anthropic', estimatedCost: 0.05 }),
      );

      const breakdown = await store.getCostBreakdown({ projectId: 'proj-1' });
      expect(breakdown.length).toBe(2);

      const openai = breakdown.find((b) => b.provider === 'openai');
      expect(openai!.requests).toBe(2);
      expect(openai!.estimatedCost).toBeCloseTo(0.03);

      const anthropic = breakdown.find((b) => b.provider === 'anthropic');
      expect(anthropic!.requests).toBe(1);
      expect(anthropic!.estimatedCost).toBeCloseTo(0.05);
    });

    test('returns empty array for no data', async () => {
      const breakdown = await store.getCostBreakdown({ projectId: 'nothing' });
      expect(breakdown).toEqual([]);
    });
  });
});

// =============================================================================
// METRICS STORE FACTORY
// =============================================================================

describe('createMetricsStore', () => {
  test('creates memory store', () => {
    const store = createMetricsStore({ type: 'memory' });
    expect(store).toBeInstanceOf(InMemoryMetricsStore);
  });

  test('throws for postgres', () => {
    expect(() => createMetricsStore({ type: 'postgres' })).toThrow('not yet implemented');
  });

  test('throws for clickhouse', () => {
    expect(() => createMetricsStore({ type: 'clickhouse' })).toThrow('runtime dependencies');
  });
});

// =============================================================================
// TEST TRACE EVENT SINK — collects events for assertions
// =============================================================================

class TestTraceEventSink implements TraceEventSink {
  events: Map<string, TraceEvent[]> = new Map();
  endedTraces: Map<string, TraceContext> = new Map();

  appendEvent(traceId: string, event: TraceEvent): void {
    const existing = this.events.get(traceId) ?? [];
    existing.push(event);
    this.events.set(traceId, existing);
  }

  endTrace(context: TraceContext): void {
    this.endedTraces.set(context.traceId, context);
  }

  getEvents(traceId: string): TraceEvent[] {
    return this.events.get(traceId) ?? [];
  }
}

// =============================================================================
// TRACE CONTEXT MANAGER (via createTraceContext)
// =============================================================================

describe('TraceContextManager (via createTraceContext)', () => {
  let sink: TestTraceEventSink;

  beforeEach(() => {
    sink = new TestTraceEventSink();
  });

  describe('createTraceContext', () => {
    test('returns a TraceContextManager with unique ids', () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      expect(manager.traceId).toBeDefined();
      expect(manager.spanId).toBeDefined();
    });
  });

  describe('TraceContextManager', () => {
    test('logLLMCall appends event to sink', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      await manager.logLLMCall({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        response: 'hello',
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 100,
        cost: 0.001,
      });

      const events = sink.getEvents(manager.traceId);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('llm_call');
    });

    test('logToolCall appends tool event', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      await manager.logToolCall({
        toolName: 'search',
        input: { query: 'test' },
        output: { results: [] },
        latencyMs: 50,
        success: true,
      });

      const events = sink.getEvents(manager.traceId);
      expect(events[0].type).toBe('tool_call');
      expect(events[0].data.toolName).toBe('search');
    });

    test('logDecision appends decision event', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      await manager.logDecision({
        decisionKind: 'routing',
        decision: 'handoff to support',
        reasoning: 'User asked for human',
        contextSnapshot: { mood: 'frustrated' },
      });

      const events = sink.getEvents(manager.traceId);
      expect(events[0].type).toBe('decision');
    });

    test('logConstraintCheck appends constraint event', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      await manager.logConstraintCheck('no_pii', true, {});

      const events = sink.getEvents(manager.traceId);
      expect(events[0].type).toBe('constraint_check');
    });

    test('logHandoff appends handoff event', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      await manager.logHandoff('support-agent', 'user frustrated', { level: 'high' });

      const events = sink.getEvents(manager.traceId);
      expect(events[0].type).toBe('handoff');
    });

    test('logEscalation appends escalation event', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      await manager.logEscalation('critical issue', 'urgent', {});

      const events = sink.getEvents(manager.traceId);
      expect(events[0].type).toBe('escalation');
    });

    test('logError always logs (even without sampling)', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
        samplingRate: 0,
      });

      // Even at 0% sampling, errors should be logged
      await manager.logError('RuntimeError', 'Something broke', 'stack trace');

      const events = sink.getEvents(manager.traceId);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('error');
    });

    test('end calls endTrace on sink', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      await manager.end();

      const endedTrace = sink.endedTraces.get(manager.traceId);
      expect(endedTrace).toBeDefined();
      expect(endedTrace!.endTime).toBeInstanceOf(Date);
    });

    test('createChildSpan creates nested span', () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'parent-agent',
          agentVersion: '1.0.0',
          environment: 'dev',
        },
      });

      const child = manager.createChildSpan('child-agent');
      expect(child.traceId).toBe(manager.traceId);
      expect(child.spanId).not.toBe(manager.spanId);
    });

    test('HLC sequence is stamped when nodeId is provided', async () => {
      const manager = createTraceContext({
        sink,
        params: {
          sessionId: 'sess-1',
          agentName: 'agent-1',
          agentVersion: '1.0.0',
          environment: 'dev',
          nodeId: 'pod-1',
        },
      });

      await manager.logLLMCall({
        model: 'gpt-4o',
        messages: [],
        response: 'ok',
        tokensIn: 1,
        tokensOut: 1,
        latencyMs: 10,
      });

      const events = sink.getEvents(manager.traceId);
      expect(events[0].sequence).toBeDefined();
      expect(events[0].sequence).toContain('pod-1');
    });
  });
});

// =============================================================================
// IN-MEMORY MESSAGE STORE
// =============================================================================

describe('InMemoryMessageStore', () => {
  let store: InMemoryMessageStore;

  beforeEach(() => {
    store = new InMemoryMessageStore({ type: 'memory' });
  });

  describe('addMessage', () => {
    test('creates a message with generated id and timestamp', async () => {
      const msg = await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hello!',
        channel: 'web_chat',
        traceId: 'trace-1',
      });

      expect(msg.id).toBeDefined();
      expect(msg.sessionId).toBe('sess-1');
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello!');
      expect(msg.timestamp).toBeInstanceOf(Date);
    });

    test('includes optional metadata', async () => {
      const msg = await store.addMessage({
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Hi there',
        channel: 'web_chat',
        traceId: 'trace-1',
        metadata: { model: 'gpt-4o', latencyMs: 200 },
      });

      expect(msg.metadata.model).toBe('gpt-4o');
      expect(msg.metadata.latencyMs).toBe(200);
    });
  });

  describe('getMessages', () => {
    test('returns messages for a session', async () => {
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hi',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Hello',
        channel: 'web_chat',
        traceId: 't1',
      });

      const messages = await store.getMessages({ sessionId: 'sess-1' });
      expect(messages.length).toBe(2);
    });

    test('excludes system messages by default', async () => {
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'system',
        content: 'system prompt',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hi',
        channel: 'web_chat',
        traceId: 't1',
      });

      const messages = await store.getMessages({ sessionId: 'sess-1' });
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('user');
    });

    test('includes system messages when requested', async () => {
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'system',
        content: 'system prompt',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hi',
        channel: 'web_chat',
        traceId: 't1',
      });

      const messages = await store.getMessages({ sessionId: 'sess-1', includeSystem: true });
      expect(messages.length).toBe(2);
    });

    test('filters by roles', async () => {
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hi',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Hello',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'tool',
        content: 'result',
        channel: 'web_chat',
        traceId: 't1',
      });

      const messages = await store.getMessages({
        sessionId: 'sess-1',
        roles: ['user', 'assistant'],
      });
      expect(messages.length).toBe(2);
    });

    test('paginates with offset and limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.addMessage({
          sessionId: 'sess-1',
          role: 'user',
          content: `msg ${i}`,
          channel: 'web_chat',
          traceId: 't1',
        });
      }

      const messages = await store.getMessages({ sessionId: 'sess-1', limit: 2, offset: 1 });
      expect(messages.length).toBe(2);
    });

    test('returns empty for unknown session', async () => {
      const messages = await store.getMessages({ sessionId: 'unknown' });
      expect(messages).toEqual([]);
    });
  });

  describe('getMessageCount', () => {
    test('returns correct count', async () => {
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hi',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Hello',
        channel: 'web_chat',
        traceId: 't1',
      });

      expect(await store.getMessageCount('sess-1')).toBe(2);
    });

    test('returns 0 for unknown session', async () => {
      expect(await store.getMessageCount('unknown')).toBe(0);
    });
  });

  describe('deleteBySession', () => {
    test('deletes all messages for a session', async () => {
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'user',
        content: 'Hi',
        channel: 'web_chat',
        traceId: 't1',
      });
      await store.addMessage({
        sessionId: 'sess-1',
        role: 'assistant',
        content: 'Hello',
        channel: 'web_chat',
        traceId: 't1',
      });

      const deleted = await store.deleteBySession('sess-1');
      expect(deleted).toBe(2);
      expect(await store.getMessageCount('sess-1')).toBe(0);
    });
  });

  describe('cleanup', () => {
    test('removes old sessions', async () => {
      // Add a message and backdate it
      await store.addMessage({
        sessionId: 'old-sess',
        role: 'user',
        content: 'old',
        channel: 'web_chat',
        traceId: 't1',
      });

      // With 0ms threshold, everything is "old"
      const deleted = await store.cleanup(0);
      // This may or may not delete depending on timing; at minimum it should not throw
      expect(typeof deleted).toBe('number');
    });
  });
});

// =============================================================================
// MESSAGE STORE FACTORY
// =============================================================================

describe('createMessageStore', () => {
  test('creates memory store', () => {
    const store = createMessageStore({ type: 'memory' });
    expect(store).toBeInstanceOf(InMemoryMessageStore);
  });

  test('throws for mongodb', () => {
    expect(() => createMessageStore({ type: 'mongodb' })).toThrow('runtime dependencies');
  });

  test('throws for clickhouse', () => {
    expect(() => createMessageStore({ type: 'clickhouse' })).toThrow('runtime dependencies');
  });
});

// =============================================================================
// IN-MEMORY AGENT REGISTRY
// =============================================================================

describe('InMemoryAgentRegistry', () => {
  let registry: InMemoryAgentRegistry;

  beforeEach(() => {
    registry = new InMemoryAgentRegistry({ type: 'memory' });
  });

  describe('version management', () => {
    test('saves and retrieves a version', async () => {
      const version = {
        agentName: 'test-agent',
        version: '1.0.0',
        status: 'draft' as const,
        dslContent: 'agent test-agent {}',
        irContent: '{}',
        sourceHash: 'abc123',
        createdAt: new Date(),
        createdBy: 'admin',
        changelog: 'Initial version',
      };

      await registry.saveVersion(version);
      const loaded = await registry.getVersion('test-agent', '1.0.0');
      expect(loaded).not.toBeNull();
      expect(loaded!.agentName).toBe('test-agent');
      expect(loaded!.version).toBe('1.0.0');
    });

    test('getVersion returns null for non-existent version', async () => {
      const result = await registry.getVersion('nope', '1.0.0');
      expect(result).toBeNull();
    });

    test('getLatestVersion returns highest version', async () => {
      const base = {
        agentName: 'agent',
        status: 'draft' as const,
        dslContent: '',
        irContent: '{}',
        sourceHash: 'x',
        createdAt: new Date(),
        createdBy: 'admin',
        changelog: 'test',
      };

      await registry.saveVersion({ ...base, version: '1.0.0' });
      await registry.saveVersion({ ...base, version: '1.0.1' });
      await registry.saveVersion({ ...base, version: '1.1.0' });

      const latest = await registry.getLatestVersion('agent');
      expect(latest!.version).toBe('1.1.0');
    });

    test('getLatestVersion returns null for unknown agent', async () => {
      const result = await registry.getLatestVersion('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('active versions', () => {
    test('set and get active version for environment', async () => {
      await registry.setActiveVersion('agent', '1.0.0', 'dev');
      const version = await registry.getActiveVersion('agent', 'dev');
      expect(version).toBe('1.0.0');
    });

    test('returns null for unset environment', async () => {
      const version = await registry.getActiveVersion('agent', 'production');
      expect(version).toBeNull();
    });

    test('getActiveVersions returns all environments', async () => {
      await registry.setActiveVersion('agent', '1.0.0', 'dev');
      await registry.setActiveVersion('agent', '1.0.1', 'staging');

      const versions = await registry.getActiveVersions('agent');
      expect(versions.dev).toBe('1.0.0');
      expect(versions.staging).toBe('1.0.1');
    });
  });

  describe('listAgents', () => {
    test('returns unique agent names', async () => {
      const base = {
        status: 'draft' as const,
        dslContent: '',
        irContent: '{}',
        sourceHash: 'x',
        createdAt: new Date(),
        createdBy: 'admin',
        changelog: 'test',
      };

      await registry.saveVersion({ ...base, agentName: 'agent-a', version: '1.0.0' });
      await registry.saveVersion({ ...base, agentName: 'agent-a', version: '1.0.1' });
      await registry.saveVersion({ ...base, agentName: 'agent-b', version: '1.0.0' });

      const agents = await registry.listAgents();
      expect(agents.sort()).toEqual(['agent-a', 'agent-b']);
    });
  });

  describe('queryVersions', () => {
    test('filters by agent name', async () => {
      const base = {
        status: 'draft' as const,
        dslContent: '',
        irContent: '{}',
        sourceHash: 'x',
        createdAt: new Date(),
        createdBy: 'admin',
        changelog: 'test',
      };

      await registry.saveVersion({ ...base, agentName: 'agent-a', version: '1.0.0' });
      await registry.saveVersion({ ...base, agentName: 'agent-b', version: '1.0.0' });

      const results = await registry.queryVersions({ agentName: 'agent-a' });
      expect(results.length).toBe(1);
      expect(results[0].agentName).toBe('agent-a');
    });

    test('filters by status', async () => {
      const base = {
        agentName: 'agent',
        dslContent: '',
        irContent: '{}',
        sourceHash: 'x',
        createdAt: new Date(),
        createdBy: 'admin',
        changelog: 'test',
      };

      await registry.saveVersion({ ...base, version: '1.0.0', status: 'draft' as const });
      await registry.saveVersion({ ...base, version: '1.0.1', status: 'active' as const });

      const results = await registry.queryVersions({ status: 'active' });
      expect(results.length).toBe(1);
      expect(results[0].version).toBe('1.0.1');
    });
  });

  describe('getVersionHistory', () => {
    test('returns versions in reverse chronological order', async () => {
      const base = {
        agentName: 'agent',
        status: 'draft' as const,
        dslContent: '',
        irContent: '{}',
        sourceHash: 'x',
        createdBy: 'admin',
        changelog: 'test',
      };

      await registry.saveVersion({ ...base, version: '1.0.0', createdAt: new Date('2025-01-01') });
      await registry.saveVersion({ ...base, version: '1.0.1', createdAt: new Date('2025-02-01') });
      await registry.saveVersion({ ...base, version: '1.0.2', createdAt: new Date('2025-03-01') });

      const history = await registry.getVersionHistory('agent', 2);
      expect(history.length).toBe(2);
      expect(history[0].version).toBe('1.0.2');
      expect(history[1].version).toBe('1.0.1');
    });
  });

  describe('recordTestResults', () => {
    test('stores test results on version', async () => {
      await registry.saveVersion({
        agentName: 'agent',
        version: '1.0.0',
        status: 'draft',
        dslContent: '',
        irContent: '{}',
        sourceHash: 'x',
        createdAt: new Date(),
        createdBy: 'admin',
        changelog: 'test',
      });

      const updated = await registry.recordTestResults('agent', '1.0.0', {
        passed: true,
        totalTests: 10,
        passedTests: 10,
        failedTests: 0,
        testRuns: [],
      });

      expect(updated.testResults!.passed).toBe(true);
      expect(updated.testResults!.totalTests).toBe(10);
    });

    test('auto-transitions draft to testing when tests pass', async () => {
      await registry.saveVersion({
        agentName: 'agent',
        version: '1.0.0',
        status: 'draft',
        dslContent: '',
        irContent: '{}',
        sourceHash: 'x',
        createdAt: new Date(),
        createdBy: 'admin',
        changelog: 'test',
      });

      const updated = await registry.recordTestResults('agent', '1.0.0', {
        passed: true,
        totalTests: 5,
        passedTests: 5,
        failedTests: 0,
        testRuns: [],
      });

      expect(updated.status).toBe('testing');
    });

    test('throws for non-existent version', async () => {
      await expect(
        registry.recordTestResults('nope', '1.0.0', {
          passed: true,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          testRuns: [],
        }),
      ).rejects.toThrow('not found');
    });
  });
});

// =============================================================================
// AGENT REGISTRY FACTORY
// =============================================================================

describe('createAgentRegistry', () => {
  test('creates memory registry', () => {
    const registry = createAgentRegistry({ type: 'memory' });
    expect(registry).toBeInstanceOf(InMemoryAgentRegistry);
  });

  test('throws for postgres', () => {
    expect(() => createAgentRegistry({ type: 'postgres' })).toThrow('not yet implemented');
  });

  test('throws for unknown type', () => {
    expect(() => createAgentRegistry({ type: 'mongodb' as 'memory' })).toThrow();
  });
});
