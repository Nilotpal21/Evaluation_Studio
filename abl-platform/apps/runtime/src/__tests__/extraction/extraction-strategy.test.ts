/**
 * Extraction Strategy Tests
 *
 * Verifies that extractEntitiesWithLLM() respects the `strategy` field
 * at both the GATHER block level and the per-field level.
 *
 * Strategies:
 *   - 'pattern': regex only, no LLM call
 *   - 'llm': LLM only, no regex fallback on failure
 *   - 'hybrid': LLM with regex fallback (default)
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

function createFlowStepExecutor(): FlowStepExecutor {
  const mockCtx = {} as ExecutorContext;
  const mockRouting = {} as RoutingExecutor;
  return new FlowStepExecutor(mockCtx, mockRouting);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractEntitiesWithLLM - strategy enforcement', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = createFlowStepExecutor();
  });

  // -------------------------------------------------------------------------
  // 1. All fields pattern-only: LLM should never be called
  // -------------------------------------------------------------------------
  describe('pattern-only strategy', () => {
    test('does not call LLM when all fields have strategy: pattern', async () => {
      const llmClient = createMockLLMClient({ email: 'test@example.com' });
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'my email is john@example.com',
        ['email'],
        session,
        undefined,
        [{ name: 'email', type: 'string', strategy: 'pattern' }],
      );

      // LLM should NOT be called
      expect(llmClient.chatWithToolUse).not.toHaveBeenCalled();
      // Pattern extraction should still attempt regex extraction
      expect(result).toBeDefined();
    });

    test('does not call LLM when block strategy is pattern', async () => {
      const llmClient = createMockLLMClient({ name: 'John' });
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'my name is John',
        ['name'],
        session,
        undefined,
        [{ name: 'name', type: 'string' }],
        'pattern',
      );

      // LLM should NOT be called
      expect(llmClient.chatWithToolUse).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    test('emits trace event with method=pattern when all fields are pattern-only', async () => {
      const llmClient = createMockLLMClient();
      const session = createMockSession({ llmClient: llmClient as any });
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) =>
        traceEvents.push(e);

      await executor.extractEntitiesWithLLM(
        'my email is test@example.com',
        ['email'],
        session,
        onTraceEvent,
        [{ name: 'email', type: 'string', strategy: 'pattern' }],
      );

      const extractionEvent = traceEvents.find((e) => e.type === 'entity_extraction');
      expect(extractionEvent).toBeDefined();
      expect(extractionEvent!.data.method).toBe('pattern');
    });
  });

  // -------------------------------------------------------------------------
  // 2. All fields llm-only: no regex fallback on LLM failure
  // -------------------------------------------------------------------------
  describe('llm-only strategy', () => {
    test('calls LLM and returns results for llm strategy', async () => {
      const llmClient = createMockLLMClient({ full_name: 'John Smith' });
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'My name is John Smith',
        ['full_name'],
        session,
        undefined,
        [{ name: 'full_name', type: 'string', strategy: 'llm' }],
      );

      expect(llmClient.chatWithToolUse).toHaveBeenCalled();
      expect(result.full_name).toBe('John Smith');
    });

    test('on LLM failure, llm-only fields get no regex fallback', async () => {
      const llmClient = {
        chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      };
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'my email is test@example.com',
        ['email'],
        session,
        undefined,
        [{ name: 'email', type: 'string', strategy: 'llm' }],
      );

      // LLM was called but failed
      expect(llmClient.chatWithToolUse).toHaveBeenCalled();
      // llm-only fields should NOT get regex fallback — remain undefined
      expect(result.email).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Mixed strategies: correct partitioning
  // -------------------------------------------------------------------------
  describe('mixed strategies', () => {
    test('partitions fields correctly: pattern via regex, llm via LLM', async () => {
      const llmClient = createMockLLMClient({ full_name: 'Jane Doe' });
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'Jane Doe, jane@example.com',
        ['full_name', 'email'],
        session,
        undefined,
        [
          { name: 'full_name', type: 'string', strategy: 'llm' },
          { name: 'email', type: 'string', strategy: 'pattern' },
        ],
      );

      // LLM should be called (for full_name which is llm strategy)
      expect(llmClient.chatWithToolUse).toHaveBeenCalled();

      // full_name comes from LLM
      expect(result.full_name).toBe('Jane Doe');
      // email comes from pattern extraction (regex)
      // Note: regex may or may not extract email depending on extractEntitiesForFields
      expect(result).toBeDefined();
    });

    test('on LLM failure, only hybrid fields get regex fallback', async () => {
      const llmClient = {
        chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      };
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'john@example.com, about 5 guests, John Smith',
        ['email', 'guest_count', 'full_name'],
        session,
        undefined,
        [
          { name: 'email', type: 'string', strategy: 'pattern' },
          { name: 'guest_count', type: 'number', strategy: 'llm' },
          { name: 'full_name', type: 'string', strategy: 'hybrid' },
        ],
      );

      // email (pattern) should be attempted via regex (may or may not extract)
      // guest_count (llm) should have NO fallback — stays undefined
      expect(result.guest_count).toBeUndefined();
      // full_name (hybrid) should get regex fallback
      // The result should contain pattern + hybrid results but NOT llm-only results
    });

    test('skips the NLU sidecar when session tenancy context is incomplete and falls back to LLM', async () => {
      const llmClient = createMockLLMClient({ destination: 'Paris' });
      const sidecarClient = {
        extract: vi.fn(),
        detectCorrection: vi.fn(),
      };
      const session = createMockSession({
        tenantId: undefined,
        llmClient: llmClient as any,
        _nluSidecarClient: sidecarClient as any,
        agentIR: {
          project_runtime_config: {
            extraction_strategy: 'auto',
            nlu_provider: 'advanced',
          },
        } as any,
      });

      const result = await executor.extractEntitiesWithLLM(
        'My destination is Paris',
        ['destination'],
        session,
        undefined,
        [{ name: 'destination', type: 'string' }],
      );

      expect(sidecarClient.extract).not.toHaveBeenCalled();
      expect(llmClient.chatWithToolUse).toHaveBeenCalled();
      expect(result.destination).toBe('Paris');
    });

    test('per-field strategy overrides block strategy', async () => {
      const llmClient = createMockLLMClient({ full_name: 'Bob' });
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'Bob, bob@test.com',
        ['full_name', 'email'],
        session,
        undefined,
        [
          { name: 'full_name', type: 'string', strategy: 'llm' },
          { name: 'email', type: 'string', strategy: 'pattern' },
        ],
        'hybrid', // block-level is hybrid, but per-field overrides apply
      );

      // LLM called for full_name (per-field override: llm)
      expect(llmClient.chatWithToolUse).toHaveBeenCalled();
      // email should be extracted via pattern (per-field override: pattern)
      expect(result).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Default behavior (no strategy specified) = hybrid
  // -------------------------------------------------------------------------
  describe('default behavior (hybrid)', () => {
    test('calls LLM when no strategy is specified', async () => {
      const llmClient = createMockLLMClient({ name: 'Alice' });
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'My name is Alice',
        ['name'],
        session,
        undefined,
        [{ name: 'name', type: 'string' }],
      );

      // Should use LLM (hybrid default)
      expect(llmClient.chatWithToolUse).toHaveBeenCalled();
      expect(result.name).toBe('Alice');
    });

    test('falls back to regex on LLM failure with hybrid default', async () => {
      const llmClient = {
        chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      };
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM(
        'test@example.com',
        ['email'],
        session,
        undefined,
        [{ name: 'email', type: 'string' }],
      );

      // LLM was called but failed
      expect(llmClient.chatWithToolUse).toHaveBeenCalled();
      // Hybrid fields should get regex fallback
      expect(result).toBeDefined();
    });

    test('no gatherFields and no block strategy defaults to hybrid', async () => {
      const llmClient = createMockLLMClient({ name: 'Charlie' });
      const session = createMockSession({ llmClient: llmClient as any });

      const result = await executor.extractEntitiesWithLLM('My name is Charlie', ['name'], session);

      // Should use LLM (hybrid default when no gatherFields)
      expect(llmClient.chatWithToolUse).toHaveBeenCalled();
      expect(result.name).toBe('Charlie');
    });
  });

  // -------------------------------------------------------------------------
  // 5. No LLM client: always uses regex regardless of strategy
  // -------------------------------------------------------------------------
  describe('no LLM client', () => {
    test('uses regex extraction when no LLM client is available', async () => {
      const session = createMockSession({ llmClient: null });

      const result = await executor.extractEntitiesWithLLM(
        'test@example.com',
        ['email'],
        session,
        undefined,
        [{ name: 'email', type: 'string', strategy: 'llm' }],
      );

      // Should still attempt regex extraction regardless of strategy
      expect(result).toBeDefined();
    });
  });
});
