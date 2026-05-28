import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetConfigAsync = vi.fn();

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: mockGetConfigAsync,
  }),
}));

vi.mock('../../services/guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: vi.fn().mockReturnValue({
    execute: vi.fn().mockResolvedValue({ passed: true }),
  }),
  createLLMEvalFromClient: vi.fn(() => undefined),
  ensureTenantProvidersLoaded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/execution/session-policy.js', () => ({
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
  getSessionPolicy: vi.fn().mockResolvedValue(null),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn((config: unknown) => config),
}));

import { generateText } from 'ai';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import {
  CLASSIFIER_TIMEOUT_MS,
  PipelineClassifierUnavailableError,
  classify,
} from '../../services/pipeline/classifier.js';
import { DEFAULT_PIPELINE_CONFIG } from '../../services/pipeline/types.js';
import * as classifierModule from '../../services/pipeline/classifier.js';

const mockGenerateText = vi.mocked(generateText);

function createTraceCollector(): {
  traces: Array<{ type: string; data: Record<string, unknown> }>;
  callback: (event: { type: string; data: Record<string, unknown> }) => void;
} {
  const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    traces,
    callback: (event) => traces.push(event),
  };
}

async function executeFlowStepDirectly(
  runtimeExecutor: RuntimeExecutor,
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  message: string,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): Promise<{ response?: string; action?: Record<string, unknown> }> {
  return (
    runtimeExecutor as unknown as {
      flowStep: {
        executeFlowStep: (
          runtimeSession: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
          userMessage: string,
          onChunk?: (chunk: string) => void,
          onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
        ) => Promise<{ response?: string; action?: Record<string, unknown> }>;
      };
    }
  ).flowStep.executeFlowStep(session, message, undefined, onTraceEvent);
}

class MockLLMClient {
  private responseHandler: (
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
    });
  }

  async resolveLanguageModel(_operationType: string) {
    return { modelId: 'pipeline-model' } as any;
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(
    _systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    return this.responseHandler(messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

function createPipelineConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    mode: 'sequential',
    modelSource: 'default',
    shortCircuit: { enabled: false, confidenceThreshold: 0.85 },
    toolFilter: { enabled: false, maxTools: 6 },
    keywordVeto: { enabled: false, keywords: [] },
    intentBridge: {
      enabled: false,
      programmaticThreshold: 0.85,
      guidedThreshold: 0.5,
      outOfScopeDecline: true,
      multiIntentSignal: true,
    },
    ...overrides,
  };
}

const LOCATION_ROUTING_SUPERVISOR = `
SUPERVISOR: OceanFirstSupervisor

GOAL: "Route banking requests during authentication"

PERSONA: "Ocean First routing supervisor"

INTENTS:
  auth: "Authentication and phone ID verification"
  atm_locator: "Users asking for ATM or branch locations"
  branch_locator: "Users asking for branch locations"

HANDOFF:
  - TO: AuthenticationFlowChild
    WHEN: intent.category == "auth"
    RETURN: true

  - TO: BranchLocatorChild
    WHEN: intent.category == "atm_locator" || intent.category == "branch_locator"
    RETURN: true
`;

const STRICT_LOCATION_ROUTING_SUPERVISOR = `
SUPERVISOR: StrictOceanFirstSupervisor

GOAL: "Route banking requests during authentication"

PERSONA: "Ocean First routing supervisor"

INTENTS:
  LEXICAL_FALLBACK: never
  auth: "Authentication and phone ID verification"
  atm_locator: "Users asking for ATM or branch locations"
  branch_locator: "Users asking for branch locations"

HANDOFF:
  - TO: AuthenticationFlowChild
    WHEN: intent.category == "auth"
    RETURN: true

  - TO: BranchLocatorChild
    WHEN: intent.category == "atm_locator" || intent.category == "branch_locator"
    RETURN: true
`;

const AUTHENTICATION_FLOW_CHILD = `
AGENT: AuthenticationFlowChild

GOAL: "Collect the caller phone ID"

FLOW:
  entry_point: ask_phone_id
  steps:
    - ask_phone_id

ask_phone_id:
  REASONING: false
  GATHER:
    - phone_id: required
  THEN: COMPLETE
`;

const BRANCH_LOCATOR_CHILD = `
AGENT: BranchLocatorChild

GOAL: "Help find nearby ATMs and branches"

FLOW:
  entry_point: respond_location
  steps:
    - respond_location

respond_location:
  REASONING: false
  RESPOND: "I can help locate nearby ATMs and branches."
  THEN: COMPLETE
`;

function configureLocationSupervisorPipeline(
  session: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
  overrides: Record<string, unknown> = {},
) {
  const parentThread = session.threads[0];
  const parentIR = parentThread.agentIR;
  if (!parentIR) {
    throw new Error('Expected supervisor parent thread IR to exist');
  }

  parentIR.execution = {
    ...(parentIR.execution ?? {}),
    pipeline: createPipelineConfig({
      shortCircuit: {
        enabled: true,
        confidenceThreshold: 0.85,
      },
      toolFilter: {
        enabled: false,
        maxTools: 6,
      },
      keywordVeto: {
        enabled: false,
        keywords: [],
      },
      ...overrides,
    }),
  } as any;

  session.agentIR = parentIR;
  session.llmClient = session.llmClient ?? parentThread.llmClient;
  parentThread.llmClient = session.llmClient;
  session.tenantId = session.tenantId ?? 'tenant-1';
  session.projectId = session.projectId ?? 'project-1';
}

function configureAuthenticationExtraction(mockClient: MockLLMClient) {
  mockClient.setResponseHandler((messages, tools) => {
    if (tools.some((tool: any) => tool.name === '_extract_entities')) {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === 'user' && typeof message.content === 'string');
      const extractedValue =
        typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
      return {
        text: JSON.stringify({ phone_id: extractedValue }),
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [{ type: 'text', text: JSON.stringify({ phone_id: extractedValue }) }],
      };
    }

    return {
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
    };
  });
}

describe('classifier timeout fallback', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    mockGetConfigAsync.mockReset();
    mockGetConfigAsync.mockResolvedValue({
      features: {
        advancedNlu: false,
        codeToolsEnabled: false,
      },
    });
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    executor.stopStaleReaper();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects classifier calls when the model promise exceeds the deadline', async () => {
    vi.useFakeTimers();
    mockGenerateText.mockImplementation(() => new Promise(() => {}));

    const classifyPromise = classify({ modelId: 'pipeline-model' } as any, {
      mode: 'gather_scoped',
      userMessage: 'get atms near me',
      categories: [{ name: 'atm_locator' }],
      candidateSurface: {
        kind: 'parent_supervisor_route',
        size: 1,
        candidates: ['atm_locator'],
      },
      config: DEFAULT_PIPELINE_CONFIG,
    });
    const rejection = expect(classifyPromise).rejects.toMatchObject({
      name: 'PipelineClassifierUnavailableError',
      kind: 'timeout',
    });

    await vi.advanceTimersByTimeAsync(CLASSIFIER_TIMEOUT_MS);

    await rejection;
  });

  it('uses lexical parent reroute fallback when the classifier times out and policy is when_unavailable', async () => {
    vi.spyOn(classifierModule, 'classify').mockRejectedValueOnce(
      new PipelineClassifierUnavailableError(
        'timeout',
        'Pipeline classifier request exceeded 10000ms',
      ),
    );

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [LOCATION_ROUTING_SUPERVISOR, AUTHENTICATION_FLOW_CHILD, BRANCH_LOCATOR_CHILD],
        'OceanFirstSupervisor',
      ),
    );
    session.handoffReturnInfo = { AuthenticationFlowChild: true, BranchLocatorChild: true };
    session.conversationHistory.push({ role: 'user', content: 'check my balance' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureLocationSupervisorPipeline(session);
    configureAuthenticationExtraction(mockClient);

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'AuthenticationFlowChild', message: 'check my balance' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('AuthenticationFlowChild');
    expect(session.waitingForInput).toEqual(['phone_id']);

    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'get atms near me',
      traceCollector.callback,
    );

    expect(result.action?.type).toBe('return_to_parent');
    expect(result.action?.target).toBe('BranchLocatorChild');
    expect(result.action?.detectionMode).toBe('lexical');
    expect(traceCollector.traces).toContainEqual(
      expect.objectContaining({
        type: 'digression',
        data: expect.objectContaining({
          intent: 'atm_locator',
          detectionMode: 'lexical',
          lexicalMatchType: 'normalized',
          policyApplied: 'when_unavailable',
          target: 'BranchLocatorChild',
        }),
      }),
    );
  });

  it('suppresses lexical parent reroute fallback when the classifier times out and policy is never', async () => {
    vi.spyOn(classifierModule, 'classify').mockRejectedValueOnce(
      new PipelineClassifierUnavailableError(
        'timeout',
        'Pipeline classifier request exceeded 10000ms',
      ),
    );

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [STRICT_LOCATION_ROUTING_SUPERVISOR, AUTHENTICATION_FLOW_CHILD, BRANCH_LOCATOR_CHILD],
        'StrictOceanFirstSupervisor',
      ),
    );
    session.handoffReturnInfo = { AuthenticationFlowChild: true, BranchLocatorChild: true };
    session.conversationHistory.push({ role: 'user', content: 'check my balance' });
    session.threads[0].llmClient = mockClient as any;
    session.llmClient = mockClient as any;
    configureLocationSupervisorPipeline(session);
    configureAuthenticationExtraction(mockClient);

    const handleHandoff = (executor as any).routing.handleHandoff.bind((executor as any).routing);
    const initialResult = await handleHandoff(
      session,
      { target: 'AuthenticationFlowChild', message: 'check my balance' },
      undefined,
      undefined,
    );

    expect(initialResult.success).toBe(true);
    expect(session.agentName).toBe('AuthenticationFlowChild');
    expect(session.waitingForInput).toEqual(['phone_id']);

    const traceCollector = createTraceCollector();
    const result = await executeFlowStepDirectly(
      executor,
      session,
      'get atms near me',
      traceCollector.callback,
    );

    expect(result.action?.type).not.toBe('return_to_parent');
    expect(session.threads[1].data.values.phone_id).toBe('get atms near me');
    expect(traceCollector.traces.some((event) => event.type === 'return_to_parent')).toBe(false);
  });
});
