import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests that tool_input and tool_output guardrail checks create per-invocation
 * pipelines with llmEval wired from session.llmClient — fixing the Gap 1 issue
 * where module-level pipelines had no Tier 3 LLM eval.
 */

const mockPipelineExecute = vi.fn().mockResolvedValue({ passed: true });
const mockCreatePipeline = vi.fn((_llmEval?: unknown, _tenantId?: string) => ({
  execute: mockPipelineExecute,
}));
const mockCreateLLMEval = vi.fn((_client: unknown) => vi.fn().mockResolvedValue('SAFE'));
const mockResolveGuardrailPolicy = vi.fn().mockResolvedValue(undefined);
const mockEnsureTenantProvidersLoaded = vi.fn().mockResolvedValue(undefined);
const mockCheckFlatConstraints = vi.fn().mockReturnValue(null);
const mockCheckFlatConstraintsAtCheckpoint = vi.fn().mockReturnValue(null);
const mockExecuteConstraintViolation = vi.fn();
const mockSetCurrentTurnInputContext = vi.fn(
  (session: { data: { values: Record<string, unknown> } }, input: string, rawInput = input) => {
    session.data.values['input'] = input;
    session.data.values['_raw_input'] = rawInput;
  },
);

function expectConstraintHandoffBreakLoop(
  result: unknown,
  params: { response: string; target: string },
): void {
  expect(result).toMatchObject({
    toolResult: {
      message: params.response,
      response: params.response,
      target: params.target,
    },
    action: { type: 'handoff', target: params.target },
    breakLoop: true,
  });
}

// Mock pipeline factory — track calls to createGuardrailPipeline and createLLMEvalFromClient
vi.mock('../../guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: (llmEval?: unknown, tenantId?: string) =>
    mockCreatePipeline(llmEval, tenantId),
  resolveGuardrailPolicy: (...args: unknown[]) => mockResolveGuardrailPolicy(...args),
  createLLMEvalFromClient: (client: unknown) => mockCreateLLMEval(client),
  ensureTenantProvidersLoaded: (...args: unknown[]) => mockEnsureTenantProvidersLoaded(...args),
}));

// Mock output guardrails
vi.mock('../output-guardrails.js', () => ({
  checkOutputGuardrails: vi.fn().mockResolvedValue({ passed: true }),
}));

// Mock constraint checker
vi.mock('../constraint-checker.js', () => ({
  checkConstraints: vi.fn().mockReturnValue(null),
  checkFlatConstraints: (...args: unknown[]) => mockCheckFlatConstraints(...args),
  checkFlatConstraintsAtCheckpoint: (...args: unknown[]) =>
    mockCheckFlatConstraintsAtCheckpoint(...args),
  handleConstraintViolation: vi.fn(),
  executeConstraintViolation: (...args: unknown[]) => mockExecuteConstraintViolation(...args),
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

function createMockSession(opts: { withLLMClient?: boolean; guardrailKinds?: string[] } = {}) {
  const { withLLMClient = true, guardrailKinds = ['tool_input', 'tool_output'] } = opts;
  const guardrails = guardrailKinds.map((kind, i) => ({
    name: `${kind}-check-${i}`,
    kind,
    rules: [{ type: 'llm', prompt: 'Is this safe?', threshold: 0.5 }],
    priority: 1,
  }));

  const conversationHistory = [{ role: 'user', content: 'use the search tool' }];

  return {
    id: 'test-session',
    agentName: 'test-agent',
    agentIR: {
      execution: { mode: 'reasoning', max_iterations: 5 },
      constraints: { guardrails },
      metadata: { name: 'test-agent' },
      routing: {},
      tools: [{ name: 'search', description: 'Search tool' }],
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
    llmClient: withLLMClient
      ? {
          chatWithToolUse: vi.fn().mockResolvedValue({
            text: '',
            toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'hello' } }],
            rawContent: [],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 20 },
            resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
          }),
          chatWithToolUseStreamable: vi.fn().mockResolvedValue({
            text: '',
            toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'hello' } }],
            rawContent: [],
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 20 },
            resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
          }),
        }
      : undefined,
    toolExecutor: {
      execute: vi.fn().mockResolvedValue({ result: 'search results' }),
    },
  } as any;
}

describe('Tool guardrail LLM eval wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipelineExecute.mockResolvedValue({ passed: true });
    mockResolveGuardrailPolicy.mockReset();
    mockResolveGuardrailPolicy.mockResolvedValue(undefined);
    mockEnsureTenantProvidersLoaded.mockClear();
    mockCheckFlatConstraints.mockReset();
    mockCheckFlatConstraints.mockReturnValue(null);
    mockCheckFlatConstraintsAtCheckpoint.mockReset();
    mockCheckFlatConstraintsAtCheckpoint.mockReturnValue(null);
    mockExecuteConstraintViolation.mockReset();
    mockSetCurrentTurnInputContext.mockClear();
  });

  it('creates pipeline with llmEval for tool_input guardrails when session has llmClient', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const session = createMockSession({ guardrailKinds: ['tool_input'] });

    // After first tool call, LLM returns completion to end the loop
    session.llmClient.chatWithToolUse
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'hello' } }],
        rawContent: [],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 20 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      })
      .mockResolvedValueOnce({
        text: 'Here are your results',
        toolCalls: [],
        rawContent: [{ type: 'text', text: 'Here are your results' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      });

    const executor = new ReasoningExecutor(
      {} as any,
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    await executor.execute(session, 'system prompt', [], vi.fn());

    // createLLMEvalFromClient should have been called with the session's llmClient
    expect(mockCreateLLMEval).toHaveBeenCalledWith(session.llmClient);

    // createGuardrailPipeline should have been called with the llmEval function
    const llmEvalFn = mockCreateLLMEval.mock.results[0]?.value;
    expect(mockCreatePipeline).toHaveBeenCalledWith(llmEvalFn, undefined);
  }, 60000);

  it('creates pipeline without llmEval when session has no llmClient', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const session = createMockSession({ withLLMClient: false, guardrailKinds: ['tool_input'] });

    const executor = new ReasoningExecutor(
      {} as any,
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    await (executor as any).executeToolCall(
      session,
      { id: 'tc-1', name: 'search', input: { query: 'hello' } },
      undefined,
      vi.fn(),
    );

    expect(mockCreateLLMEval).not.toHaveBeenCalled();
    expect(mockCreatePipeline).toHaveBeenCalledWith(undefined, undefined);
  });

  it('passes only DSL guardrails to the pipeline because policy guardrails are merged by the pipeline itself', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const session = createMockSession({ guardrailKinds: ['tool_input'] });
    session.tenantId = 'tenant-1';
    session.projectId = 'project-1';
    const policyDefinedGuardrail = {
      name: 'policy-defined-tool-input',
      kind: 'tool_input',
      tier: 'model',
      provider: 'policy-provider',
      category: 'toxicity',
      threshold: 0.5,
      priority: 5,
      action: { type: 'block', message: 'Blocked by policy' },
    };
    mockResolveGuardrailPolicy.mockResolvedValue({
      policy: {
        additionalGuardrails: [policyDefinedGuardrail],
      },
      streamingConfig: null,
    });

    session.llmClient.chatWithToolUse
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'hello' } }],
        rawContent: [],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 20 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      })
      .mockResolvedValueOnce({
        text: 'Here are your results',
        toolCalls: [],
        rawContent: [{ type: 'text', text: 'Here are your results' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      });

    const executor = new ReasoningExecutor(
      {} as any,
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    await executor.execute(session, 'system prompt', [], vi.fn());

    const evaluatedGuardrails = mockPipelineExecute.mock.calls[0]?.[0] as Array<{ name: string }>;
    expect(evaluatedGuardrails.map((guardrail) => guardrail.name)).toEqual(['tool_input-check-0']);
    expect(evaluatedGuardrails).not.toContainEqual(
      expect.objectContaining({ name: 'policy-defined-tool-input' }),
    );
  }, 60000);

  it('creates pipeline with llmEval for tool_output guardrails', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const session = createMockSession({ guardrailKinds: ['tool_output'] });

    session.llmClient.chatWithToolUse
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'tc-1', name: 'search', input: { query: 'hello' } }],
        rawContent: [],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 20 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      })
      .mockResolvedValueOnce({
        text: 'Results here',
        toolCalls: [],
        rawContent: [{ type: 'text', text: 'Results here' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 20 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      });

    const executor = new ReasoningExecutor(
      {} as any,
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    await executor.execute(session, 'system prompt', [], vi.fn());

    // createLLMEvalFromClient should have been called for tool_output guardrails
    expect(mockCreateLLMEval).toHaveBeenCalledWith(session.llmClient);
    // createGuardrailPipeline should have been called with the eval function
    expect(mockCreatePipeline).toHaveBeenCalled();
    const firstCall = mockCreatePipeline.mock.calls[0] as unknown[];
    expect(firstCall[0]).toBeDefined(); // llmEval was passed
  });

  it('does not use module-level guardrailPipeline (removed)', async () => {
    // Reset the module cache so we can verify import-time behavior directly.
    vi.resetModules();
    mockCreatePipeline.mockClear();
    mockCreateLLMEval.mockClear();

    const mod = await import('../reasoning-executor.js');
    expect(mod.ReasoningExecutor).toBeDefined();
    expect(mockCreatePipeline).not.toHaveBeenCalled();
    expect(mockCreateLLMEval).not.toHaveBeenCalled();
  });

  it('uses executeConstraintViolation for post-tool flat constraint failures', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const violation = {
      type: 'constraint',
      condition: 'needs_specialist == false',
      passed: false,
      action: { type: 'handoff', target: 'specialist_agent' },
    } as const;
    mockCheckFlatConstraints.mockReturnValue(violation);
    mockExecuteConstraintViolation.mockResolvedValue({
      response: 'Specialist is taking over.',
      action: { type: 'handoff', target: 'specialist_agent' },
    });

    const session = {
      id: 'test-session',
      agentName: 'test-agent',
      agentIR: {
        execution: { mode: 'reasoning', max_iterations: 5 },
        constraints: { guardrails: [] },
        metadata: { name: 'test-agent' },
        routing: {},
        tools: [{ name: 'search', description: 'Search tool' }],
      },
      compilationOutput: null,
      conversationHistory: [{ role: 'user', content: 'find a specialist' }],
      state: { status: 'active' },
      data: { values: {} },
      isComplete: false,
      isEscalated: false,
      handoffStack: [],
      threads: [
        {
          agentName: 'test-agent',
          conversationHistory: [{ role: 'user', content: 'find a specialist' }],
          status: 'active',
        },
      ],
      activeThreadIndex: 0,
      threadStack: [],
      initialized: true,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      llmClient: {
        chatWithToolUse: vi.fn(),
        chatWithToolUseStreamable: vi.fn(),
      },
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({ result: 'search results' }),
      },
    } as any;

    const executor = new ReasoningExecutor(
      {} as any,
      {
        checkHandoffConditions: vi.fn().mockResolvedValue(null),
        handleHandoff: vi.fn(),
      } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    const result = await (executor as any).executeToolCall(
      session,
      { id: 'tc-1', name: 'search', input: { query: 'hello' } },
      undefined,
      vi.fn(),
    );

    expect(mockCheckFlatConstraints).toHaveBeenCalledWith(session, expect.any(Function));
    expect(mockExecuteConstraintViolation).toHaveBeenCalled();
    expectConstraintHandoffBreakLoop(result, {
      response: 'Specialist is taking over.',
      target: 'specialist_agent',
    });
  });

  it('preserves raw input when input guardrails rewrite the latest user message', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const session = createMockSession({ guardrailKinds: ['input'] });
    session.agentIR.tools = [];
    session.llmClient.chatWithToolUse.mockResolvedValue({
      text: 'Sanitized response',
      toolCalls: [],
      rawContent: [{ type: 'text', text: 'Sanitized response' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 20 },
      resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
    });
    mockPipelineExecute.mockResolvedValueOnce({
      passed: true,
      modifiedContent: 'sanitized search request',
    });

    const executor = new ReasoningExecutor(
      {} as any,
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    await executor.execute(session, 'system prompt', [], vi.fn());

    expect(mockSetCurrentTurnInputContext).toHaveBeenCalledWith(
      session,
      'sanitized search request',
      'use the search tool',
    );
    expect(session.data.values['input']).toBe('sanitized search request');
    expect(session.data.values['_raw_input']).toBe('use the search tool');
  });

  it('checks structural tool-call checkpoints before executing the tool', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const violation = {
      type: 'constraint',
      condition: 'measure_field != null',
      passed: false,
      action: { type: 'handoff', target: 'specialist_agent' },
    } as const;
    mockCheckFlatConstraintsAtCheckpoint.mockReturnValue(violation);
    mockExecuteConstraintViolation.mockResolvedValue({
      response: 'Need a specialist before calling search.',
      action: { type: 'handoff', target: 'specialist_agent' },
    });

    const session = createMockSession({ guardrailKinds: [] });
    const executor = new ReasoningExecutor(
      {} as any,
      {
        checkHandoffConditions: vi.fn().mockResolvedValue(null),
        handleHandoff: vi.fn(),
      } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    const result = await (executor as any).executeToolCall(
      session,
      { id: 'tc-1', name: 'search', input: { query: 'hello' } },
      undefined,
      vi.fn(),
    );

    expect(mockCheckFlatConstraintsAtCheckpoint).toHaveBeenCalledWith(
      session,
      { kind: 'tool_call', target: 'search' },
      expect.any(Function),
    );
    expect(session.toolExecutor.execute).not.toHaveBeenCalled();
    expect(mockExecuteConstraintViolation).toHaveBeenCalled();
    expectConstraintHandoffBreakLoop(result, {
      response: 'Need a specialist before calling search.',
      target: 'specialist_agent',
    });
  });

  it('emits regular tool_call start trace before tool execution and completion trace after', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const session = createMockSession({ guardrailKinds: [] });
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    session.toolExecutor.execute.mockImplementation(async () => {
      traceEvents.push({ type: 'executor_entered', data: {} });
      return { result: 'search results' };
    });

    const executor = new ReasoningExecutor(
      {} as any,
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    const result = await (executor as any).executeToolCall(
      session,
      { id: 'tc-1', name: 'search', input: { query: 'hello' } },
      undefined,
      (event: { type: string; data: Record<string, unknown> }) => traceEvents.push(event),
      'llm-1',
    );

    const startIndex = traceEvents.findIndex((event) => event.type === 'tool_call_start');
    const executorIndex = traceEvents.findIndex((event) => event.type === 'executor_entered');
    const completeIndex = traceEvents.findIndex(
      (event) => event.type === 'tool_call' && event.data.phase === 'complete',
    );

    expect(result.toolResult).toEqual({ result: 'search results' });
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(executorIndex);
    expect(completeIndex).toBeGreaterThan(executorIndex);
    expect(traceEvents[startIndex]?.data).toMatchObject({
      toolCallId: 'tc-1',
      toolName: 'search',
      input: { query: 'hello' },
      isActionTool: false,
      agent: 'test-agent',
      llmCallId: 'llm-1',
    });
    expect(traceEvents[completeIndex]?.data).toMatchObject({
      phase: 'complete',
      toolCallId: 'tc-1',
      toolName: 'search',
      output: { result: 'search results' },
      success: true,
      isActionTool: false,
      agent: 'test-agent',
    });
  });

  it('keeps the first breakLoop action aligned with its response across parallel tools', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const firstViolation = {
      type: 'constraint',
      condition: 'search_ready == true',
      passed: false,
      action: { type: 'handoff', target: 'specialist_agent' },
    } as const;
    const secondViolation = {
      type: 'constraint',
      condition: 'lookup_ready == true',
      passed: false,
      action: { type: 'complete' },
    } as const;
    mockCheckFlatConstraints
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(firstViolation)
      .mockReturnValueOnce(secondViolation);
    mockExecuteConstraintViolation
      .mockResolvedValueOnce({
        response: 'Search requires a specialist.',
        action: { type: 'handoff', target: 'specialist_agent' },
      })
      .mockResolvedValueOnce({
        response: 'Lookup completed.',
        action: { type: 'complete' },
      });

    const session = createMockSession({ guardrailKinds: [] });
    session.agentIR.tools = [
      { name: 'search', description: 'Search tool' },
      { name: 'lookup', description: 'Lookup tool' },
    ];
    session.llmClient.chatWithToolUseStreamable.mockResolvedValue({
      text: '',
      toolCalls: [
        { id: 'tc-1', name: 'search', input: { query: 'alpha' } },
        { id: 'tc-2', name: 'lookup', input: { query: 'beta' } },
      ],
      rawContent: [],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 20 },
      resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
    });
    session.toolExecutor.execute
      .mockResolvedValueOnce({ result: 'search results' })
      .mockResolvedValueOnce({ result: 'lookup results' });

    const executor = new ReasoningExecutor(
      {} as any,
      {
        checkHandoffConditions: vi.fn().mockResolvedValue(null),
        handleHandoff: vi.fn(),
      } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    const result = await executor.execute(session, 'system prompt', [], undefined);

    expect(result.response).toBe('Search requires a specialist.');
    expect(result.action).toEqual({ type: 'handoff', target: 'specialist_agent' });
  });

  it('buffers specialist streaming when a response checkpoint must run before emitting output', async () => {
    const { ReasoningExecutor } = await import('../reasoning-executor.js');

    const responseViolation = {
      type: 'constraint',
      condition: '_abl_constraint_checkpoint_kind == "response" && reviewed == true',
      passed: false,
      action: { type: 'respond' },
    } as const;
    mockCheckFlatConstraintsAtCheckpoint.mockImplementation((_session, checkpoint) =>
      checkpoint.kind === 'response' ? responseViolation : null,
    );
    mockExecuteConstraintViolation.mockImplementation(async (_session, _violation, options) => {
      options.onChunk?.('Need review before replying.');
      return {
        response: 'Need review before replying.',
        action: { type: 'respond' },
      };
    });

    const session = createMockSession({ guardrailKinds: [] });
    session.agentIR.constraints.constraints = [
      {
        name: 'before-response-review',
        condition: '_abl_constraint_checkpoint_kind == "response" && reviewed == true',
        action: { type: 'respond', message: 'Need review before replying.' },
      },
    ];
    session.agentIR.tools = [];
    session.llmClient.chatWithToolUseStreamable.mockImplementation(
      async (
        _system: string,
        _messages: unknown[],
        _tools: unknown[],
        _purpose: string,
        onStream?: (chunk: string) => void,
      ) => {
        onStream?.('Unsafe direct response');
        return {
          text: 'Unsafe direct response',
          toolCalls: [],
          rawContent: [{ type: 'text', text: 'Unsafe direct response' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 20 },
          resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
        };
      },
    );

    const onChunk = vi.fn();
    const executor = new ReasoningExecutor(
      {} as any,
      { checkHandoffConditions: vi.fn().mockResolvedValue(null) } as any,
      { extractEntitiesWithLLM: vi.fn().mockResolvedValue({}) } as any,
    );

    const result = await executor.execute(session, 'system prompt', [], onChunk);

    expect(onChunk).not.toHaveBeenCalledWith('Unsafe direct response');
    expect(onChunk).toHaveBeenCalledWith('Need review before replying.');
    expect(result.response).toBe('Need review before replying.');
  });
});
