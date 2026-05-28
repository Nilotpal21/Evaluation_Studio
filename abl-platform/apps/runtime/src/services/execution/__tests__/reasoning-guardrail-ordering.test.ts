import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests that output guardrails are evaluated BEFORE the response is committed
 * to conversation history and emitted via onChunk.
 *
 * Strategy: Mock the output-guardrails module and the LLM client, then
 * invoke ReasoningExecutor.execute() and verify ordering via side-effect capture.
 */

// Track ordering of operations
let operationLog: string[] = [];

// Mock output guardrails
vi.mock('../output-guardrails.js', () => ({
  checkOutputGuardrails: vi.fn().mockImplementation(async (text: string) => {
    operationLog.push(`guardrail:${text}`);
    return {
      passed: false,
      text,
      violation: {
        guardrailName: 'pii-check',
        action: 'block',
        message: 'Response blocked by guardrail.',
      },
    };
  }),
}));

// Mock pipeline factory
vi.mock('../../guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue({ passed: true }),
  })),
  resolveGuardrailPolicy: vi.fn().mockResolvedValue(undefined),
  createLLMEvalFromClient: vi.fn().mockReturnValue(vi.fn().mockResolvedValue('SAFE')),
}));

// Mock constraint checker
const mockCheckFlatConstraintsAtCheckpoint = vi.fn().mockReturnValue(null);
const mockSetCurrentTurnInputContext = vi.fn(
  (session: { data: { values: Record<string, unknown> } }, input: string, rawInput = input) => {
    session.data.values['input'] = input;
    session.data.values['_raw_input'] = rawInput;
  },
);

vi.mock('../constraint-checker.js', () => ({
  checkConstraints: vi.fn().mockReturnValue(null),
  checkFlatConstraints: vi.fn().mockReturnValue(null),
  checkFlatConstraintsAtCheckpoint: (...args: unknown[]) =>
    mockCheckFlatConstraintsAtCheckpoint(...args),
  handleConstraintViolation: vi.fn(),
  executeConstraintViolation: vi.fn(),
  setCurrentTurnInputContext: (
    session: { data: { values: Record<string, unknown> } },
    input: string,
    rawInput?: string,
  ) => mockSetCurrentTurnInputContext(session, input, rawInput),
}));

// Mock error-handler-router
vi.mock('../error-handler-router.js', () => ({
  resolveErrorHandler: vi.fn(),
  executeWithRetry: vi.fn(),
}));

// Mock prompt-builder
vi.mock('../prompt-builder.js', () => ({
  isVoiceChannel: vi.fn().mockReturnValue(false),
  buildSystemPrompt: vi.fn().mockReturnValue('system prompt'),
  buildTools: vi.fn().mockReturnValue([]),
}));

// Mock value-resolution
vi.mock('../value-resolution.js', () => ({
  getNestedValue: vi.fn(),
  interpolateTemplate: vi.fn(),
  resolveSetValue: vi.fn(),
}));

// Mock channel adapter
vi.mock('../../channel/channel-adapter.js', () => ({
  stripForVoice: vi.fn((s: string) => s),
}));

// Mock memory integration
vi.mock('../memory-integration.js', () => ({
  evaluateRememberAfterStateChange: vi.fn(),
  executeRecallAfterToolCall: vi.fn(),
  executeRecallAfterExtraction: vi.fn(),
  detectAndStorePreferences: vi.fn(),
}));

// Mock observability
vi.mock('../../../observability/metrics.js', () => ({
  recordToolCall: vi.fn(),
}));

// Mock types helpers
vi.mock('../types.js', async () => {
  const actual = await vi.importActual<object>('../types.js');
  return {
    ...actual,
    buildStateUpdates: vi.fn().mockReturnValue({}),
    getActiveThread: vi.fn().mockReturnValue({
      agentName: 'test-agent',
      conversationHistory: [],
    }),
  };
});

describe('Reasoning executor guardrail ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    operationLog = [];
    mockCheckFlatConstraintsAtCheckpoint.mockReset();
    mockCheckFlatConstraintsAtCheckpoint.mockReturnValue(null);
    mockSetCurrentTurnInputContext.mockClear();
  });

  it('evaluates output guardrails BEFORE pushing to history and calling onChunk', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');
    const { checkOutputGuardrails } = await import('../output-guardrails.js');

    mockCheckFlatConstraintsAtCheckpoint.mockImplementation((_session, checkpoint) => {
      operationLog.push(`constraint:${checkpoint.kind}`);
      return null;
    });

    // Create a mock session
    const conversationHistory: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'Hello' },
    ];

    // Wrap push to track when history is modified
    const originalPush = conversationHistory.push.bind(conversationHistory);
    conversationHistory.push = (...args: any[]) => {
      const content = args[0]?.content;
      operationLog.push(`history:${content}`);
      return originalPush(...args);
    };

    const session: any = {
      id: 'test-session',
      agentName: 'test-agent',
      agentIR: {
        execution: { mode: 'reasoning', max_iterations: 5 },
        constraints: {
          guardrails: [{ name: 'pii-check', kind: 'output', rules: [], priority: 1 }],
        },
        metadata: { name: 'test-agent' },
        routing: {},
      },
      compilationOutput: null,
      conversationHistory,
      state: { status: 'active' },
      data: { values: {} },
      isComplete: false,
      isEscalated: false,
      handoffStack: [],
      threads: [
        {
          agentName: 'test-agent',
          conversationHistory,
          status: 'active',
        },
      ],
      activeThreadIndex: 0,
      threadStack: [],
      initialized: true,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      llmClient: {
        chatWithToolUse: vi.fn().mockResolvedValue({
          text: 'Sensitive response with PII',
          toolCalls: [],
          rawContent: [{ type: 'text', text: 'Sensitive response with PII' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 20 },
          resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
        }),
        chatWithToolUseStreamable: vi
          .fn()
          .mockImplementation(async (_system, _messages, _tools, _purpose, onStream) => {
            onStream?.('Sensitive response with PII');
            return {
              text: 'Sensitive response with PII',
              toolCalls: [],
              rawContent: [{ type: 'text', text: 'Sensitive response with PII' }],
              stopReason: 'end_turn',
              usage: { inputTokens: 10, outputTokens: 20 },
              resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
            };
          }),
      },
    };

    const onChunk = vi.fn((text: string) => {
      operationLog.push(`chunk:${text}`);
    });

    const executor = new ReasoningExecutor(
      {} as any, // ctx
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any, // routing
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any, // flowStep
    );

    const result = await executor.execute(session, 'system prompt', [], onChunk);

    // When guardrails block, the response should be the block message
    expect(result.response).toBe('Response blocked by guardrail.');

    // Guardrails MUST have been called
    expect(checkOutputGuardrails).toHaveBeenCalled();

    expect(mockCheckFlatConstraintsAtCheckpoint).toHaveBeenCalledWith(
      session,
      { kind: 'response' },
      undefined,
    );

    // The critical ordering check: response checkpoint constraints must run before output guardrails.
    const checkpointIdx = operationLog.findIndex((op) => op === 'constraint:response');
    const guardrailIdx = operationLog.findIndex((op) => op.startsWith('guardrail:'));
    const historyIdx = operationLog.findIndex((op) => op.startsWith('history:'));

    expect(checkpointIdx).toBeGreaterThanOrEqual(0);
    expect(guardrailIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(checkpointIdx).toBeLessThan(guardrailIdx);
    expect(guardrailIdx).toBeLessThan(historyIdx);
    expect(operationLog[historyIdx]).toBe('history:Response blocked by guardrail.');

    expect(onChunk).toHaveBeenCalled();
    expect(operationLog).not.toContain('chunk:Sensitive response with PII');
    const lastChunkCall = onChunk.mock.calls[onChunk.mock.calls.length - 1][0];
    expect(lastChunkCall).toBe('Response blocked by guardrail.');
  }, 60000);
});
