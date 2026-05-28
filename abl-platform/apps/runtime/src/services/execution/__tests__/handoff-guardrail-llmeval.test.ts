import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests that handoff guardrail checks in routing-executor create per-invocation
 * pipelines with llmEval wired from session.llmClient — fixing the Gap 1 issue
 * where the module-level pipeline had no Tier 3 LLM eval.
 */

const mockPipelineExecute = vi.fn().mockResolvedValue({ passed: true });
const mockCreatePipeline = vi.fn((_llmEval?: unknown) => ({
  execute: mockPipelineExecute,
}));
const mockCreateLLMEval = vi.fn((_client: unknown) => vi.fn().mockResolvedValue('SAFE'));

// Mock pipeline factory
vi.mock('../../guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: (llmEval?: unknown) => mockCreatePipeline(llmEval),
  resolveGuardrailPolicy: vi.fn().mockResolvedValue(undefined),
  createLLMEvalFromClient: (client: unknown) => mockCreateLLMEval(client),
}));

// Mock session-policy
vi.mock('../session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockResolvedValue(undefined),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue('test-guardrail-scope'),
}));

// Mock value-resolution
vi.mock('../value-resolution.js', () => ({
  getNestedValue: vi.fn(),
  interpolateTemplate: vi.fn((t: string) => t),
  interpolateVoiceConfig: vi.fn(),
  interpolateRichContent: vi.fn(),
  resolveValuePath: vi.fn(),
  resolveSetValue: vi.fn(),
}));

// Mock prompt-builder
vi.mock('../prompt-builder.js', () => ({
  isVoiceChannel: vi.fn().mockReturnValue(false),
}));

// Mock prompt-template-loader
vi.mock('../prompt-template-loader.js', () => ({
  promptTemplateLoader: { load: vi.fn().mockResolvedValue('') },
}));

// Mock memory integration
vi.mock('../memory-integration.js', () => ({
  executeRecallForAgentEvent: vi.fn().mockResolvedValue(undefined),
}));

// Mock multi-intent-strategy
vi.mock('../multi-intent-strategy.js', () => ({
  resolveStrategy: vi.fn(),
}));

// Mock intent-queue
vi.mock('../intent-queue.js', () => ({
  enqueueIntents: vi.fn(),
  createIntentQueue: vi.fn(),
}));

// Mock types helpers — provide realistic getActiveThread with data.values
vi.mock('../types.js', async () => {
  const actual = await vi.importActual<object>('../types.js');
  return {
    ...actual,
    getActiveThread: vi.fn().mockImplementation((session: any) => {
      const thread = session.threads?.[session.activeThreadIndex ?? 0];
      return (
        thread ?? {
          agentName: session.agentName ?? 'source-agent',
          conversationHistory: [],
          status: 'active',
          data: { values: {} },
        }
      );
    }),
    createThread: vi.fn(),
    syncThreadToSession: vi.fn(),
    tryThreadReturn: vi.fn(),
    buildStateUpdates: vi.fn().mockReturnValue({}),
    getGatherProgress: vi.fn().mockReturnValue({}),
  };
});

function createHandoffSession(opts: { withLLMClient: boolean }): any {
  return {
    id: 'test-session',
    agentName: 'source-agent',
    agentIR: {
      constraints: {
        guardrails: [
          {
            name: 'handoff-check',
            kind: 'handoff',
            rules: [{ type: 'llm', prompt: 'Is this handoff safe?', threshold: 0.5 }],
            priority: 1,
          },
        ],
      },
      metadata: { name: 'source-agent' },
      identity: { goal: 'Help users' },
      routing: {
        rules: [{ to: 'target-agent', when: 'user asks to transfer' }],
      },
      coordination: {
        handoffs: [{ to: 'target-agent' }],
      },
    },
    conversationHistory: [{ role: 'user', content: 'transfer me' }],
    data: { values: {} },
    threads: [
      {
        agentName: 'source-agent',
        agentIR: {
          constraints: {
            guardrails: [
              {
                name: 'handoff-check',
                kind: 'handoff',
                rules: [{ type: 'llm', prompt: 'Is this handoff safe?', threshold: 0.5 }],
                priority: 1,
              },
            ],
          },
          metadata: { name: 'source-agent' },
          identity: { goal: 'Help users' },
          routing: {
            rules: [{ to: 'target-agent', when: 'user asks to transfer' }],
          },
          coordination: {
            handoffs: [{ to: 'target-agent' }],
          },
        },
        conversationHistory: [{ role: 'user', content: 'transfer me' }],
        data: { values: {} },
        status: 'active',
      },
    ],
    activeThreadIndex: 0,
    threadStack: [],
    handoffStack: [],
    handoffReturnInfo: { 'target-agent': false },
    llmClient: opts.withLLMClient
      ? { chatWithToolUse: vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] }) }
      : undefined,
  };
}

describe('Handoff guardrail LLM eval wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipelineExecute.mockResolvedValue({ passed: true });
  });

  it('creates pipeline with llmEval for handoff guardrails when session has llmClient', async () => {
    const { RoutingExecutor } = await import('../routing-executor.js');

    const session = createHandoffSession({ withLLMClient: true });

    const ctx: any = {
      executeMessage: vi.fn().mockResolvedValue({ response: 'ok', action: { type: 'continue' } }),
      wireLLMClient: vi.fn(),
      agentRegistry: {
        'target-agent': {
          dsl: '',
          ir: {
            metadata: { name: 'target-agent' },
            execution: { mode: 'reasoning' },
          },
        },
      },
      sessions: new Map([['test-session', session]]),
      config: {},
    };

    const llmWiring: any = {
      ensureSessionLLMClient: vi.fn(),
    };

    const routing = new RoutingExecutor(ctx, llmWiring);

    const input = { target: 'target-agent', context: {}, reason: 'user request' };

    try {
      await routing.handleHandoff(session, input, vi.fn(), vi.fn());
    } catch {
      // May throw due to incomplete mocking after guardrail check — that's fine
    }

    // createLLMEvalFromClient should have been called with the session's llmClient
    expect(mockCreateLLMEval).toHaveBeenCalledWith(session.llmClient);

    // createGuardrailPipeline should have been called with the llmEval function
    const llmEvalFn = mockCreateLLMEval.mock.results[0]?.value;
    expect(mockCreatePipeline).toHaveBeenCalledWith(llmEvalFn);
  });

  it('creates pipeline without llmEval when session has no llmClient', async () => {
    const { RoutingExecutor } = await import('../routing-executor.js');

    const session = createHandoffSession({ withLLMClient: false });

    const ctx: any = {
      executeMessage: vi.fn().mockResolvedValue({ response: 'ok', action: { type: 'continue' } }),
      wireLLMClient: vi.fn(),
      agentRegistry: {
        'target-agent': {
          dsl: '',
          ir: {
            metadata: { name: 'target-agent' },
            execution: { mode: 'reasoning' },
          },
        },
      },
      sessions: new Map([['test-session', session]]),
      config: {},
    };

    const llmWiring: any = {
      ensureSessionLLMClient: vi.fn(),
    };

    const routing = new RoutingExecutor(ctx, llmWiring);

    const input = { target: 'target-agent', context: {}, reason: 'user request' };

    try {
      await routing.handleHandoff(session, input, vi.fn(), vi.fn());
    } catch {
      // May throw due to incomplete mocking
    }

    // createLLMEvalFromClient should NOT have been called (no llmClient)
    expect(mockCreateLLMEval).not.toHaveBeenCalled();

    // createGuardrailPipeline should have been called with undefined (no llmEval)
    expect(mockCreatePipeline).toHaveBeenCalledWith(undefined);
  });
});
