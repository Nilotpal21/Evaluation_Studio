/**
 * Extraction Decision Traces Tests
 *
 * Verifies that extractEntitiesWithLLM() emits the correct decision trace
 * events at each extraction stage, respecting verbosity settings.
 *
 * Decision trace events tested:
 *   - extraction_strategy_resolved: per-field strategy resolution
 *   - extraction_attempt: pattern-only extraction results
 *   - extraction_parse_fallback: JSON parse failure with regex fallback
 *   - extraction_fallback: LLM failure with hybrid-to-pattern fallback
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RuntimeSession, ExecutorContext } from '../../services/execution/types.js';
import type { RoutingExecutor } from '../../services/execution/routing-executor.js';
import { FlowStepExecutor } from '../../services/execution/flow-step-executor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'test-session-1',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    callerContext: {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    },
    currentFlowStep: 'collect_info',
    llmClient: null,
    ...overrides,
  } as RuntimeSession;
}

function createMockLLMClient(response?: Record<string, unknown>) {
  const input = response || {};
  return {
    chatWithToolUse: vi.fn().mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-1', name: '_extract_entities', input }],
      stopReason: 'tool_use',
      rawContent: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
    }),
  };
}

function createFailingLLMClient() {
  return {
    chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

function createMalformedResponseLLMClient(responseText: string) {
  // Simulates LLM returning text instead of using the extraction tool
  return {
    chatWithToolUse: vi.fn().mockResolvedValue({
      text: responseText,
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
    }),
  };
}

function createFlowStepExecutor(): FlowStepExecutor {
  const mockCtx = {} as ExecutorContext;
  const mockRouting = {} as RoutingExecutor;
  return new FlowStepExecutor(mockCtx, mockRouting);
}

type TraceEvent = { type: string; data: Record<string, unknown> };

function collectTraceEvents(): { events: TraceEvent[]; handler: (e: TraceEvent) => void } {
  const events: TraceEvent[] = [];
  const handler = (e: TraceEvent) => events.push(e);
  return { events, handler };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extraction decision traces', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = createFlowStepExecutor();
  });

  // -------------------------------------------------------------------------
  // extraction_strategy_resolved
  // -------------------------------------------------------------------------
  describe('extraction_strategy_resolved', () => {
    test('emits with correct field/source info when verbosity is verbose', async () => {
      const llmClient = createMockLLMClient({ full_name: 'John' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM(
        'My name is John',
        ['full_name', 'email'],
        session,
        handler,
        [
          { name: 'full_name', type: 'string', strategy: 'llm' },
          { name: 'email', type: 'string', strategy: 'pattern' },
        ],
      );

      const strategyEvent = events.find((e) => e.type === 'extraction_strategy_resolved');
      expect(strategyEvent).toBeDefined();
      const fields = strategyEvent!.data.fields as Record<
        string,
        { strategy: string; source: string }
      >;
      expect(fields.full_name).toEqual({ strategy: 'llm', source: 'field' });
      expect(fields.email).toEqual({ strategy: 'pattern', source: 'field' });
    });

    test('reports block-level strategy source when no per-field override', async () => {
      const llmClient = createMockLLMClient({ name: 'Alice' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM(
        'My name is Alice',
        ['name'],
        session,
        handler,
        [{ name: 'name', type: 'string' }], // no per-field strategy
        'llm', // block-level strategy
      );

      const strategyEvent = events.find((e) => e.type === 'extraction_strategy_resolved');
      expect(strategyEvent).toBeDefined();
      const fields = strategyEvent!.data.fields as Record<
        string,
        { strategy: string; source: string }
      >;
      expect(fields.name).toEqual({ strategy: 'llm', source: 'block' });
    });

    test('reports default source when no per-field or block strategy', async () => {
      const llmClient = createMockLLMClient({ name: 'Bob' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM(
        'My name is Bob',
        ['name'],
        session,
        handler,
        [{ name: 'name', type: 'string' }], // no per-field strategy
        // no block-level strategy either
      );

      const strategyEvent = events.find((e) => e.type === 'extraction_strategy_resolved');
      expect(strategyEvent).toBeDefined();
      const fields = strategyEvent!.data.fields as Record<
        string,
        { strategy: string; source: string }
      >;
      expect(fields.name).toEqual({ strategy: 'hybrid', source: 'default' });
    });

    test('is NOT emitted at standard verbosity', async () => {
      const llmClient = createMockLLMClient({ name: 'Alice' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'standard',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is Alice', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'llm' },
      ]);

      const strategyEvent = events.find((e) => e.type === 'extraction_strategy_resolved');
      expect(strategyEvent).toBeUndefined();
    });

    test('is NOT emitted at minimal verbosity', async () => {
      const llmClient = createMockLLMClient({ name: 'Alice' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'minimal',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is Alice', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'llm' },
      ]);

      const strategyEvent = events.find((e) => e.type === 'extraction_strategy_resolved');
      expect(strategyEvent).toBeUndefined();
    });

    test('is emitted at debug verbosity', async () => {
      const llmClient = createMockLLMClient({ name: 'Alice' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'debug',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is Alice', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'llm' },
      ]);

      const strategyEvent = events.find((e) => e.type === 'extraction_strategy_resolved');
      expect(strategyEvent).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // extraction_attempt
  // -------------------------------------------------------------------------
  describe('extraction_attempt', () => {
    test('emits for pattern-only fields with matched/missed breakdown', async () => {
      const llmClient = createMockLLMClient();
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      // Use a single field so the regex fallback assigns raw input as a match
      await executor.extractEntitiesWithLLM('New York', ['destination'], session, handler, [
        { name: 'destination', type: 'string', strategy: 'pattern' },
      ]);

      const attemptEvent = events.find((e) => e.type === 'extraction_attempt');
      expect(attemptEvent).toBeDefined();
      expect(attemptEvent!.data.method).toBe('pattern');
      expect(attemptEvent!.data.fields).toEqual(['destination']);
      // Single-field pattern extraction assigns raw input
      expect((attemptEvent!.data.matched as string[]).length).toBeGreaterThan(0);
    });

    test('emits with missed fields when pattern extraction finds nothing', async () => {
      const llmClient = createMockLLMClient();
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      // Multi-field with no heuristic match: both should be missed
      await executor.extractEntitiesWithLLM('hello world', ['email', 'phone'], session, handler, [
        { name: 'email', type: 'string', strategy: 'pattern' },
        { name: 'phone', type: 'string', strategy: 'pattern' },
      ]);

      const attemptEvent = events.find((e) => e.type === 'extraction_attempt');
      expect(attemptEvent).toBeDefined();
      expect(attemptEvent!.data.method).toBe('pattern');
      expect(attemptEvent!.data.fields).toEqual(['email', 'phone']);
      expect(attemptEvent!.data.missed).toContain('email');
      expect(attemptEvent!.data.missed).toContain('phone');
    });

    test('is NOT emitted when there are no pattern-only fields', async () => {
      const llmClient = createMockLLMClient({ name: 'Alice' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is Alice', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'llm' },
      ]);

      const attemptEvent = events.find((e) => e.type === 'extraction_attempt');
      expect(attemptEvent).toBeUndefined();
    });

    test('is NOT emitted at standard verbosity', async () => {
      const llmClient = createMockLLMClient();
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'standard',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM(
        'my email is test@example.com',
        ['email'],
        session,
        handler,
        [{ name: 'email', type: 'string', strategy: 'pattern' }],
      );

      const attemptEvent = events.find((e) => e.type === 'extraction_attempt');
      expect(attemptEvent).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // extraction_parse_fallback
  // -------------------------------------------------------------------------
  describe('extraction_parse_fallback', () => {
    test('emits when LLM returns text instead of using extraction tool', async () => {
      // LLM returns text with embedded JSON instead of using the extraction tool
      const llmClient = createMalformedResponseLLMClient('Here is the result: {"name": "John"}');
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is John', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'llm' },
      ]);

      const fallbackEvent = events.find((e) => e.type === 'extraction_parse_fallback');
      expect(fallbackEvent).toBeDefined();
      expect(fallbackEvent!.data.toolCallUsed).toBe(false);
      expect(fallbackEvent!.data.responsePreview).toBeDefined();
    });

    test('emits for non-JSON text with no extractable content', async () => {
      // LLM returns completely non-JSON text with no extractable JSON
      const llmClient = createMalformedResponseLLMClient(
        'I cannot extract any information from the input.',
      );
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is John', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'hybrid' },
      ]);

      const fallbackEvent = events.find((e) => e.type === 'extraction_parse_fallback');
      expect(fallbackEvent).toBeDefined();
      expect(fallbackEvent!.data.toolCallUsed).toBe(false);
    });

    test('is NOT emitted when JSON parses successfully on first try', async () => {
      const llmClient = createMockLLMClient({ name: 'John' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is John', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'llm' },
      ]);

      const fallbackEvent = events.find((e) => e.type === 'extraction_parse_fallback');
      expect(fallbackEvent).toBeUndefined();
    });

    test('is NOT emitted at standard verbosity', async () => {
      const llmClient = createMalformedResponseLLMClient('Here is the result: {"name": "John"}');
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'standard',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('My name is John', ['name'], session, handler, [
        { name: 'name', type: 'string', strategy: 'llm' },
      ]);

      const fallbackEvent = events.find((e) => e.type === 'extraction_parse_fallback');
      expect(fallbackEvent).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // extraction_fallback
  // -------------------------------------------------------------------------
  describe('extraction_fallback', () => {
    test('emits when LLM fails for hybrid fields', async () => {
      const llmClient = createFailingLLMClient();
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM(
        'test@example.com',
        ['email', 'name'],
        session,
        handler,
        [
          { name: 'email', type: 'string', strategy: 'hybrid' },
          { name: 'name', type: 'string', strategy: 'hybrid' },
        ],
      );

      const fallbackEvent = events.find((e) => e.type === 'extraction_fallback');
      expect(fallbackEvent).toBeDefined();
      expect(fallbackEvent!.data.fields).toEqual(['email', 'name']);
      expect(fallbackEvent!.data.from).toBe('llm');
      expect(fallbackEvent!.data.to).toBe('pattern');
      expect(fallbackEvent!.data.reason).toBe('llm_error');
    });

    test('includes only hybrid fields (not llm-only or pattern) in the fallback event', async () => {
      const llmClient = createFailingLLMClient();
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM(
        'test@example.com, John Smith',
        ['email', 'full_name', 'phone'],
        session,
        handler,
        [
          { name: 'email', type: 'string', strategy: 'pattern' },
          { name: 'full_name', type: 'string', strategy: 'llm' },
          { name: 'phone', type: 'string', strategy: 'hybrid' },
        ],
      );

      const fallbackEvent = events.find((e) => e.type === 'extraction_fallback');
      expect(fallbackEvent).toBeDefined();
      // Only hybrid fields fall back to pattern — not pattern-only or llm-only
      expect(fallbackEvent!.data.fields).toEqual(['phone']);
    });

    test('is NOT emitted at standard verbosity', async () => {
      const llmClient = createFailingLLMClient();
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'standard',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('test@example.com', ['email'], session, handler, [
        { name: 'email', type: 'string', strategy: 'hybrid' },
      ]);

      const fallbackEvent = events.find((e) => e.type === 'extraction_fallback');
      expect(fallbackEvent).toBeUndefined();
    });

    test('is NOT emitted when LLM succeeds (no fallback needed)', async () => {
      const llmClient = createMockLLMClient({ email: 'test@example.com' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });
      const { events, handler } = collectTraceEvents();

      await executor.extractEntitiesWithLLM('test@example.com', ['email'], session, handler, [
        { name: 'email', type: 'string', strategy: 'hybrid' },
      ]);

      const fallbackEvent = events.find((e) => e.type === 'extraction_fallback');
      expect(fallbackEvent).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Combined: no traces without onTraceEvent callback
  // -------------------------------------------------------------------------
  describe('no trace handler', () => {
    test('does not throw when onTraceEvent is undefined', async () => {
      const llmClient = createMockLLMClient({ name: 'Alice' });
      const session = createMockSession({
        llmClient: llmClient as any,
        traceVerbosity: 'verbose',
      });

      // Should not throw even without a trace handler
      const result = await executor.extractEntitiesWithLLM(
        'My name is Alice',
        ['name'],
        session,
        undefined, // no trace handler
        [{ name: 'name', type: 'string', strategy: 'llm' }],
      );

      expect(result.name).toBe('Alice');
    });
  });
});
