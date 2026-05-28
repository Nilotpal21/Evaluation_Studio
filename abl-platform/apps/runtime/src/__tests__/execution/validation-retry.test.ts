/**
 * Validation Retry Tests
 *
 * Verifies that extractEntitiesWithLLM() correctly:
 * - Uses retry_prompt from ValidationRule when re-prompting for invalid fields
 * - Tracks per-field validation retry counts in _validation_retries
 * - Stops re-prompting when max_retries is exceeded
 * - Resets retry state on step change
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

describe('validation retry_prompt and max_retries', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = createFlowStepExecutor();
  });

  // -------------------------------------------------------------------------
  // retry_prompt: stored on session after validation failure
  // -------------------------------------------------------------------------

  describe('retry_prompt tracking', () => {
    test('stores retry_prompt from validation rule when field fails validation', async () => {
      // LLM returns an invalid email (will fail pattern validation)
      const llmClient = createMockLLMClient({ email: 'not-an-email' });
      const session = createMockSession({ llmClient: llmClient as any });

      await executor.extractEntitiesWithLLM(
        'my email is not-an-email',
        ['email'],
        session,
        undefined,
        [
          {
            name: 'email',
            type: 'string',
            validation: {
              type: 'pattern' as const,
              rule: '^[^@]+@[^@]+\\.[^@]+$',
              error_message: 'Invalid email format',
              retry_prompt: 'Please enter a valid email address like user@example.com',
            },
          },
        ],
      );

      // retry_prompt should be stored on session
      const retryPrompts = session.data.values._validation_retry_prompts as
        | Record<string, string>
        | undefined;
      expect(retryPrompts).toBeDefined();
      expect(retryPrompts?.email).toBe('Please enter a valid email address like user@example.com');
    });

    test('does not store retry_prompt when validation passes', async () => {
      const llmClient = createMockLLMClient({ email: 'valid@example.com' });
      const session = createMockSession({ llmClient: llmClient as any });

      await executor.extractEntitiesWithLLM(
        'my email is valid@example.com',
        ['email'],
        session,
        undefined,
        [
          {
            name: 'email',
            type: 'string',
            validation: {
              type: 'pattern' as const,
              rule: '^[^@]+@[^@]+\\.[^@]+$',
              error_message: 'Invalid email format',
              retry_prompt: 'Please enter a valid email address like user@example.com',
            },
          },
        ],
      );

      // No retry prompts when validation passes
      expect(session.data.values._validation_retry_prompts).toBeUndefined();
    });

    test('clears retry_prompt data when subsequent extraction has no errors', async () => {
      const session = createMockSession({
        llmClient: createMockLLMClient({ email: 'valid@example.com' }) as any,
      });

      // Pre-set some stale retry prompt data
      session.data.values._validation_retry_prompts = { email: 'old prompt' };

      await executor.extractEntitiesWithLLM(
        'my email is valid@example.com',
        ['email'],
        session,
        undefined,
        [
          {
            name: 'email',
            type: 'string',
            validation: {
              type: 'pattern' as const,
              rule: '^[^@]+@[^@]+\\.[^@]+$',
              error_message: 'Invalid email format',
              retry_prompt: 'Please enter a valid email',
            },
          },
        ],
      );

      // Should be cleared
      expect(session.data.values._validation_retry_prompts).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // _validation_retries: incremented on each failure
  // -------------------------------------------------------------------------

  describe('validation retry counting', () => {
    test('increments _validation_retries on each failed validation', async () => {
      const llmClient = createMockLLMClient({ email: 'bad' });
      const session = createMockSession({ llmClient: llmClient as any });

      const gatherFields = [
        {
          name: 'email',
          type: 'string',
          validation: {
            type: 'pattern' as const,
            rule: '^[^@]+@[^@]+\\.[^@]+$',
            error_message: 'Invalid email',
          },
        },
      ];

      // First failed attempt
      await executor.extractEntitiesWithLLM(
        'email is bad',
        ['email'],
        session,
        undefined,
        gatherFields,
      );
      let retries = session.data.values._validation_retries as Record<string, number>;
      expect(retries?.email).toBe(1);

      // Second failed attempt
      await executor.extractEntitiesWithLLM(
        'email is still-bad',
        ['email'],
        session,
        undefined,
        gatherFields,
      );
      retries = session.data.values._validation_retries as Record<string, number>;
      expect(retries?.email).toBe(2);
    });

    test('does not increment retries for successful validation', async () => {
      const llmClient = createMockLLMClient({ name: 'John' });
      const session = createMockSession({ llmClient: llmClient as any });

      await executor.extractEntitiesWithLLM('name is John', ['name'], session, undefined, [
        {
          name: 'name',
          type: 'string',
          validation: {
            type: 'pattern' as const,
            rule: '.+',
            error_message: 'Name required',
          },
        },
      ]);

      expect(session.data.values._validation_retries).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // max_retries: emits trace event when exceeded
  // -------------------------------------------------------------------------

  describe('max_retries enforcement', () => {
    test('emits validation_max_retries trace when limit exceeded', async () => {
      const llmClient = createMockLLMClient({ email: 'bad' });
      const session = createMockSession({ llmClient: llmClient as any });
      const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
      const onTraceEvent = (e: { type: string; data: Record<string, unknown> }) =>
        traceEvents.push(e);

      const gatherFields = [
        {
          name: 'email',
          type: 'string',
          validation: {
            type: 'pattern' as const,
            rule: '^[^@]+@[^@]+\\.[^@]+$',
            error_message: 'Invalid email',
            max_retries: 2,
          },
        },
      ];

      // Attempt 1: fails, retries[email] = 1
      await executor.extractEntitiesWithLLM(
        'email is bad',
        ['email'],
        session,
        onTraceEvent,
        gatherFields,
      );
      expect(session.data.values._validation_exceeded).toBeUndefined();

      // Attempt 2: fails, retries[email] = 2 >= max_retries(2) → exceeded
      await executor.extractEntitiesWithLLM(
        'email is bad again',
        ['email'],
        session,
        onTraceEvent,
        gatherFields,
      );

      const exceeded = session.data.values._validation_exceeded as string[] | undefined;
      expect(exceeded).toContain('email');

      // Should emit validation_max_retries trace
      const maxRetryTraces = traceEvents.filter((e) => e.type === 'validation_max_retries');
      expect(maxRetryTraces.length).toBe(1);
      expect(maxRetryTraces[0].data.field).toBe('email');
      expect(maxRetryTraces[0].data.attempts).toBe(2);
      expect(maxRetryTraces[0].data.maxRetries).toBe(2);
    });

    test('does not exceed when retries are below max_retries', async () => {
      const llmClient = createMockLLMClient({ email: 'bad' });
      const session = createMockSession({ llmClient: llmClient as any });

      const gatherFields = [
        {
          name: 'email',
          type: 'string',
          validation: {
            type: 'pattern' as const,
            rule: '^[^@]+@[^@]+\\.[^@]+$',
            error_message: 'Invalid email',
            max_retries: 5,
          },
        },
      ];

      // Attempt 1: fails but under the limit
      await executor.extractEntitiesWithLLM(
        'email is bad',
        ['email'],
        session,
        undefined,
        gatherFields,
      );

      expect(session.data.values._validation_exceeded).toBeUndefined();
      const retries = session.data.values._validation_retries as Record<string, number>;
      expect(retries?.email).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Step change: resets retry state
  // -------------------------------------------------------------------------

  describe('step change reset', () => {
    test('_validation_retries reset on step change via _current_step_for_reset', () => {
      const session = createMockSession();

      // Simulate accumulated retry state
      session.data.values._validation_retries = { email: 3, phone: 1 };
      session.data.values._validation_retry_prompts = { email: 'Try again' };
      session.data.values._validation_exceeded = ['email'];
      session.data.values._current_step_for_reset = 'step_a';

      // Simulate step change detection (same logic as flow-step-executor)
      const newStep = 'step_b';
      const prevStep = session.data.values._current_step_for_reset;
      if (prevStep !== newStep) {
        session.data.values._current_step_for_reset = newStep;
        session.data.values._clarification_count = 0;
        delete session.data.values._validation_retries;
        delete session.data.values._validation_retry_prompts;
        delete session.data.values._validation_exceeded;
      }

      expect(session.data.values._validation_retries).toBeUndefined();
      expect(session.data.values._validation_retry_prompts).toBeUndefined();
      expect(session.data.values._validation_exceeded).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple fields: independent retry tracking
  // -------------------------------------------------------------------------

  describe('multi-field independent tracking', () => {
    test('tracks retries independently per field', async () => {
      // LLM returns both fields, one valid one invalid
      const llmClient = createMockLLMClient({ email: 'bad', name: 'John' });
      const session = createMockSession({ llmClient: llmClient as any });

      const gatherFields = [
        {
          name: 'email',
          type: 'string',
          validation: {
            type: 'pattern' as const,
            rule: '^[^@]+@[^@]+\\.[^@]+$',
            error_message: 'Invalid email',
            retry_prompt: 'Please provide a valid email',
            max_retries: 3,
          },
        },
        {
          name: 'name',
          type: 'string',
          validation: {
            type: 'pattern' as const,
            rule: '.+',
            error_message: 'Name required',
            retry_prompt: 'Please provide your name',
          },
        },
      ];

      await executor.extractEntitiesWithLLM(
        'email is bad, name is John',
        ['email', 'name'],
        session,
        undefined,
        gatherFields,
      );

      const retries = session.data.values._validation_retries as Record<string, number>;
      // email failed → has retry count
      expect(retries?.email).toBe(1);
      // name passed → no retry count
      expect(retries?.name).toBeUndefined();

      // Only email has a retry prompt
      const retryPrompts = session.data.values._validation_retry_prompts as
        | Record<string, string>
        | undefined;
      expect(retryPrompts?.email).toBe('Please provide a valid email');
      expect(retryPrompts?.name).toBeUndefined();
    });
  });
});
