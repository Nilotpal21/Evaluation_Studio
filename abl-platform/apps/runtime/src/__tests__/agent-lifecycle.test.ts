/**
 * Agent Lifecycle Unit Tests
 *
 * Tests the centralized agent_enter / agent_exit lifecycle emission
 * in RuntimeExecutor.executeMessage(). These events are emitted at
 * the single execution convergence point — covering all channel
 * handlers without per-handler code.
 *
 * Test IDs: T1.1–T1.10 from the SDK Chat UI Consolidation test spec.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test.
// Copied from runtime-lifecycle.test.ts and extended for executeMessage paths.
// ---------------------------------------------------------------------------

// Mock the rate-limiter dynamic import used inside _doReap and executeMessage
const { mockRefreshSessionPIIContext, mockScrubTraceEvent, mockTraceStoreAddEvent } = vi.hoisted(
  () => ({
    mockRefreshSessionPIIContext: vi.fn(async () => {}),
    mockScrubTraceEvent: vi.fn((data: Record<string, unknown>) => data),
    mockTraceStoreAddEvent: vi.fn(),
  }),
);
const mockReleaseSessionSlot = vi.fn().mockResolvedValue(0);
vi.mock('../middleware/rate-limiter.js', () => ({
  releaseSessionSlot: mockReleaseSessionSlot,
  __esModule: true,
  default: {},
  rateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  sessionRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  payloadSizeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock createLogger so the module loads without real logging infra
vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();

  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    PIIVault: class {
      redact = vi.fn();
      reveal = vi.fn();
    },
  };
});

// Mock getCurrentTraceId from observability
vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: vi.fn().mockReturnValue(undefined),
}));

// Mock trace store (used at module level)
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: vi.fn().mockReturnValue({
    addEvent: mockTraceStoreAddEvent,
    getEvents: vi.fn().mockReturnValue([]),
    getSessionEvents: vi.fn().mockReturnValue([]),
  }),
}));

// Mock DB check (used at import time)
vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(false),
}));

// Mock compiler / core — constructor calls none of these during lifecycle tests
vi.mock('@abl/core', () => ({
  parseAgentBasedABL: vi.fn().mockReturnValue({ document: null, errors: [] }),
}));

vi.mock('@abl/compiler', () => ({
  compileABLtoIR: vi.fn(),
  DEFAULT_MESSAGES: {
    conversation_complete: 'Conversation complete.',
    empty_input: 'Please provide a message.',
  },
  SYSTEM_TOOL_RETURN_TO_PARENT: '__return_to_parent__',
  scrubTraceEvent: mockScrubTraceEvent,
}));

vi.mock('../services/pii/session-pii-context.js', () => ({
  createPIIVaultForProjectSnapshot: vi.fn(),
  resolveProjectPIISnapshot: vi.fn(),
  refreshSessionPIIContext: mockRefreshSessionPIIContext,
}));

// Mock adapters
vi.mock('../services/execution/noop-tool-executor.js', () => ({
  NoOpToolExecutor: class {},
}));

vi.mock('../services/adapters/index.js', () => ({
  MockToolExecutor: class {},
  TestAgentRegistry: class {},
  TestTraceManager: class {},
}));

// Mock execution sub-services so the constructor doesn't explode
vi.mock('../services/execution/llm-wiring.js', () => ({
  LLMWiringService: class {
    clearCooldown = vi.fn();
    ensureSessionLLMClient = vi.fn().mockResolvedValue(undefined);
    getToolExecutor() {
      return null;
    }
  },
}));

vi.mock('../services/execution/routing-executor.js', () => ({
  RoutingExecutor: class {
    checkAndMarkComplete = vi.fn().mockReturnValue(false);
    handleHandoff = vi.fn();
    handleDelegate = vi.fn();
    handleFanOut = vi.fn();
    handleComplete = vi.fn();
    handleEscalate = vi.fn();
    checkCompletionConditions = vi.fn().mockReturnValue(null);
    checkHandoffConditions = vi.fn().mockReturnValue(null);
  },
  deduplicateFanOutTasks: vi.fn(),
  formatFanOutToolResult: vi.fn(),
}));

// Flow step executor — return a valid ExecutionResult for flow mode tests
const mockExecuteFlowStep = vi.fn().mockResolvedValue({
  response: 'flow response',
  action: { type: 'respond', message: 'flow response' },
});
const mockExecuteOnStart = vi.fn().mockResolvedValue(null);
vi.mock('../services/execution/flow-step-executor.js', () => ({
  FlowStepExecutor: class {
    executeFlowStep = mockExecuteFlowStep;
    executeOnStart = mockExecuteOnStart;
  },
  SESSION_KEY_ACTION_EVENT: '__action_event',
}));

// Reasoning executor — return a valid ExecutionResult for reasoning mode tests
const mockReasoningExecute = vi.fn().mockResolvedValue({
  response: 'test response',
  action: { type: 'continue' },
});
vi.mock('../services/execution/reasoning-executor.js', () => ({
  ReasoningExecutor: class {
    execute = mockReasoningExecute;
  },
}));

vi.mock('../services/execution/prompt-builder.js', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('mock system prompt'),
  buildTools: vi.fn().mockReturnValue([]),
  isVoiceChannel: vi.fn().mockReturnValue(false),
}));

vi.mock('../services/execution/constraint-checker.js', () => ({
  checkConstraints: vi.fn(),
  checkFlatConstraints: vi.fn().mockReturnValue(null),
  handleConstraintViolation: vi.fn(),
  executeConstraintViolation: vi.fn(),
  setCurrentTurnInputContext: vi.fn(),
}));

vi.mock('../services/channel/channel-adapter.js', () => ({
  stripForVoice: vi.fn(),
}));

vi.mock('../services/execution/memory-integration.js', () => ({
  initializeAllMemory: vi.fn(),
}));

vi.mock('../services/stores/mongodb-fact-store.js', () => ({
  createMongoDBFactStore: vi.fn(),
  createProjectFactStore: vi.fn(),
  PROJECT_SCOPE_USER_ID: '__project__',
}));

vi.mock('../services/execution/profile-resolver.js', () => ({
  assembleProfileContext: vi.fn(),
  resolveActiveProfiles: vi.fn(),
  buildEffectiveConfig: vi.fn(),
  applyProfileInteractionContextToSessionData: vi.fn(),
  readProfileInteractionContextFromSessionData: vi.fn().mockReturnValue(undefined),
  extractProfileInteractionContextFromMetadata: vi.fn().mockReturnValue(undefined),
  mergeProfileInteractionContextInputs: vi.fn().mockReturnValue(undefined),
  normalizeProfileInteractionContextInput: vi.fn().mockReturnValue({
    success: false as const,
    error: 'unset' as const,
  }),
  PROFILE_INTERACTION_CONTEXT_SESSION_KEY: '_profileInteractionContext',
}));

vi.mock('../services/session/session-service.js', () => ({
  getSessionService: vi.fn().mockReturnValue({
    store: { load: vi.fn() },
    saveSession: vi.fn(),
    replaceConversation: vi.fn(),
    getVersion: vi.fn().mockResolvedValue(null),
    touch: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(null),
  }),
}));

// Mock guardrail imports (dynamic `await import()` inside executeMessage)
vi.mock('../services/guardrails/streaming-evaluator.js', () => ({
  StreamingGuardrailEvaluator: class {
    isTerminated = () => false;
    evaluateChunk = vi.fn().mockResolvedValue({ type: 'pass' });
  },
}));

const mockCreateGuardrailPipeline = vi.fn().mockReturnValue({
  execute: vi.fn().mockResolvedValue({ passed: true }),
});
const mockCreateLLMEvalFromClient = vi.fn();
const mockEnsureTenantProvidersLoaded = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/guardrails/pipeline-factory.js', () => ({
  createGuardrailPipeline: mockCreateGuardrailPipeline,
  createLLMEvalFromClient: mockCreateLLMEvalFromClient,
  ensureTenantProvidersLoaded: mockEnsureTenantProvidersLoaded,
}));

vi.mock('../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockResolvedValue(null),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn((config: unknown) => config),
}));

// Mock filler service
vi.mock('../services/filler/index.js', () => ({
  FillerMessageService: class {
    destroy = vi.fn();
    isDestroyed = () => true;
    queueFiller = vi.fn();
    cancel = vi.fn();
  },
  getFillerMessage: vi.fn(),
  buildStaticFillerCandidate: vi.fn((options: { operation: string }) => ({
    operation: options.operation,
    text: 'Mock filler',
    source: 'static',
  })),
  normalizeFillerStatusText: vi.fn((text: string) => text),
  generatePipelineFiller: vi.fn(),
  StatusTagParser: class {
    processChunk = (c: string) => ({ outputChunk: c, statusText: null });
  },
  DEFAULT_FILLER_CONFIG: {},
  resolveFillerConfig: vi.fn().mockReturnValue({
    enabled: true,
    chatDelayMs: 1200,
    cooldownMs: 3000,
    maxPerTurn: 5,
  }),
  resolveFillerRuntimeConfig: vi.fn().mockReturnValue({
    serviceConfig: {
      enabled: false,
      chatDelayMs: 1200,
      cooldownMs: 3000,
      maxPerTurn: 5,
    },
    piggybackEnabled: false,
    pipelineGenerationEnabled: false,
    modelSource: 'system',
  }),
}));

// Mock the channel manifest
vi.mock('../channels/manifest.js', () => ({
  getChannelManifest: vi.fn().mockReturnValue(null),
  CHANNEL_MANIFEST: {},
}));

// Mock shared-observability/sti
// tracePath(spanName, fn) should return fn unchanged (no tracing in tests)
vi.mock('@agent-platform/shared-observability/sti', () => ({
  tracePath: (_name: string, fn: unknown) => fn,
  computeConfigHash: vi.fn().mockReturnValue('hash'),
}));

// Mock shared-kernel
vi.mock('@agent-platform/shared-kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-kernel')>();

  return {
    ...actual,
    AppError: class extends Error {
      constructor(message: string, options?: Record<string, unknown>) {
        super(message);
        Object.assign(this, options);
      }
    },
    ErrorCodes: {
      ...actual.ErrorCodes,
      NOT_FOUND: { code: 'NOT_FOUND', statusCode: 404 },
      SERVICE_UNAVAILABLE: { code: 'SERVICE_UNAVAILABLE', statusCode: 503 },
      VALIDATION_ERROR: { code: 'VALIDATION_ERROR', statusCode: 400 },
      INTERNAL_ERROR: { code: 'INTERNAL_ERROR', statusCode: 500 },
    },
  };
});

// Mock i18n
vi.mock('@agent-platform/i18n', () => ({
  formatErrorSync: vi.fn().mockReturnValue({ message: 'Error' }),
}));

// Mock eventstore-singleton (dynamic import in createCentralizedTraceHandler)
vi.mock('../services/eventstore-singleton.js', () => ({
  getEventStore: vi.fn().mockReturnValue(null),
}));

// Mock trace-event-types (dynamic import in createCentralizedTraceHandler)
vi.mock('../services/trace-event-types.js', () => ({
  TRACE_TO_PLATFORM_TYPE: {},
  inferCategory: vi.fn().mockReturnValue('unknown'),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are in place
// ---------------------------------------------------------------------------

import { RuntimeExecutor } from '../services/runtime-executor.js';
import type { RuntimeSession } from '../services/execution/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal RuntimeSession stub for testing */
function createMockSession(id: string, overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id,
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    data: { values: {}, gatheredKeys: new Set<string>() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    // Provide an llmClient stub so reasoning mode proceeds past the "no LLM" guard
    llmClient: {
      resolveLanguageModel: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  } as RuntimeSession;
}

/** Shorthand for accessing private sessions Map */
function sessions(executor: RuntimeExecutor): Map<string, RuntimeSession> {
  return (executor as unknown as Record<string, Map<string, RuntimeSession>>).sessions;
}

/** Collected trace events helper type */
interface TraceEvent {
  type: string;
  data: Record<string, unknown>;
}

// =============================================================================
// TESTS
// =============================================================================

describe('RuntimeExecutor — agent lifecycle events', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    // Stop the auto-started reaper so tests have full control
    executor.stopStaleReaper();
    // Reset reasoning executor mock between tests
    mockReasoningExecute.mockClear();
    mockReasoningExecute.mockResolvedValue({
      response: 'test response',
      action: { type: 'continue' },
    });
    mockCreateGuardrailPipeline.mockClear();
    mockCreateGuardrailPipeline.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ passed: true }),
    });
    mockCreateLLMEvalFromClient.mockReset();
    mockCreateLLMEvalFromClient.mockReturnValue(undefined);
    mockEnsureTenantProvidersLoaded.mockClear();
    mockExecuteFlowStep.mockClear();
    mockExecuteFlowStep.mockResolvedValue({
      response: 'flow response',
      action: { type: 'respond', message: 'flow response' },
    });
    mockExecuteOnStart.mockClear();
    mockExecuteOnStart.mockResolvedValue(null);
    mockRefreshSessionPIIContext.mockClear();
    mockRefreshSessionPIIContext.mockResolvedValue(undefined);
    mockScrubTraceEvent.mockClear();
    mockScrubTraceEvent.mockImplementation((data: Record<string, unknown>) => data);
    mockTraceStoreAddEvent.mockClear();
  });

  afterEach(() => {
    executor.stopStaleReaper();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // T1.1: executeMessage emits exactly one agent_enter and one agent_exit
  // -------------------------------------------------------------------------

  test('T1.1: executeMessage emits exactly one agent_enter and one agent_exit', async () => {
    const sessionId = 'session-t1.1';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentEnters = traceEvents.filter((e) => e.type === 'agent_enter');
    const agentExits = traceEvents.filter((e) => e.type === 'agent_exit');

    expect(agentEnters).toHaveLength(1);
    expect(agentExits).toHaveLength(1);
  });

  test('emits one turn_start and turn_end around a user execution with shared turnId', async () => {
    const sessionId = 'session-turn-root';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const turnStarts = traceEvents.filter((e) => e.type === 'turn_start');
    const turnEnds = traceEvents.filter((e) => e.type === 'turn_end');
    expect(turnStarts).toHaveLength(1);
    expect(turnEnds).toHaveLength(1);

    const turnId = turnStarts[0]?.data.turnId;
    expect(typeof turnId).toBe('string');
    expect(turnEnds[0]?.data.turnId).toBe(turnId);
    expect(turnStarts[0]?.data).toEqual(
      expect.objectContaining({
        sessionId,
        agentName: 'TestAgent',
        messageSource: 'user',
        reasonCode: 'turn_start',
      }),
    );
    expect(turnEnds[0]?.data).toEqual(
      expect.objectContaining({
        sessionId,
        messageSource: 'user',
        outcome: 'continued',
        terminalAction: 'continue',
      }),
    );

    for (const eventType of ['user_message', 'agent_enter', 'agent_response', 'agent_exit']) {
      const event = traceEvents.find((e) => e.type === eventType);
      expect(event?.data.turnId).toBe(turnId);
    }
  });

  test('does not emit a nested turn root for resume intent replay', async () => {
    const sessionId = 'session-turn-resume-replay';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello again', undefined, onTraceEvent, {
      messageSource: 'resume',
      resumeIntentReplay: true,
      sourceAgent: 'ChildAgent',
      turnId: 'parent-turn-1',
    });

    expect(traceEvents.filter((e) => e.type === 'turn_start')).toHaveLength(0);
    expect(traceEvents.filter((e) => e.type === 'turn_end')).toHaveLength(0);
    expect(traceEvents.find((e) => e.type === 'agent_enter')?.data.trigger).toBe('resume_intent');
  });

  // -------------------------------------------------------------------------
  // T1.2: agent_enter includes channelMetadata when passed
  // -------------------------------------------------------------------------

  test('T1.2: agent_enter includes channelMetadata when passed', async () => {
    const sessionId = 'session-t1.2';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent, {
      channelMetadata: { channel: 'api', contentLength: 5 },
    });

    const agentEnter = traceEvents.find((e) => e.type === 'agent_enter');
    expect(agentEnter).toBeDefined();
    expect(agentEnter!.data.channel).toBe('api');
    expect(agentEnter!.data.contentLength).toBe(5);
  });

  // -------------------------------------------------------------------------
  // T1.3: agent_exit has correct lifecycleResult per exit path
  // -------------------------------------------------------------------------

  test('T1.3: agent_exit result is "continue" on normal reasoning completion', async () => {
    const sessionId = 'session-t1.3a';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    mockReasoningExecute.mockResolvedValue({
      response: 'done',
      action: { type: 'continue' },
    });

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');
    expect(agentExit).toBeDefined();
    expect(agentExit!.data.result).toBe('continue');
  });

  test('T1.3: agent_exit result is "error" when execution throws', async () => {
    const sessionId = 'session-t1.3b';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    mockReasoningExecute.mockRejectedValue(new Error('LLM failure'));

    await expect(
      executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent),
    ).rejects.toThrow('LLM failure');

    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');
    expect(agentExit).toBeDefined();
    expect(agentExit!.data.result).toBe('error');
  });

  // -------------------------------------------------------------------------
  // T1.4: agent_exit.durationMs is positive and reasonable
  // -------------------------------------------------------------------------

  test('T1.4: agent_exit.durationMs is non-negative', async () => {
    const sessionId = 'session-t1.4';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');
    expect(agentExit).toBeDefined();
    expect(typeof agentExit!.data.durationMs).toBe('number');
    expect(agentExit!.data.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // T1.5: Early exits do NOT emit lifecycle events
  // -------------------------------------------------------------------------

  test('T1.5: completed session emits zero lifecycle events', async () => {
    const sessionId = 'session-t1.5';
    const session = createMockSession(sessionId, { isComplete: true });
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentEnters = traceEvents.filter((e) => e.type === 'agent_enter');
    const agentExits = traceEvents.filter((e) => e.type === 'agent_exit');

    expect(agentEnters).toHaveLength(0);
    expect(agentExits).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T1.6: Recursive handoff emits separate lifecycle pairs
  // -------------------------------------------------------------------------

  test('T1.6: Recursive handoff emits separate lifecycle pairs with trigger=handoff', async () => {
    const sessionId = 'session-t1.6';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    let callCount = 0;
    mockReasoningExecute.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate handoff: call executeMessage recursively (same sessionId)
        await executor.executeMessage(sessionId, 'handoff message', undefined, onTraceEvent);
      }
      return { response: 'response', action: { type: 'continue' } };
    });

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentEnters = traceEvents.filter((e) => e.type === 'agent_enter');
    const agentExits = traceEvents.filter((e) => e.type === 'agent_exit');

    expect(agentEnters).toHaveLength(2);
    expect(agentExits).toHaveLength(2);

    // First enter is from outer call (user_message trigger)
    expect(agentEnters[0].data.trigger).toBe('user_message');
    // Second enter is from recursive call (handoff trigger)
    expect(agentEnters[1].data.trigger).toBe('handoff');

    // Both exits should have the same agent name
    expect(agentExits[0].data.agentName).toBe('TestAgent');
    expect(agentExits[1].data.agentName).toBe('TestAgent');
  });

  test('stores recursive handoff lifecycle events once through the parent turn sink', async () => {
    const sessionId = 'session-recursive-trace-sink';
    const session = createMockSession(sessionId, { agentName: 'ParentAgent' });
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    let callCount = 0;
    mockReasoningExecute.mockImplementation(
      async (_session, _systemPrompt, _tools, _onChunk, traceHandler) => {
        callCount++;
        if (callCount === 1) {
          session.agentName = 'ChildAgent';
          await executor.executeMessage(sessionId, 'handoff input', undefined, traceHandler, {
            messageSource: 'handoff',
            sourceAgent: 'ParentAgent',
          });
          session.agentName = 'ParentAgent';
        }
        return { response: 'response', action: { type: 'continue' } };
      },
    );

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const turnId = traceEvents.find((event) => event.type === 'turn_start')?.data.turnId;
    expect(typeof turnId).toBe('string');

    const storedEvents = mockTraceStoreAddEvent.mock.calls.map(([, event]) => event as TraceEvent);
    const agentEnters = storedEvents.filter((event) => event.type === 'agent_enter');
    expect(agentEnters).toHaveLength(2);

    const childAgentEnters = agentEnters.filter(
      (event) => event.data.agentName === 'ChildAgent' && event.data.trigger === 'handoff',
    );
    expect(childAgentEnters).toHaveLength(1);
    expect(childAgentEnters[0].data.turnId).toBe(turnId);
  });

  test('agent_enter includes causal source and stack context for handoff turns', async () => {
    const sessionId = 'session-causal-enter';
    const session = createMockSession(sessionId, {
      handoffStack: ['ParentAgent'],
      threadStack: [0],
    });
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'handoff input', undefined, onTraceEvent, {
      messageSource: 'handoff',
      sourceAgent: 'ParentAgent',
      parentSessionId: 'parent-session-1',
      parentThreadIndex: 0,
      childThreadIndex: 1,
    });

    const agentEnter = traceEvents.find((e) => e.type === 'agent_enter');
    expect(agentEnter).toBeDefined();
    expect(agentEnter!.data).toEqual(
      expect.objectContaining({
        agentName: 'TestAgent',
        sourceAgent: 'ParentAgent',
        targetAgent: 'TestAgent',
        trigger: 'handoff',
        messageSource: 'handoff',
        parentSessionId: 'parent-session-1',
        parentThreadIndex: 0,
        childThreadIndex: 1,
        threadStackDepth: 1,
        handoffStackDepth: 1,
        delegateStackDepth: 0,
      }),
    );
  });

  test('agent_exit includes normalized terminal action and next agent', async () => {
    const sessionId = 'session-causal-exit';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    mockReasoningExecute.mockImplementationOnce(async (runtimeSession: RuntimeSession) => {
      runtimeSession.agentName = 'NextAgent';
      return {
        response: 'handoff response',
        action: { type: 'handoff', target: 'NextAgent' },
      };
    });

    await executor.executeMessage(sessionId, 'please transfer', undefined, onTraceEvent);

    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');
    expect(agentExit).toBeDefined();
    expect(agentExit!.data).toEqual(
      expect.objectContaining({
        agentName: 'TestAgent',
        targetAgent: 'TestAgent',
        nextAgent: 'NextAgent',
        result: 'handoff',
        exitReason: 'handoff',
        exitReasonCode: 'agent_exit_handoff',
        reasonCode: 'agent_exit_handoff',
        terminalAction: 'handoff',
        responseDisposition: 'handoff',
      }),
    );
  });

  test('agent_exit records returned same-agent handoffs as continued parent control', async () => {
    const sessionId = 'session-returned-handoff-exit';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    mockReasoningExecute.mockImplementationOnce(async () => ({
      response: 'child returned response',
      action: { type: 'handoff', target: 'ChildAgent' },
    }));

    await executor.executeMessage(sessionId, 'please route and return', undefined, onTraceEvent);

    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');
    expect(agentExit).toBeDefined();
    expect(agentExit!.data).toEqual(
      expect.objectContaining({
        agentName: 'TestAgent',
        targetAgent: 'TestAgent',
        result: 'continue',
        exitReason: 'continue',
        exitReasonCode: 'agent_exit_continue',
        reasonCode: 'agent_exit_continue',
        terminalAction: 'continue',
        responseDisposition: 'continued',
        originalTerminalAction: 'handoff',
        returnedHandoff: true,
      }),
    );
    expect(agentExit!.data).not.toHaveProperty('nextAgent');
  });

  test('agent_exit includes normalized error details when execution fails', async () => {
    const sessionId = 'session-causal-error';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    mockReasoningExecute.mockRejectedValueOnce(new Error('Reasoning failure'));

    await expect(
      executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent),
    ).rejects.toThrow('Reasoning failure');

    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');
    expect(agentExit).toBeDefined();
    expect(agentExit!.data).toEqual(
      expect.objectContaining({
        result: 'error',
        exitReasonCode: 'agent_exit_error',
        terminalAction: 'error',
        responseDisposition: 'error',
        error: {
          type: 'execution_error',
          message: 'Reasoning failure',
        },
      }),
    );
  });

  test('streaming initializeSession guardrails pass the session recognizer registry into the pipeline', async () => {
    const sessionId = 'session-stream-init-pii';
    const customRegistry = { id: 'custom-registry' };
    const session = createMockSession(sessionId, {
      initialized: false,
      projectId: 'project-1',
      agentIR: {
        execution: { mode: 'reasoning' },
        constraints: {
          guardrails: [{ name: 'pii-check', kind: 'output', rules: [], priority: 1 }],
        },
        metadata: { name: 'TestAgent' },
        routing: {},
      } as RuntimeSession['agentIR'],
      piiRecognizerRegistry: customRegistry as RuntimeSession['piiRecognizerRegistry'],
    });
    sessions(executor).set(sessionId, session);

    await executor.initializeSession(sessionId, () => undefined);

    expect(mockCreateGuardrailPipeline).toHaveBeenCalledTimes(1);
    expect(mockCreateGuardrailPipeline.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        piiRecognizerRegistry: customRegistry,
      }),
    );
  });

  test('initializeSession refreshes session PII context before init-time streaming guardrails build the pipeline', async () => {
    const sessionId = 'session-stream-init-refresh';
    const hydratedRegistry = { id: 'hydrated-project-registry' };
    mockRefreshSessionPIIContext.mockImplementation(async (session: RuntimeSession) => {
      session.piiRecognizerRegistry =
        hydratedRegistry as unknown as RuntimeSession['piiRecognizerRegistry'];
    });

    const session = createMockSession(sessionId, {
      initialized: false,
      projectId: 'project-1',
      piiRecognizerRegistry: undefined,
      agentIR: {
        execution: { mode: 'reasoning' },
        constraints: {
          guardrails: [{ name: 'pii-check', kind: 'output', rules: [], priority: 1 }],
        },
        metadata: { name: 'TestAgent' },
        routing: {},
      } as RuntimeSession['agentIR'],
    });
    sessions(executor).set(sessionId, session);

    await executor.initializeSession(sessionId, () => undefined);

    expect(mockRefreshSessionPIIContext).toHaveBeenCalledWith(session);
    expect(mockCreateGuardrailPipeline).toHaveBeenCalledTimes(1);
    expect(mockCreateGuardrailPipeline.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        piiRecognizerRegistry: hydratedRegistry,
      }),
    );
  });

  test('initializeSession refreshes session PII context even without init-time streaming guardrails', async () => {
    const sessionId = 'session-init-refresh-no-stream';
    const session = createMockSession(sessionId, {
      initialized: false,
      agentIR: {
        execution: { mode: 'reasoning' },
        metadata: { name: 'TestAgent' },
        routing: {},
      } as RuntimeSession['agentIR'],
    });
    sessions(executor).set(sessionId, session);

    await executor.initializeSession(sessionId);

    expect(mockRefreshSessionPIIContext).toHaveBeenCalledWith(session);
    expect(mockCreateGuardrailPipeline).not.toHaveBeenCalled();
  });

  test('initializeSession centralizes and scrubs init-time traces before forwarding them', async () => {
    const sessionId = 'session-init-trace-centralized';
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const registry = { id: 'project-registry' };
    mockRefreshSessionPIIContext.mockImplementation(async (session: RuntimeSession) => {
      session.piiRecognizerRegistry =
        registry as unknown as RuntimeSession['piiRecognizerRegistry'];
    });
    mockScrubTraceEvent.mockImplementation(
      (
        data: Record<string, unknown>,
        options?: { piiRecognizerRegistry?: RuntimeSession['piiRecognizerRegistry'] },
      ) => {
        if (
          options?.piiRecognizerRegistry ===
          (registry as unknown as RuntimeSession['piiRecognizerRegistry'])
        ) {
          return {
            ...data,
            message: String(data.message).replace(rawContractId, '[REDACTED_CONTRACT_ID]'),
          };
        }
        return data;
      },
    );

    const session = createMockSession(sessionId, {
      initialized: false,
      agentIR: {
        execution: { mode: 'reasoning' },
        metadata: { name: 'TestAgent' },
        routing: {},
      } as RuntimeSession['agentIR'],
    });
    sessions(executor).set(sessionId, session);

    const forwarded: TraceEvent[] = [];
    mockExecuteOnStart.mockImplementationOnce(
      async (
        _session: RuntimeSession,
        _onChunk?: (chunk: string) => void,
        onTraceEvent?: (event: TraceEvent) => void,
      ) => {
        onTraceEvent?.({
          type: 'dsl_respond',
          data: { message: `Contract ${rawContractId}` },
        });
        return null;
      },
    );

    await executor.initializeSession(sessionId, undefined, (event: TraceEvent) =>
      forwarded.push(event),
    );

    expect(mockRefreshSessionPIIContext).toHaveBeenCalledWith(session);
    expect(mockScrubTraceEvent).toHaveBeenCalled();
    expect(mockTraceStoreAddEvent).toHaveBeenCalled();

    const storedEvent = mockTraceStoreAddEvent.mock.calls.find(
      (call: unknown[]) => call[0] === sessionId,
    )?.[1] as { data?: Record<string, unknown> } | undefined;

    expect(JSON.stringify(storedEvent?.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(storedEvent?.data)).not.toContain(rawContractId);
    expect(JSON.stringify(forwarded[0]?.data)).toContain('[REDACTED_CONTRACT_ID]');
    expect(JSON.stringify(forwarded[0]?.data)).not.toContain(rawContractId);
  });

  test('streaming executeMessage guardrails pass the session recognizer registry into the pipeline', async () => {
    const sessionId = 'session-stream-exec-pii';
    const customRegistry = { id: 'custom-registry' };
    const session = createMockSession(sessionId, {
      initialized: true,
      projectId: 'project-1',
      agentIR: {
        execution: { mode: 'reasoning', max_iterations: 5 },
        constraints: {
          guardrails: [{ name: 'pii-check', kind: 'output', rules: [], priority: 1 }],
        },
        metadata: { name: 'TestAgent' },
        routing: {},
      } as RuntimeSession['agentIR'],
      piiRecognizerRegistry: customRegistry as RuntimeSession['piiRecognizerRegistry'],
    });
    sessions(executor).set(sessionId, session);

    await executor.executeMessage(sessionId, 'hello', () => undefined, undefined, {
      actionEvent: {
        actionId: 'streaming-test',
        value: 'hello',
        source: 'quick_reply',
      },
    });

    expect(mockCreateGuardrailPipeline).toHaveBeenCalledTimes(1);
    expect(mockCreateGuardrailPipeline.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        piiRecognizerRegistry: customRegistry,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // T1.7: agent_exit fires when execution throws, with result="error"
  // -------------------------------------------------------------------------

  test('T1.7: agent_exit fires with result="error" when reasoning executor throws', async () => {
    const sessionId = 'session-t1.7';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    mockReasoningExecute.mockRejectedValue(new Error('Reasoning failure'));

    await expect(
      executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent),
    ).rejects.toThrow('Reasoning failure');

    // Verify agent_enter was emitted (before the error)
    const agentEnter = traceEvents.find((e) => e.type === 'agent_enter');
    expect(agentEnter).toBeDefined();

    // Verify agent_exit was emitted in the finally block with result='error'
    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');
    expect(agentExit).toBeDefined();
    expect(agentExit!.data.result).toBe('error');
    expect(agentExit!.data.agentName).toBe('TestAgent');
    expect(typeof agentExit!.data.durationMs).toBe('number');
  });

  // -------------------------------------------------------------------------
  // T1.8: WS handler main path no longer calls traceEmitter lifecycle
  // -------------------------------------------------------------------------

  test('T1.8: executeMessage lifecycle is self-contained — does not require external traceEmitter calls', async () => {
    // This verifies the contract that makes the WS handler main path correct:
    // executeMessage() emits agent_enter/agent_exit centrally, so the handler
    // does not need to call traceEmitter.logAgentEnter/logAgentExit.
    // The handler's main path delegates entirely to executeMessage().
    const sessionId = 'session-t1.8';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    // Call executeMessage directly (same as what handler's main path does)
    await executor.executeMessage(sessionId, 'handler test', undefined, onTraceEvent);

    // Lifecycle events should be present — executeMessage handles them centrally
    const agentEnters = traceEvents.filter((e) => e.type === 'agent_enter');
    const agentExits = traceEvents.filter((e) => e.type === 'agent_exit');

    expect(agentEnters).toHaveLength(1);
    expect(agentExits).toHaveLength(1);

    // Verify the lifecycle events are complete — no external traceEmitter call needed
    expect(agentEnters[0].data.agentName).toBe('TestAgent');
    expect(agentEnters[0].data.mode).toBe('reasoning');
    expect(agentEnters[0].data.trigger).toBe('user_message');
    expect(agentExits[0].data.result).toBe('continue');
    expect(typeof agentExits[0].data.durationMs).toBe('number');
  });

  // -------------------------------------------------------------------------
  // T1.9: WS handler fallback path still emits lifecycle
  // -------------------------------------------------------------------------

  test('T1.9: executeMessage without onTraceEvent succeeds and still stores events in TraceStore', async () => {
    const sessionId = 'session-t1.9';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    // Call without onTraceEvent callback
    const result = await executor.executeMessage(sessionId, 'no-callback test');

    // Execution succeeds
    expect(result).toBeDefined();
    expect(result.response).toBe('test response');

    // Even without an onTraceEvent callback, lifecycle events are persisted
    // to TraceStore via the centralized trace handler
    const { getTraceStore } = await import('../services/trace-store.js');
    const store = getTraceStore();
    const addEventCalls = (store.addEvent as ReturnType<typeof vi.fn>).mock.calls;
    const sessionCalls = addEventCalls.filter((call: unknown[]) => call[0] === sessionId);

    // TraceStore should have received agent_enter, user_message, agent_exit at minimum
    const storedTypes = sessionCalls.map(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type,
    );
    expect(storedTypes).toContain('agent_enter');
    expect(storedTypes).toContain('user_message');
    expect(storedTypes).toContain('agent_exit');
  });

  // -------------------------------------------------------------------------
  // T1.10: user_message emitted for both flow and reasoning mode
  // -------------------------------------------------------------------------

  test('T1.10: user_message emitted in reasoning mode', async () => {
    const sessionId = 'session-t1.10-reasoning';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'reasoning input', undefined, onTraceEvent);

    const userMessages = traceEvents.filter((e) => e.type === 'user_message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].data.message).toBe('reasoning input');
    expect(userMessages[0].data.sessionId).toBe(sessionId);
    expect(userMessages[0].data.agent).toBe('TestAgent');
  });

  test('T1.10: user_message emitted in flow mode', async () => {
    const sessionId = 'session-t1.10-flow';
    // Flow mode: session.currentFlowStep !== undefined
    const session = createMockSession(sessionId, {
      currentFlowStep: 'step_1',
    } as Partial<RuntimeSession>);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'flow input', undefined, onTraceEvent);

    const userMessages = traceEvents.filter((e) => e.type === 'user_message');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].data.message).toBe('flow input');
    expect(userMessages[0].data.sessionId).toBe(sessionId);
    expect(userMessages[0].data.agent).toBe('TestAgent');
  });

  // -------------------------------------------------------------------------
  // Additional lifecycle assertions
  // -------------------------------------------------------------------------

  test('agent_enter includes mode=reasoning for reasoning agents', async () => {
    const sessionId = 'session-mode-reasoning';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentEnter = traceEvents.find((e) => e.type === 'agent_enter');
    expect(agentEnter).toBeDefined();
    expect(agentEnter!.data.mode).toBe('reasoning');
    expect(agentEnter!.data.trigger).toBe('user_message');
    expect(agentEnter!.data.agentName).toBe('TestAgent');
  });

  test('agent_enter includes mode=scripted for flow agents', async () => {
    const sessionId = 'session-mode-flow';
    const session = createMockSession(sessionId, {
      currentFlowStep: 'welcome',
    } as Partial<RuntimeSession>);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentEnter = traceEvents.find((e) => e.type === 'agent_enter');
    expect(agentEnter).toBeDefined();
    expect(agentEnter!.data.mode).toBe('scripted');
  });

  test('agent_exit.agentName matches agent_enter.agentName', async () => {
    const sessionId = 'session-name-match';
    const session = createMockSession(sessionId, { agentName: 'BillingBot' });
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentEnter = traceEvents.find((e) => e.type === 'agent_enter');
    const agentExit = traceEvents.find((e) => e.type === 'agent_exit');

    expect(agentEnter).toBeDefined();
    expect(agentExit).toBeDefined();
    expect(agentEnter!.data.agentName).toBe('BillingBot');
    expect(agentExit!.data.agentName).toBe('BillingBot');
  });

  test('escalated session does not emit lifecycle events', async () => {
    const sessionId = 'session-escalated';
    const session = createMockSession(sessionId, {
      isEscalated: true,
      escalationReason: 'user requested',
    });
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const agentEnters = traceEvents.filter((e) => e.type === 'agent_enter');
    const agentExits = traceEvents.filter((e) => e.type === 'agent_exit');

    // Escalated sessions return early before the lifecycle emission point
    expect(agentEnters).toHaveLength(0);
    expect(agentExits).toHaveLength(0);
  });

  test('no lifecycle events when onTraceEvent is not provided', async () => {
    const sessionId = 'session-no-trace';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    // executeMessage with no onTraceEvent — should not throw
    const result = await executor.executeMessage(sessionId, 'hello');
    expect(result).toBeDefined();
    expect(result.response).toBe('test response');
  });

  test('lifecycle events order: user_message → agent_enter → ... → agent_exit', async () => {
    const sessionId = 'session-order';
    const session = createMockSession(sessionId);
    sessions(executor).set(sessionId, session);

    const traceEvents: TraceEvent[] = [];
    const onTraceEvent = (event: TraceEvent) => traceEvents.push(event);

    await executor.executeMessage(sessionId, 'hello', undefined, onTraceEvent);

    const types = traceEvents.map((e) => e.type);
    const userMsgIdx = types.indexOf('user_message');
    const enterIdx = types.indexOf('agent_enter');
    const exitIdx = types.indexOf('agent_exit');

    expect(userMsgIdx).toBeGreaterThanOrEqual(0);
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThanOrEqual(0);

    // user_message comes before agent_enter
    expect(userMsgIdx).toBeLessThan(enterIdx);
    // agent_enter comes before agent_exit
    expect(enterIdx).toBeLessThan(exitIdx);
    // agent_exit is the last lifecycle event
    expect(exitIdx).toBe(types.lastIndexOf('agent_exit'));
  });
});
