/**
 * Tests for enhanced correction detection with LLM fallback
 * and dependent field invalidation.
 *
 * Covers:
 * - Regex correction detected and applied (existing detectCorrection works)
 * - LLM correction detected when regex fails (mock LLM returns {field, newValue})
 * - Dependent fields invalidated on correction (field B depends on A, correct A -> B deleted)
 * - Transitive dependent invalidation (A->B->C, correct A -> B and C deleted)
 * - LLM correction failure is non-blocking (mock LLM throws -> returns null)
 * - No correction detected -> null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowStepExecutor } from '../services/execution/flow-step-executor.js';
import { deleteSessionValue } from '../services/execution/types.js';
import type { RuntimeSession } from '../services/execution/types.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal RuntimeSession with the fields the correction logic
// needs. Uses `as any` for brevity — unit tests for internal methods.
// ---------------------------------------------------------------------------
function buildSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'test-session',
    agentName: 'test-agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: true,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    ...overrides,
  } as RuntimeSession;
}

// ---------------------------------------------------------------------------
// Helper: build a FlowStepExecutor with minimal context (only used for
// accessing private methods via prototype hacks in these tests).
// ---------------------------------------------------------------------------
function buildExecutor(): FlowStepExecutor {
  const ctx = {
    debouncedPersist: vi.fn(),
    config: {},
    sessions: new Map(),
    agentRegistry: {},
    executeMessage: vi.fn(),
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((t: string) => t),
  } as any;

  const routing = {
    checkHandoffConditions: vi.fn().mockResolvedValue(null),
    checkCompletionConditions: vi.fn().mockReturnValue(null),
  } as any;

  return new FlowStepExecutor(ctx, routing);
}

// ---------------------------------------------------------------------------
// Access private methods for unit testing
// ---------------------------------------------------------------------------
function callDetectCorrectionWithLLM(
  executor: FlowStepExecutor,
  userMessage: string,
  session: RuntimeSession,
  gatherFields?: Array<{ name: string; depends_on?: string[] }>,
) {
  // Access private method via bracket notation
  return (executor as any).detectCorrectionWithLLM(userMessage, session, gatherFields);
}

function callInvalidateDependentFields(
  executor: FlowStepExecutor,
  correctedField: string,
  gatherFields: Array<{ name: string; depends_on?: string[] }> | undefined,
  session: RuntimeSession,
) {
  return (executor as any).invalidateDependentFields(correctedField, gatherFields, session);
}

// =============================================================================
// detectCorrectionWithLLM
// =============================================================================

describe('detectCorrectionWithLLM', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = buildExecutor();
  });

  it('returns null when no LLM client is available', async () => {
    const session = buildSession();
    // No llmClient set
    const result = await callDetectCorrectionWithLLM(executor, 'actually 5 guests', session);
    expect(result).toBeNull();
  });

  it('returns null when no values are collected', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn(),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    // data.values is empty (only internal keys)

    const result = await callDetectCorrectionWithLLM(executor, 'actually 5 guests', session);
    expect(result).toBeNull();
    expect(mockLlm.chatWithToolUse).not.toHaveBeenCalled();
  });

  it('detects a correction when LLM returns valid JSON', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '{"field": "num_guests", "newValue": "5"}',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.num_guests = 3;
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(
      executor,
      'actually I need 5 guests not 3',
      session,
      [{ name: 'num_guests' }, { name: 'destination' }],
    );

    expect(result).toEqual({
      field: 'num_guests',
      newValue: '5',
      oldValue: 3,
    });
    expect(mockLlm.chatWithToolUse).toHaveBeenCalledOnce();
  });

  it('returns null when LLM says null', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: 'null',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(
      executor,
      'I love Paris in the spring',
      session,
    );
    expect(result).toBeNull();
  });

  it('returns null when LLM returns field not in collected values', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '{"field": "unknown_field", "newValue": "abc"}',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(executor, 'change x to abc', session);
    expect(result).toBeNull();
  });

  it('returns null on LLM failure (non-blocking)', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM service down')),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(
      executor,
      'actually change destination to London',
      session,
    );
    expect(result).toBeNull();
  });

  it('handles LLM returning JSON in markdown code block', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '```json\n{"field": "destination", "newValue": "London"}\n```',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(executor, 'I meant London not Paris', session);

    expect(result).toEqual({
      field: 'destination',
      newValue: 'London',
      oldValue: 'Paris',
    });
  });

  it('returns null when LLM returns malformed response', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: 'I think the user might be correcting something but not sure',
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(executor, 'actually I meant London', session);
    expect(result).toBeNull();
  });

  it('returns null when LLM returns JSON without required fields', async () => {
    const mockLlm = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '{"field": "destination"}', // missing newValue
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values.destination = 'Paris';

    const result = await callDetectCorrectionWithLLM(executor, 'change destination', session);
    expect(result).toBeNull();
  });

  it('filters out internal fields from context sent to LLM', async () => {
    let capturedSystemPrompt = '';
    const mockLlm = {
      chatWithToolUse: vi.fn().mockImplementation((systemPrompt: string) => {
        capturedSystemPrompt = systemPrompt;
        return Promise.resolve({ text: 'null' });
      }),
    };
    const session = buildSession({ llmClient: mockLlm as any });
    session.data.values._clarification_count = 3;
    session.data.values._raw_input = 'test';
    session.data.values.last_tool_result = {};
    session.data.values.destination = 'Paris';

    await callDetectCorrectionWithLLM(executor, 'some message', session);

    // Internal fields should not appear in the prompt
    expect(capturedSystemPrompt).toContain('destination');
    expect(capturedSystemPrompt).not.toContain('_clarification_count');
    expect(capturedSystemPrompt).not.toContain('_raw_input');
    expect(capturedSystemPrompt).not.toContain('last_tool_result');
  });
});

// =============================================================================
// invalidateDependentFields
// =============================================================================

describe('invalidateDependentFields', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = buildExecutor();
  });

  it('returns empty array when no gather fields provided', () => {
    const session = buildSession();
    session.data.values.a = 'val_a';

    const result = callInvalidateDependentFields(executor, 'a', undefined, session);
    expect(result).toEqual([]);
  });

  it('returns empty array when no fields depend on corrected field', () => {
    const session = buildSession();
    session.data.values.a = 'val_a';
    session.data.values.b = 'val_b';

    const gatherFields = [{ name: 'a' }, { name: 'b' }];

    const result = callInvalidateDependentFields(executor, 'a', gatherFields, session);
    expect(result).toEqual([]);
    // Both values should still be present
    expect(session.data.values.a).toBe('val_a');
    expect(session.data.values.b).toBe('val_b');
  });

  it('invalidates direct dependent field', () => {
    const session = buildSession();
    session.data.values.city = 'Paris';
    session.data.values.hotel = 'Grand Hotel Paris';
    session.data.gatheredKeys.add('city');
    session.data.gatheredKeys.add('hotel');

    const gatherFields = [{ name: 'city' }, { name: 'hotel', depends_on: ['city'] }];

    const result = callInvalidateDependentFields(executor, 'city', gatherFields, session);

    expect(result).toEqual(['hotel']);
    expect(session.data.values.hotel).toBeUndefined();
    expect(session.data.gatheredKeys.has('hotel')).toBe(false);
    // Corrected field itself should NOT be invalidated
    expect(session.data.values.city).toBe('Paris');
  });

  it('invalidates transitive dependent fields (A -> B -> C)', () => {
    const session = buildSession();
    session.data.values.country = 'France';
    session.data.values.city = 'Paris';
    session.data.values.hotel = 'Grand Hotel';
    session.data.gatheredKeys.add('country');
    session.data.gatheredKeys.add('city');
    session.data.gatheredKeys.add('hotel');

    const gatherFields = [
      { name: 'country' },
      { name: 'city', depends_on: ['country'] },
      { name: 'hotel', depends_on: ['city'] },
    ];

    const result = callInvalidateDependentFields(executor, 'country', gatherFields, session);

    // Both city and hotel should be invalidated
    expect(result).toContain('city');
    expect(result).toContain('hotel');
    expect(result).toHaveLength(2);
    expect(session.data.values.city).toBeUndefined();
    expect(session.data.values.hotel).toBeUndefined();
    expect(session.data.gatheredKeys.has('city')).toBe(false);
    expect(session.data.gatheredKeys.has('hotel')).toBe(false);
    // Country itself should remain
    expect(session.data.values.country).toBe('France');
  });

  it('handles diamond dependency (A -> B, A -> C, B -> D, C -> D)', () => {
    const session = buildSession();
    session.data.values.a = 'a';
    session.data.values.b = 'b';
    session.data.values.c = 'c';
    session.data.values.d = 'd';
    session.data.gatheredKeys.add('a');
    session.data.gatheredKeys.add('b');
    session.data.gatheredKeys.add('c');
    session.data.gatheredKeys.add('d');

    const gatherFields = [
      { name: 'a' },
      { name: 'b', depends_on: ['a'] },
      { name: 'c', depends_on: ['a'] },
      { name: 'd', depends_on: ['b', 'c'] },
    ];

    const result = callInvalidateDependentFields(executor, 'a', gatherFields, session);

    // b, c, and d should all be invalidated (d via both b and c)
    expect(result).toContain('b');
    expect(result).toContain('c');
    expect(result).toContain('d');
    expect(result).toHaveLength(3);
    expect(session.data.values.b).toBeUndefined();
    expect(session.data.values.c).toBeUndefined();
    expect(session.data.values.d).toBeUndefined();
  });

  it('does not invalidate fields with no depends_on', () => {
    const session = buildSession();
    session.data.values.a = 'a';
    session.data.values.b = 'b';
    session.data.values.c = 'c';
    session.data.gatheredKeys.add('a');
    session.data.gatheredKeys.add('b');
    session.data.gatheredKeys.add('c');

    const gatherFields = [
      { name: 'a' },
      { name: 'b', depends_on: ['a'] },
      { name: 'c' }, // no depends_on
    ];

    const result = callInvalidateDependentFields(executor, 'a', gatherFields, session);

    expect(result).toEqual(['b']);
    expect(session.data.values.c).toBe('c'); // c should remain
  });

  it('handles empty gather fields array', () => {
    const session = buildSession();
    session.data.values.a = 'a';

    const result = callInvalidateDependentFields(executor, 'a', [], session);
    expect(result).toEqual([]);
  });
});

// =============================================================================
// Integration: correction flow with executeFlowStep
// =============================================================================

describe('correction flow integration', () => {
  it('regex correction is detected and applied with dependent invalidation', async () => {
    const executor = buildExecutor();
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const chunks: string[] = [];

    const session = buildSession();
    session.agentIR = {
      ir_version: '1.0',
      metadata: {
        name: 'test',
        version: '1.0',
        type: 'agent',
        compiled_at: '',
        source_hash: '',
        compiler_version: '',
      },
      execution: {
        mode: 'scripted',
        hints: {
          voice_optimized: false,
          requires_persistence: false,
          supports_hitl: false,
          parallel_tools: false,
          complexity: 'simple',
        },
        timeouts: { tool_timeout_ms: 30000, llm_timeout_ms: 30000, session_timeout_ms: 300000 },
      },
      identity: {
        goal: 'test',
        persona: 'test',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
      tools: [],
      gather: { fields: [], strategy: 'hybrid' },
      memory: { session: [], persistent: [], remember: [], recall: [] },
      constraints: { constraints: [], guardrails: [] },
      coordination: { delegates: [], handoffs: [] },
      completion: { conditions: [] },
      error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      flow: {
        steps: ['collect_info'],
        definitions: {
          collect_info: {
            name: 'collect_info',
            corrections: true,
            gather: {
              fields: [{ name: 'city' }, { name: 'hotel', depends_on: ['city'] }],
            },
            respond: 'Please provide your city and hotel.',
          },
        },
        entry_point: 'collect_info',
      },
    } as any;

    session.currentFlowStep = 'collect_info';
    session.data.values.city = 'Paris';
    session.data.values.hotel = 'Grand Hotel Paris';
    session.data.gatheredKeys.add('city');
    session.data.gatheredKeys.add('hotel');
    // Mark as waiting so the flow step doesn't try to re-collect
    session.waitingForInput = ['city'];

    // The regex pattern "actually X not Y" should match
    const result = await executor.executeFlowStep(
      session,
      'actually London not Paris',
      (chunk) => chunks.push(chunk),
      (event) => traceEvents.push(event),
    );

    // Verify a correction trace event was emitted
    const correctionEvent = traceEvents.find((e) => e.type === 'correction');
    expect(correctionEvent).toBeDefined();
    expect(correctionEvent!.data.field).toBe('city');

    // Verify the invalidation trace event
    const invalidationEvent = traceEvents.find((e) => e.type === 'correction_invalidation');
    expect(invalidationEvent).toBeDefined();
    expect(invalidationEvent!.data.invalidatedFields).toContain('hotel');

    // Hotel should be cleared from session
    expect(session.data.values.hotel).toBeUndefined();
    expect(session.data.gatheredKeys.has('hotel')).toBe(false);

    // Acknowledge message should mention invalidated field
    const ackChunk = chunks.find((c) => c.includes('Updated'));
    expect(ackChunk).toBeDefined();
    expect(ackChunk).toContain('hotel');
    expect(ackChunk).toContain('cleared');
  });
});
