/**
 * SDK WebSocket Handler Tests
 *
 * Tests the SDK WebSocket handler (websocket/sdk-handler.ts).
 * Exercises token auth, session initialization, chat_message handling,
 * streaming responses, message validation, voice token requests, close/error lifecycle,
 * and edge cases.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import type { AuthRequirement } from '../../types/index.js';
import type { JoinResult, LiveSessionDiscoveryResult } from '../../services/omnichannel/types.js';

// =============================================================================
// MOCK DECLARATIONS — must come before any import that pulls them in
// =============================================================================

const mockGetRuntimeExecutor = vi.fn() as any;
const mockCompileToResolvedAgent = vi.fn() as any;
const mockResolveSessionTimeouts = vi.fn(async () => ({})) as any;
const mockCreateRuntimeSession = vi.fn() as any;
const mockServerApp: { locals: Record<string, any> } = { locals: {} };
const mockIsCoordinatorAvailable = vi.fn() as any;
const mockExecutionCoordinator = {
  submit: vi.fn(),
  cancel: vi.fn(async () => true),
  cancelSession: vi.fn(async () => {}),
};
const mockDiscoverLiveSession = vi.fn(async () => null) as any;
const mockJoinLiveSession = vi.fn(async () => ({
  success: false,
  backfill: [],
  participants: [],
  error: { code: 'NOT_FOUND', message: 'Live session not found' },
})) as any;
const mockIsLiveSyncActive = vi.fn(async () => false) as any;
const mockActivateLiveSync = vi.fn(async () => {}) as any;
const mockDetachParticipant = vi.fn(async () => {}) as any;
const mockEndLiveSync = vi.fn(async () => {}) as any;
const mockParticipantGetParticipants = vi.fn(async () => []) as any;
const mockParticipantNextSequence = vi.fn(async () => 1) as any;
const mockParticipantAddParticipant = vi.fn(async () => {}) as any;
const mockFanOutTranscriptItem = vi.fn() as any;
const mockFanOutParticipantEvent = vi.fn() as any;
const mockResolveOrCreateContact = vi.fn(async () => ({
  id: 'contact-sdk-verified-1',
  displayName: 'Verified SDK User',
})) as any;
const mockLinkSessionToContact = vi.fn(async () => {}) as any;
const mockResolveVoiceSession = vi.fn(async () => ({
  mode: 'pipeline',
  reason: 'not_configured',
})) as any;

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: any[]) => mockGetRuntimeExecutor(...args),
  compileToResolvedAgent: (...args: any[]) => mockCompileToResolvedAgent(...args),
  resolveProjectTools: vi.fn(async () => undefined),
}));

vi.mock('../../channels/pipeline/session-factory.js', () => ({
  createRuntimeSession: (...args: any[]) => mockCreateRuntimeSession(...args),
  resolveEnvironmentLabel: vi.fn((label: string) => label),
  resolveSessionTimeouts: (...args: any[]) => mockResolveSessionTimeouts(...args),
}));

vi.mock('../../services/llm/session-llm-client.js', () => ({
  TRACE_MODEL_UNKNOWN: 'unknown-model',
}));

const mockEnqueueLLMRequest = vi.fn(async (..._args: any[]) => ({
  response: 'Hello world',
  action: { type: 'continue' },
  stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
})) as any;
const mockPersistScopedMessage = vi.fn(async () => {}) as any;
const mockPersistScopedTurnMetrics = vi.fn(async () => {}) as any;
vi.mock('../../services/llm/llm-queue.js', () => ({
  enqueueLLMRequest: (...args: any[]) => mockEnqueueLLMRequest(...args),
  BackpressureError: class BackpressureError extends Error {
    constructor(msg?: string) {
      super(msg || 'backpressure');
      this.name = 'BackpressureError';
    }
  },
  isLLMQueueEnabled: vi.fn(() => true),
}));

vi.mock('../../services/execution/coordinator-singleton.js', () => ({
  getExecutionCoordinator: vi.fn(() => mockExecutionCoordinator),
  isCoordinatorAvailable: (...args: any[]) => mockIsCoordinatorAvailable(...args),
}));

const mockIsDatabaseAvailable = vi.fn(() => false) as any;
vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: (...args: any[]) => mockIsDatabaseAvailable(...args),
}));

const TEST_JWT_SECRET = 'test-jwt-secret-for-sdk-handler';
const TEST_SDK_SESSION_SIGNING_SECRET = 'test-sdk-session-signing-secret-for-sdk-handler';
const TEST_SDK_BOOTSTRAP_SIGNING_SECRET = 'test-sdk-bootstrap-signing-secret-for-sdk-handler';
const BOOKING_AGENT_DSL = 'AGENT: booking_agent\nGOAL: Help with bookings';
const TEST_AGENT_DSL = 'AGENT: test_agent\nGOAL: Help with SDK messages';

function makeValidatedProjectAgent(name: string, dslContent: string) {
  return {
    name,
    dslContent,
    dslValidationStatus: 'valid',
  };
}

const mockGetConfig = vi.fn(() => ({
  env: 'test',
  jwt: { secret: TEST_JWT_SECRET },
  auth: {
    sdk: {
      sessionSigningSecret: TEST_SDK_SESSION_SIGNING_SECRET,
      bootstrapSigningSecret: TEST_SDK_BOOTSTRAP_SIGNING_SECRET,
    },
  },
  llm: { provider: 'openai', defaultModel: 'gpt-4o-mini' },
  security: { superAdminUserIds: [] },
  server: {
    apiUrl: 'http://localhost:3112',
    port: 3112,
  },
  channelLifecycle: {
    web_chat: { defaultDisposition: 'abandoned', disconnectBehavior: 'detach' },
    api: { defaultDisposition: 'completed', disconnectBehavior: 'end' },
  },
})) as any;

vi.mock('../../config/index.js', () => ({
  getConfig: (...args: any[]) => mockGetConfig(...args),
}));

const mockLoaderIsConfigLoaded = vi.fn(() => true);
const mockLoaderGetConfig = vi.fn(() => ({
  channelLifecycle: {
    web_chat: { defaultDisposition: 'abandoned', disconnectBehavior: 'detach' },
    api: { defaultDisposition: 'completed', disconnectBehavior: 'end' },
  },
}));

vi.mock('../../config/loader.js', () => ({
  isConfigLoaded: (...args: any[]) => mockLoaderIsConfigLoaded(...args),
  getConfig: (...args: any[]) => mockLoaderGetConfig(...args),
}));

vi.mock('../../middleware/auth.js', () => ({
  SDK_TOKEN_ISSUER: 'abl-platform',
  SDK_TOKEN_AUDIENCE: 'sdk-session',
  extractUserIdFromToken: vi.fn(),
}));

const mockCheckAuthPreflightFromIR = vi.fn(async () => null) as any;
const mockEvaluateAuthPreflightFromIR = vi.fn(
  async (): Promise<{ pending: AuthRequirement[]; satisfied: AuthRequirement[] }> => ({
    pending: [],
    satisfied: [],
  }),
) as any;
const mockHasActiveAuthGateAsync = vi.fn(async () => false) as any;
const mockQueueMessageBehindAuthGateAsync = vi.fn(async () => {}) as any;
const mockReconcileAuthGateWithEvaluationAsync = vi.fn(async () => null) as any;
const mockCleanupAuthGateAsync = vi.fn(async () => {}) as any;
const mockCreateTokenLookups = vi.fn(() => ({})) as any;

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  checkAuthPreflightFromIR: (...args: any[]) => mockCheckAuthPreflightFromIR(...args),
  evaluateAuthPreflightFromIR: (...args: any[]) => mockEvaluateAuthPreflightFromIR(...args),
  hasActiveAuthGateAsync: (...args: any[]) => mockHasActiveAuthGateAsync(...args),
  queueMessageBehindAuthGateAsync: (...args: any[]) => mockQueueMessageBehindAuthGateAsync(...args),
  reconcileAuthGateWithEvaluationAsync: (...args: any[]) =>
    mockReconcileAuthGateWithEvaluationAsync(...args),
  cleanupAuthGateAsync: (...args: any[]) => mockCleanupAuthGateAsync(...args),
  createTokenLookups: (...args: any[]) => mockCreateTokenLookups(...args),
}));

const mockPausedExecutionStore = {
  cleanupSession: vi.fn(async () => {}) as any,
  get: vi.fn(() => undefined) as any,
  resolveDistributed: vi.fn(async () => 'resolved') as any,
  rejectDistributed: vi.fn(async () => 'rejected') as any,
};

vi.mock('../../services/auth-profile/paused-execution-store.js', () => ({
  getPausedExecutionStore: vi.fn(() => mockPausedExecutionStore),
}));

const mockConversationStore = {
  createSession: vi.fn(async () => ({ id: 'db-session-1' })) as any,
  getSession: vi.fn(async () => null) as any,
  updateSession: vi.fn(async () => ({})) as any,
  linkContact: vi.fn(async () => {}) as any,
  endSession: vi.fn(async () => {}) as any,
};

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: mockConversationStore,
  })),
}));

vi.mock('../../repos/session-repo.js', () => ({
  findSessionPersistenceContexts: vi.fn().mockResolvedValue([]),
  updateSession: vi.fn(async () => ({})),
}));

const mockFindProjectWithAgents = vi.fn(async () => null) as any;
const mockFindProjectRuntimeConfig = vi.fn(async () => null) as any;
const mockFindSDKChannelById = vi.fn(async () => null) as any;
const mockFindPublicApiKey = vi.fn(async () => null) as any;
const mockFindWidgetConfig = vi.fn(async () => null) as any;
const mockUpdateSDKChannel = vi.fn(async () => null) as any;
const mockFindProjectAgentForProject = vi.fn(async () => null) as any;
const mockResolveProjectEntryAgentName = vi.fn(
  (project: { agents?: Array<{ name?: string }> }) => project.agents?.[0]?.name ?? 'test_agent',
) as any;
vi.mock('../../repos/project-repo.js', () => ({
  findProjectRuntimeConfig: (...args: any[]) => mockFindProjectRuntimeConfig(...args),
  findProjectWithAgents: (...args: any[]) => mockFindProjectWithAgents(...args),
  findProjectAgentForProject: (...args: any[]) => mockFindProjectAgentForProject(...args),
  resolveProjectEntryAgentName: (...args: any[]) => mockResolveProjectEntryAgentName(...args),
}));

const mockFindProjectSettings = vi.fn(async () => null);
vi.mock('../../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: any[]) => mockFindProjectSettings(...args),
}));

vi.mock('../../repos/channel-repo.js', () => ({
  findPublicApiKey: (...args: any[]) => mockFindPublicApiKey(...args),
  findSDKChannelById: (...args: any[]) => mockFindSDKChannelById(...args),
  findWidgetConfig: (...args: any[]) => mockFindWidgetConfig(...args),
  updateSDKChannel: (...args: any[]) => mockUpdateSDKChannel(...args),
}));

const mockFindDeploymentById = vi.fn(async () => null) as any;
const mockFindActiveDeployment = vi.fn(async () => null) as any;
vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: (...args: any[]) => mockFindActiveDeployment(...args),
  findDeploymentById: (...args: any[]) => mockFindDeploymentById(...args),
}));

const mockConsumeSdkWsTicket = vi.fn();
vi.mock('../../services/identity/sdk-ws-ticket-store.js', () => ({
  consumeSdkWsTicket: (...args: unknown[]) => mockConsumeSdkWsTicket(...args),
}));

const mockDeploymentResolverResolve = vi.fn(async () => ({
  entryAgent: 'test_agent',
  agents: {},
  compilationOutput: { agents: {} },
  sourceHash: 'abc',
  versionInfo: { versions: { test_agent: 1 }, environment: 'dev' },
})) as any;

const mockGetSessionService = vi.fn() as any;
const mockResolveSession = vi.fn(async () => ({ outcome: 'missing', reason: 'no_match' })) as any;
const mockRegisterResolutionKey = vi.fn(async () => {}) as any;

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve = mockDeploymentResolverResolve;
  },
  mergeWorkingCopyModules: vi.fn(async (working: unknown) => working),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: (...args: any[]) => mockGetSessionService(...args),
}));

vi.mock('../../services/identity/session-resolver.js', () => ({
  resolveSession: (...args: any[]) => mockResolveSession(...args),
  registerResolutionKey: (...args: any[]) => mockRegisterResolutionKey(...args),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: vi.fn(async () => {}),
  // The live-join inbound path (typed interrupt) persists the user message
  // via persistMessage but the assistant reply via persistMessageRecord so
  // it can carry structuredContent + metadata + messageId. Both must be
  // present on the mock for the omnichannel assertions to observe the
  // assistant fan-out.
  persistMessageRecord: vi.fn(async () => {}),
  persistScopedMessage: (...args: any[]) => mockPersistScopedMessage(...args),
  persistScopedTurnMetrics: (...args: any[]) => mockPersistScopedTurnMetrics(...args),
  persistTurnMetrics: vi.fn(async () => {}),
  flushMessageQueue: vi.fn(async () => {}),
}));

const mockCleanupClosedSessionArtifacts = vi.fn(async () => {});
vi.mock('../../services/session-lifecycle/artifact-cleanup.js', () => ({
  cleanupClosedSessionArtifacts: (...args: any[]) => mockCleanupClosedSessionArtifacts(...args),
}));

const mockIsSessionTerminalizationEnabled = vi.fn(() => true);
const mockTerminateConversationSession = vi.fn(async () => ({
  sessionId: 'runtime-session-001',
  disposition: 'completed',
  status: 'completed',
  endedAt: '2026-03-30T10:00:00.000Z',
  eventEmitted: true,
  eventId: 'evt-sdk-1',
  hook: { attempted: false },
  runtimeEnded: true,
  dbUpdated: true,
  artifactSessionIds: ['runtime-session-001'],
}));
vi.mock('../../services/session-lifecycle/terminalization-service.js', () => ({
  isSessionTerminalizationEnabled: (...args: any[]) => mockIsSessionTerminalizationEnabled(...args),
  SessionTerminalizationService: class MockSessionTerminalizationService {
    terminateConversationSession = (...args: any[]) => mockTerminateConversationSession(...args);
  },
}));
vi.mock('../../services/voice/deepgram-service.js', () => ({
  getDeepgramService: vi.fn(() => ({
    isConfigured: vi.fn(() => false),
    createConnection: vi.fn(),
  })),
}));

vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  getElevenLabsService: vi.fn(() => ({
    isConfigured: vi.fn(() => false),
  })),
}));

vi.mock('../../services/voice/voice-service-factory.js', () => ({}));

vi.mock('../../services/voice/voice-session-resolver.js', () => ({
  resolveVoiceSession: (...args: any[]) => mockResolveVoiceSession(...args),
}));

vi.mock('../../services/omnichannel/live-session-service.js', () => ({
  discoverLiveSession: (...args: any[]) => mockDiscoverLiveSession(...args),
  joinLiveSession: (...args: any[]) => mockJoinLiveSession(...args),
  isLiveSyncActive: (...args: any[]) => mockIsLiveSyncActive(...args),
  activateLiveSync: (...args: any[]) => mockActivateLiveSync(...args),
  detachParticipant: (...args: any[]) => mockDetachParticipant(...args),
  endLiveSync: (...args: any[]) => mockEndLiveSync(...args),
}));

vi.mock('../../services/omnichannel/participant-registry.js', () => ({
  getParticipants: (...args: any[]) => mockParticipantGetParticipants(...args),
  nextSequence: (...args: any[]) => mockParticipantNextSequence(...args),
  addParticipant: (...args: any[]) => mockParticipantAddParticipant(...args),
}));

vi.mock('../../services/identity/contact-linking-deps.js', () => ({
  getContactLinkingDeps: vi.fn(() => ({
    resolveOrCreateContact: {
      execute: (...args: any[]) => mockResolveOrCreateContact(...args),
    },
    linkSessionToContact: {
      execute: (...args: any[]) => mockLinkSessionToContact(...args),
    },
  })),
  setContactLinkingDeps: vi.fn(),
  clearContactLinkingDeps: vi.fn(),
}));

vi.mock('../../services/omnichannel/transcript-fanout.js', () => ({
  fanOutTranscriptItem: (...args: any[]) => mockFanOutTranscriptItem(...args),
  fanOutParticipantEvent: (...args: any[]) => mockFanOutParticipantEvent(...args),
}));

vi.mock('../../server.js', () => ({
  app: mockServerApp,
}));

vi.mock('../../observability/voice-trace.js', () => ({
  startVoiceTurn: vi.fn(),
  getActiveVoiceTurn: vi.fn(),
  startSTTPhase: vi.fn(),
  completeSTTPhase: vi.fn(),
  startLLMPhase: vi.fn(),
  completeLLMPhase: vi.fn(),
  startTTSPhase: vi.fn(),
  recordTTSFirstChunk: vi.fn(),
  completeTTSPhase: vi.fn(),
  completeVoiceTurn: vi.fn(),
  failVoiceTurn: vi.fn(),
  createTimingReportEvent: vi.fn(),
}));

vi.mock('../../services/stores/clickhouse-message-store.js', () => ({
  ClickHouseMessageStore: vi.fn(),
}));

vi.mock('../../services/stores/clickhouse-metrics-store.js', () => ({
  ClickHouseMetricsStore: vi.fn(),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// IMPORT UNDER TEST (after all mocks)
// =============================================================================

import {
  handleSDKConnection,
  sdkClients,
  setConnectionRegistry,
} from '../../websocket/sdk-handler.js';
import {
  registerRealtimeInterruptionTarget,
  resetRealtimeInterruptionCoordinatorForTests,
} from '../../services/voice/realtime-interruption-coordinator.js';
import { WebSocketConnectionRegistry } from '../../websocket/connection-registry.js';
import { ServerMessages, serializeServerMessage } from '../../websocket/events.js';
import { persistMessage, persistMessageRecord } from '../../services/message-persistence-queue.js';
import { WS_MESSAGE_TIMEOUT_MS } from '../../services/channel/constants.js';

// =============================================================================
// HELPERS
// =============================================================================

/** WebSocket mock that supports EventEmitter pattern */
class MockWebSocket extends EventEmitter {
  /** ws.OPEN constant — required for readyState comparison in send() */
  OPEN = 1 as const;
  readyState = 1; // OPEN
  send = vi.fn();
  close = vi.fn();

  /** Simulate receiving a message from the client */
  simulateMessage(data: string) {
    this.emit('message', Buffer.from(data));
  }

  /** Simulate WebSocket close event */
  simulateClose() {
    this.emit('close');
  }

  /** Simulate WebSocket error event */
  simulateError(error: Error) {
    this.emit('error', error);
  }
}

/** Create a minimal IncomingMessage stub with SDK auth carried in the WS subprotocol header. */
let requestIpCounter = 0;

function makeReq(
  params: {
    token?: string;
    queryToken?: string;
    protocolHeader?: string;
    remoteAddress?: string;
  } = {},
): any {
  const query = new URLSearchParams();
  if (params.queryToken) query.set('token', params.queryToken);
  const qs = query.toString();
  const protocolHeader =
    params.protocolHeader ?? (params.token ? `sdk-auth, ${params.token}` : undefined);
  const remoteAddress = params.remoteAddress ?? `127.0.0.${String((requestIpCounter++ % 250) + 1)}`;
  return {
    url: `/ws/sdk${qs ? `?${qs}` : ''}`,
    headers: {
      host: 'localhost:3112',
      ...(protocolHeader ? { 'sec-websocket-protocol': protocolHeader } : {}),
    },
    socket: { remoteAddress },
  };
}

/** Create a valid SDK session token */
function createSDKToken(overrides: Record<string, any> = {}): string {
  const payload = {
    type: 'sdk_session',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    channelId: 'channel-1',
    sessionId: 'sdk-session-1',
    permissions: ['session:send_message', 'session:voice'],
    bootstrapType: 'public_key',
    bootstrapKeyId: 'pk-1',
    ...overrides,
  };
  return jwt.sign(payload, TEST_SDK_SESSION_SIGNING_SECRET, {
    issuer: 'abl-platform',
    audience: 'sdk-session',
    expiresIn: '1h',
  });
}

/** Create a mock RuntimeSession */
function makeRuntimeSession(overrides: Record<string, any> = {}): any {
  return {
    id: overrides.id ?? 'runtime-session-001',
    agentName: overrides.agentName ?? 'test_agent',
    agentIR: overrides.agentIR ?? null,
    compilationOutput: null,
    conversationHistory: overrides.conversationHistory ?? [],
    state: {
      gatherProgress: {},
      context: {},
      conversationPhase: 'active',
      ...(overrides.state ?? {}),
    },
    data: {},
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    initialized: true,
    currentFlowStep: overrides.currentFlowStep,
    versionInfo: overrides.versionInfo,
    tenantId: overrides.tenantId,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

/** Build a mock RuntimeExecutor */
function makeMockExecutor(overrides: Record<string, any> = {}) {
  return {
    isConfigured: vi.fn(() => true),
    createSessionFromResolved: vi.fn((_resolved: unknown, options?: Record<string, any>) =>
      makeRuntimeSession({
        id: options?.sessionId,
      }),
    ),
    executeMessage: vi.fn(async (_id: string, _text: string, onChunk?: (c: string) => void) => {
      if (onChunk) {
        onChunk('Hello ');
        onChunk('world');
      }
      return {
        response: 'Hello world',
        action: { type: 'continue' },
        stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
      };
    }),
    initializeSession: vi.fn(async () => null),
    getSession: vi.fn(() => undefined),
    endSession: vi.fn(),
    detachSession: vi.fn(),
    rewireSessionToolExecutor: vi.fn(),
    ensureLLMReady: vi.fn(async () => {}),
    saveSessionSnapshot: vi.fn(async () => {}),
    checkSessionQuota: vi.fn(),
    releaseSessionSlot: vi.fn(),
    ...overrides,
  };
}

/** Parse all messages sent to ws.send */
function getSentMessages(ws: MockWebSocket): any[] {
  return ws.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

/** Find the first sent message of a given type */
function findSentMessage(ws: MockWebSocket, type: string): any | undefined {
  return getSentMessages(ws).find((m: any) => m.type === type);
}

/** Find all sent messages of a given type */
function findAllSentMessages(ws: MockWebSocket, type: string): any[] {
  return getSentMessages(ws).filter((m: any) => m.type === type);
}

function toWireServerMessage(
  message: ReturnType<(typeof ServerMessages)[keyof typeof ServerMessages]>,
): any {
  return JSON.parse(serializeServerMessage(message));
}

// =============================================================================
// SHARED SETUP
// =============================================================================

let ws: MockWebSocket;
let executor: ReturnType<typeof makeMockExecutor>;

function makeRuntimeSessionResult(overrides: Record<string, any> = {}) {
  const versionInfo =
    overrides.versionInfo ??
    ({
      environment: 'dev',
      versions: { test_agent: 1 },
    } as const);
  const runtimeSession = makeRuntimeSession({
    id: overrides.sessionId ?? 'sdk-session-1',
    agentName: overrides.agentName ?? 'test_agent',
    versionInfo,
  });

  return {
    runtimeSession,
    entryAgentName: overrides.entryAgentName ?? runtimeSession.agentName,
    resolved: {
      entryAgent: overrides.entryAgentName ?? runtimeSession.agentName,
      versionInfo,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockServerApp.locals = {};
  setConnectionRegistry(null);
  resetRealtimeInterruptionCoordinatorForTests();

  ws = new MockWebSocket();
  executor = makeMockExecutor();

  mockGetRuntimeExecutor.mockReturnValue(executor);
  mockCompileToResolvedAgent.mockReturnValue({
    agents: {},
    entryAgent: 'sdk_agent',
    compilationOutput: { agents: {} },
    sourceHash: 'def',
    versionInfo: { environment: 'dev', versions: {} },
  });
  mockIsDatabaseAvailable.mockReturnValue(false);
  mockIsCoordinatorAvailable.mockReturnValue(false);
  mockExecutionCoordinator.submit.mockResolvedValue({
    status: 'completed',
    response: 'Hello world',
    resultData: {
      response: 'Hello world',
      action: { type: 'continue' },
      stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
    },
  });
  mockFindProjectWithAgents.mockResolvedValue(null);
  mockFindProjectRuntimeConfig.mockResolvedValue(null);
  mockFindSDKChannelById.mockResolvedValue({
    id: 'channel-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    isActive: true,
    publicApiKeyId: 'pk-1',
    deploymentId: null,
    environment: null,
    followEnvironment: false,
    config: {},
  });
  mockFindPublicApiKey.mockResolvedValue({
    id: 'pk-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    isActive: true,
    permissions: { chat: true, voice: true },
  });
  mockFindWidgetConfig.mockResolvedValue({ chatEnabled: true, voiceEnabled: true });
  mockFindDeploymentById.mockResolvedValue(null);
  mockFindActiveDeployment.mockResolvedValue(null);
  mockUpdateSDKChannel.mockResolvedValue(null);
  mockFindProjectAgentForProject.mockResolvedValue(null);
  mockResolveProjectEntryAgentName.mockImplementation(
    (project: { agents?: Array<{ name?: string }> }) => project.agents?.[0]?.name ?? 'test_agent',
  );
  mockFindProjectSettings.mockResolvedValue(null);
  mockConsumeSdkWsTicket.mockResolvedValue({ success: false, reason: 'missing' });
  mockLoaderIsConfigLoaded.mockReturnValue(true);
  mockResolveSessionTimeouts.mockResolvedValue({});
  mockCreateRuntimeSession.mockImplementation(async (ctx: Record<string, any>) =>
    makeRuntimeSessionResult({
      sessionId: ctx.sessionId,
      versionInfo: {
        environment: ctx.environment ?? 'dev',
        versions: { test_agent: 1 },
      },
    }),
  );
  mockCleanupClosedSessionArtifacts.mockResolvedValue(undefined);
  mockIsSessionTerminalizationEnabled.mockReturnValue(true);
  mockTerminateConversationSession.mockResolvedValue({
    sessionId: 'runtime-session-001',
    disposition: 'completed',
    status: 'completed',
    endedAt: '2026-03-30T10:00:00.000Z',
    eventEmitted: true,
    eventId: 'evt-sdk-1',
    hook: { attempted: false },
    runtimeEnded: true,
    dbUpdated: true,
    artifactSessionIds: ['runtime-session-001'],
  });
  mockConversationStore.getSession.mockResolvedValue(null);
  mockConversationStore.createSession.mockResolvedValue({ id: 'db-session-1' });
  mockConversationStore.updateSession.mockResolvedValue({});
  mockConversationStore.linkContact.mockResolvedValue(undefined);
  mockCheckAuthPreflightFromIR.mockResolvedValue(null);
  mockEvaluateAuthPreflightFromIR.mockResolvedValue({
    pending: [],
    satisfied: [],
  });
  mockHasActiveAuthGateAsync.mockResolvedValue(false);
  mockQueueMessageBehindAuthGateAsync.mockResolvedValue(true);
  mockReconcileAuthGateWithEvaluationAsync.mockResolvedValue(null);
  mockCleanupAuthGateAsync.mockResolvedValue(undefined);
  mockResolveOrCreateContact.mockResolvedValue({
    id: 'contact-sdk-verified-1',
    displayName: 'Verified SDK User',
  });
  mockLinkSessionToContact.mockResolvedValue(undefined);
  mockCreateTokenLookups.mockReturnValue({});
  mockPausedExecutionStore.get.mockReturnValue(undefined);
  mockPausedExecutionStore.resolveDistributed.mockResolvedValue('resolved');
  mockPausedExecutionStore.rejectDistributed.mockResolvedValue('rejected');
  mockDiscoverLiveSession.mockResolvedValue(null);
  mockJoinLiveSession.mockResolvedValue({
    success: false,
    backfill: [],
    participants: [],
    error: { code: 'NOT_FOUND', message: 'Live session not found' },
  });
  mockParticipantGetParticipants.mockResolvedValue([]);
  mockParticipantNextSequence.mockResolvedValue(1);
  mockParticipantAddParticipant.mockResolvedValue(undefined);
  mockResolveVoiceSession.mockResolvedValue({
    mode: 'pipeline',
    reason: 'not_configured',
  });
  mockResolveSession.mockResolvedValue({ outcome: 'missing', reason: 'no_match' });
  mockRegisterResolutionKey.mockResolvedValue(undefined);
  mockGetSessionService.mockReturnValue({
    isDistributed: vi.fn(() => false),
    store: {},
  });

  // Default: queue returns standard response (queue is always active now)
  mockEnqueueLLMRequest.mockImplementation(async () => ({
    response: 'Hello world',
    action: { type: 'continue' },
    stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
  }));

  // Clear the sdkClients map
  sdkClients.clear();
});

// =============================================================================
// TESTS
// =============================================================================

describe('SDK WebSocket Handler — handleSDKConnection', () => {
  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  describe('authentication', () => {
    test('closes connection with 4001 when no token is provided', async () => {
      await handleSDKConnection(ws as any, makeReq());

      expect(ws.close).toHaveBeenCalledWith(4001, expect.stringContaining('Missing token'));
    });

    test('accepts token from WebSocket subprotocol when query param is absent', async () => {
      const token = createSDKToken();

      await handleSDKConnection(ws as any, makeReq({ protocolHeader: `sdk-auth, ${token}` }));

      expect(findSentMessage(ws, 'session_start')).toBeTruthy();
    });

    test('accepts one-time ticket from WebSocket subprotocol', async () => {
      mockConsumeSdkWsTicket.mockResolvedValue({
        success: true,
        record: {
          payload: {
            type: 'sdk_session',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelId: 'channel-1',
            sessionId: 'sdk-session-ticket',
            sessionPrincipal: 'sdk-session-ticket',
            permissions: ['session:send_message', 'session:voice'],
            bootstrapType: 'public_key',
            bootstrapKeyId: 'pk-1',
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
          },
          envelope: 'signed',
          issuedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      });

      await handleSDKConnection(ws as any, makeReq({ protocolHeader: 'sdk-ticket, ticket-1' }));

      expect(mockConsumeSdkWsTicket).toHaveBeenCalledWith('ticket-1');
      expect(findSentMessage(ws, 'session_start')).toBeTruthy();
    });

    test('rejects replayed or missing one-time tickets', async () => {
      await handleSDKConnection(ws as any, makeReq({ protocolHeader: 'sdk-ticket, ticket-1' }));

      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining('Invalid or expired'));
    });

    test('rejects query-string token transport when sdk-auth subprotocol is missing', async () => {
      const token = createSDKToken();

      await handleSDKConnection(ws as any, makeReq({ queryToken: token }));

      expect(ws.close).toHaveBeenCalledWith(4001, expect.stringContaining('Missing token'));
    });

    test('closes connection with 4003 for invalid token', async () => {
      await handleSDKConnection(ws as any, makeReq({ token: 'bad-token' }));

      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining('Invalid or expired'));
    });

    test('closes connection with 4003 for expired token', async () => {
      const expiredToken = jwt.sign(
        {
          type: 'sdk_session',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channelId: 'channel-1',
          permissions: ['session:send_message'],
        },
        TEST_SDK_SESSION_SIGNING_SECRET,
        { issuer: 'abl-platform', audience: 'sdk-session', expiresIn: '-1s' },
      );

      await handleSDKConnection(ws as any, makeReq({ token: expiredToken }));

      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining('Invalid or expired'));
    });

    test('closes connection with 4003 for wrong token type', async () => {
      const wrongTypeToken = jwt.sign(
        {
          type: 'user_session',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channelId: 'channel-1',
          permissions: ['session:send_message'],
        },
        TEST_SDK_SESSION_SIGNING_SECRET,
        { issuer: 'abl-platform', audience: 'sdk-session', expiresIn: '1h' },
      );

      await handleSDKConnection(ws as any, makeReq({ token: wrongTypeToken }));

      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining('Invalid or expired'));
    });

    test('closes connection with 4003 for wrong issuer', async () => {
      const wrongIssuerToken = jwt.sign(
        {
          type: 'sdk_session',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channelId: 'channel-1',
          permissions: ['session:send_message'],
        },
        TEST_SDK_SESSION_SIGNING_SECRET,
        { issuer: 'wrong-issuer', audience: 'sdk-session', expiresIn: '1h' },
      );

      await handleSDKConnection(ws as any, makeReq({ token: wrongIssuerToken }));

      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining('Invalid or expired'));
    });

    test('closes connection with 4003 for user-scoped tokens without a verified user identity', async () => {
      const token = createSDKToken({
        authScope: 'user',
        identityTier: 0,
        userContext: {
          userId: 'unsigned-user',
        },
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining('Invalid or expired'));
      expect(findSentMessage(ws, 'session_start')).toBeUndefined();
    });

    test('closes connection with 4003 for tokens missing channel scope', async () => {
      const token = createSDKToken({
        channelId: '',
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(ws.close).toHaveBeenCalledWith(4003, expect.stringContaining('Invalid or expired'));
      expect(findSentMessage(ws, 'session_start')).toBeUndefined();
    });

    test('authenticates successfully with valid SDK session token', async () => {
      const token = createSDKToken();

      await handleSDKConnection(ws as any, makeReq({ token }));

      // Should NOT close the connection
      expect(ws.close).not.toHaveBeenCalled();

      // Should send session_start
      const sessionStart = findSentMessage(ws, 'session_start');
      expect(sessionStart).toBeDefined();
      expect(sessionStart.sessionId).toBe('sdk-session-1');
      expect(sessionStart.projectId).toBe('proj-1');
    });

    test('extracts permissions from token payload', async () => {
      const token = createSDKToken({
        permissions: ['session:send_message'],
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      const sessionStart = findSentMessage(ws, 'session_start');
      expect(sessionStart.permissions.chat).toBe(true);
      expect(sessionStart.permissions.voice).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Session initialization
  // ---------------------------------------------------------------------------

  describe('session initialization', () => {
    test('initializes with default agent when database not available', async () => {
      mockIsDatabaseAvailable.mockReturnValue(false);
      mockCompileToResolvedAgent.mockReturnValue({
        agents: {},
        entryAgent: 'sdk_agent',
        compilationOutput: { agents: {} },
        sourceHash: 'def',
        versionInfo: { versions: {} },
      });
      const token = createSDKToken();

      await handleSDKConnection(ws as any, makeReq({ token }));

      // Fallback path: compiles default DSL and creates a session
      expect(mockCompileToResolvedAgent).toHaveBeenCalled();
      expect(mockCreateRuntimeSession).not.toHaveBeenCalled();
      expect(executor.createSessionFromResolved).toHaveBeenCalled();
      expect(executor.createSessionFromResolved).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessionId: 'sdk-session-1' }),
      );

      const sessionStart = findSentMessage(ws, 'session_start');
      expect(sessionStart).toBeDefined();
    });

    test('checks quota against the stable SDK session id before creating the session', async () => {
      const token = createSDKToken({ sessionId: 'sdk-session-stable' });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(executor.checkSessionQuota).toHaveBeenCalledWith(
        'tenant-1',
        'proj-1',
        'sdk-session-stable',
      );
    });

    test('uses the SDK session principal for anonymous session-scoped auth', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectWithAgents.mockResolvedValue({
        _id: 'proj-1',
        tenantId: 'tenant-1',
        agents: [makeValidatedProjectAgent('booking_agent', BOOKING_AGENT_DSL)],
      } as any);
      const token = createSDKToken({
        sessionId: 'sdk-session-anon',
        authScope: 'session',
        identityTier: 0,
        verificationMethod: 'none',
        userContext: {
          userId: 'metadata-only-user',
          customAttributes: { plan: 'free' },
        },
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockCreateRuntimeSession).toHaveBeenCalled();
      const options = mockCreateRuntimeSession.mock.calls[0]?.[0] as
        | {
            userId: string;
            callerData?: Record<string, unknown>;
            callerContext: {
              customerId?: string;
              anonymousId?: string;
              sessionPrincipalId?: string;
              authScope?: string;
            };
          }
        | undefined;
      expect(options).toBeDefined();
      expect(options?.userId).toBe('sdk-session-anon');
      expect(options?.callerData).toEqual({ plan: 'free' });
      expect(options?.callerContext.customerId).toBeUndefined();
      expect(options?.callerContext.anonymousId).toBe('sdk-session-anon');
      expect(options?.callerContext.sessionPrincipalId).toBe('sdk-session-anon');
      expect(options?.callerContext.authScope).toBe('session');
      expect(options?.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: 'sdk-session-anon',
          subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
          actor: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
        }),
      );
    });

    test('uses verified identity for user-scoped SDK auth', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectWithAgents.mockResolvedValue({
        _id: 'proj-1',
        tenantId: 'tenant-1',
        agents: [makeValidatedProjectAgent('booking_agent', BOOKING_AGENT_DSL)],
      } as any);
      const token = createSDKToken({
        sessionId: 'sdk-session-verified',
        verifiedUserId: 'verified-user-42',
        authScope: 'user',
        identityTier: 2,
        verificationMethod: 'hmac',
        userContext: {
          userId: 'display-user-42',
          customAttributes: { plan: 'pro' },
        },
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockCreateRuntimeSession).toHaveBeenCalled();
      const options = mockCreateRuntimeSession.mock.calls[0]?.[0] as
        | {
            userId: string;
            callerData?: Record<string, unknown>;
            callerContext: {
              customerId?: string;
              anonymousId?: string;
              sessionPrincipalId?: string;
              authScope?: string;
            };
          }
        | undefined;
      expect(options).toBeDefined();
      expect(options?.userId).toBe('verified-user-42');
      expect(options?.callerData).toEqual({ plan: 'pro' });
      expect(options?.callerContext.customerId).toBe('verified-user-42');
      expect(options?.callerContext.anonymousId).toBeUndefined();
      expect(options?.callerContext.sessionPrincipalId).toBe('sdk-session-verified');
      expect(options?.callerContext.authScope).toBe('user');
      expect(options?.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: 'sdk-session-verified',
          authType: 'sdk_session',
          subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
        }),
      );
    });

    test('seeds canonical interaction context from SDK userContext customAttributes', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectWithAgents.mockResolvedValue({
        _id: 'proj-1',
        tenantId: 'tenant-1',
        agents: [makeValidatedProjectAgent('booking_agent', BOOKING_AGENT_DSL)],
      } as any);
      const token = createSDKToken({
        sessionId: 'sdk-session-interaction-seed',
        userContext: {
          userId: 'display-user-99',
          customAttributes: {
            plan: 'pro',
            language: 'fr',
            locale: 'fr-FR',
            timezone: 'Europe/Paris',
          },
        },
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockCreateRuntimeSession).toHaveBeenCalled();
      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          callerData: {
            plan: 'pro',
            language: 'fr',
            locale: 'fr-FR',
            timezone: 'Europe/Paris',
          },
          interactionContext: {
            language: 'fr',
            locale: 'fr-FR',
            timezone: 'Europe/Paris',
          },
        }),
      );
    });

    test('delegates deployment-scoped SDK session creation through the shared session factory', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSDKChannelById.mockResolvedValue({
        id: 'channel-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isActive: true,
        publicApiKeyId: 'pk-1',
        deploymentId: 'deploy-1',
        environment: 'dev',
        followEnvironment: true,
        config: {},
      });
      mockFindDeploymentById.mockResolvedValue({
        id: 'deploy-1',
        status: 'active',
        environment: 'dev',
      });

      const token = createSDKToken({ deploymentId: 'deploy-1' });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sdk-session-1' }),
      );
      expect(executor.createSessionFromResolved).not.toHaveBeenCalled();

      const sessionStart = findSentMessage(ws, 'session_start');
      expect(sessionStart).toBeDefined();
    });

    test('uses current live channel binding instead of stale deployment claims from the SDK token', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSDKChannelById.mockResolvedValue({
        id: 'channel-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isActive: true,
        publicApiKeyId: 'pk-1',
        deploymentId: 'deploy-current',
        environment: 'production',
        followEnvironment: true,
        config: {},
      });
      mockFindDeploymentById.mockResolvedValue({
        id: 'deploy-current',
        status: 'active',
        environment: 'production',
      });

      const token = createSDKToken({
        deploymentId: 'deploy-stale',
        environment: 'staging',
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentId: 'deploy-current',
          environment: 'production',
        }),
      );
    });

    test('wires JIT auth callbacks onto newly created SDK sessions', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectWithAgents.mockResolvedValue({
        _id: 'proj-1',
        tenantId: 'tenant-1',
        agents: [makeValidatedProjectAgent('booking_agent', BOOKING_AGENT_DSL)],
      } as any);

      const token = createSDKToken();

      await handleSDKConnection(ws as any, makeReq({ token }));

      const clientState = sdkClients.get(ws as any);
      expect(clientState?.runtimeSession?.sendAuthChallenge).toEqual(expect.any(Function));
      expect(clientState?.runtimeSession?.initiateJitOAuth).toEqual(expect.any(Function));
      expect(executor.rewireSessionToolExecutor).toHaveBeenCalledWith('sdk-session-1');
    });

    test('backfills canonical contact identity onto resumed SDK sessions', async () => {
      const existingSession = makeRuntimeSession({
        id: 'sdk-session-existing',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'sdk-session-principal-1',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'sdk_websocket',
          channelId: 'channel-1',
          customerId: 'verified-user-42',
          anonymousId: 'sdk-session-principal-1',
          sessionPrincipalId: 'sdk-session-principal-1',
          authScope: 'user',
          identityTier: 2,
          verificationMethod: 'hmac',
          channelArtifact: 'artifact-hash-1',
        },
        data: {
          values: {
            user_id: 'sdk-session-principal-1',
            session: {
              channel: 'web_chat',
              sessionId: 'sdk-session-existing',
              userId: 'sdk-session-principal-1',
            },
          },
          gatheredKeys: new Set(),
        },
        versionInfo: { environment: 'dev', versions: { test_agent: 1 } },
      });

      mockGetSessionService.mockReturnValue({
        isDistributed: vi.fn(() => true),
        store: {},
      });
      mockResolveSession.mockResolvedValue({
        outcome: 'existing',
        sessionId: 'sdk-session-existing',
        reason: 'artifact_match',
      });
      executor.getSession.mockImplementation((sessionId: string) =>
        sessionId === 'sdk-session-existing' ? existingSession : undefined,
      );

      const token = createSDKToken({
        sessionId: 'sdk-session-principal-1',
        authScope: 'user',
        verifiedUserId: 'verified-user-42',
        identityTier: 2,
        verificationMethod: 'hmac',
        channelArtifact: 'artifact-hash-1',
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(existingSession.callerContext).toEqual(
        expect.objectContaining({
          contactId: 'contact-sdk-verified-1',
          contactDisplayName: 'Verified SDK User',
        }),
      );
      expect(existingSession.userId).toBe('contact-sdk-verified-1');
      expect(existingSession.data.values.user_id).toBe('contact-sdk-verified-1');
      expect(existingSession.data.values.session.userId).toBe('contact-sdk-verified-1');
      expect(findSentMessage(ws, 'session_start')).toMatchObject({
        sessionId: 'sdk-session-existing',
      });
    });

    test('backfills canonical contact identity for verified SDK sessions without customerId', async () => {
      const existingSession = makeRuntimeSession({
        id: 'sdk-session-existing',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'sdk-session-principal-77',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'sdk_websocket',
          channelId: 'channel-1',
          anonymousId: 'sdk-session-principal-77',
          sessionPrincipalId: 'sdk-session-principal-77',
          authScope: 'session',
          identityTier: 2,
          verificationMethod: 'hmac',
          channelArtifact: 'artifact-hash-77',
        },
        data: {
          values: {
            user_id: 'sdk-session-principal-77',
            session: {
              channel: 'web_chat',
              sessionId: 'sdk-session-existing',
              userId: 'sdk-session-principal-77',
            },
          },
          gatheredKeys: new Set(),
        },
        versionInfo: { environment: 'dev', versions: { test_agent: 1 } },
      });

      mockGetSessionService.mockReturnValue({
        isDistributed: vi.fn(() => true),
        store: {},
      });
      mockResolveSession.mockResolvedValue({
        outcome: 'existing',
        sessionId: 'sdk-session-existing',
        reason: 'artifact_match',
      });
      executor.getSession.mockImplementation((sessionId: string) =>
        sessionId === 'sdk-session-existing' ? existingSession : undefined,
      );

      const token = createSDKToken({
        sessionId: 'sdk-session-principal-77',
        identityTier: 2,
        verificationMethod: 'hmac',
        channelArtifact: 'artifact-hash-77',
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockResolveOrCreateContact).toHaveBeenCalledWith(
        'tenant-1',
        'external',
        'artifact-hash-77',
        'sdk_websocket',
        {
          contactAuditSource: 'channel_artifact',
          suppressContactCreatedAudit: false,
        },
      );
      await vi.waitFor(() => {
        expect(existingSession.callerContext).toEqual(
          expect.objectContaining({
            contactId: 'contact-sdk-verified-1',
            contactDisplayName: 'Verified SDK User',
          }),
        );
        expect(existingSession.userId).toBe('contact-sdk-verified-1');
        expect(existingSession.data.values.user_id).toBe('contact-sdk-verified-1');
        expect(existingSession.data.values.session.userId).toBe('contact-sdk-verified-1');
      });
    });

    test('backfills contactId onto an existing durable SDK session row when resuming', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      const existingSession = makeRuntimeSession({
        id: 'sdk-session-existing',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'sdk-session-principal-1',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'sdk_websocket',
          channelId: 'channel-1',
          customerId: 'verified-user-42',
          anonymousId: 'sdk-session-principal-1',
          sessionPrincipalId: 'sdk-session-principal-1',
          authScope: 'user',
          identityTier: 2,
          verificationMethod: 'hmac',
          channelArtifact: 'artifact-hash-1',
        },
        data: {
          values: {
            user_id: 'sdk-session-principal-1',
            session: {
              channel: 'web_chat',
              sessionId: 'sdk-session-existing',
              userId: 'sdk-session-principal-1',
            },
          },
          gatheredKeys: new Set(),
        },
        versionInfo: { environment: 'dev', versions: { test_agent: 1 } },
      });

      mockGetSessionService.mockReturnValue({
        isDistributed: vi.fn(() => true),
        store: {},
      });
      mockResolveSession.mockResolvedValue({
        outcome: 'existing',
        sessionId: 'sdk-session-existing',
        reason: 'artifact_match',
      });
      mockConversationStore.getSession.mockResolvedValue({
        id: 'sdk-session-existing',
        contactId: undefined,
      });
      executor.getSession.mockImplementation((sessionId: string) =>
        sessionId === 'sdk-session-existing' ? existingSession : undefined,
      );

      const token = createSDKToken({
        sessionId: 'sdk-session-principal-1',
        authScope: 'user',
        verifiedUserId: 'verified-user-42',
        identityTier: 2,
        verificationMethod: 'hmac',
        channelArtifact: 'artifact-hash-1',
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockConversationStore.getSession).toHaveBeenCalledWith('sdk-session-existing');
      expect(mockConversationStore.linkContact).toHaveBeenCalledWith(
        'sdk-session-existing',
        'contact-sdk-verified-1',
      );
    });

    test('materializes a durable DB session before session_start for chat-capable clients', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      const token = createSDKToken({
        permissions: ['session:send_message'],
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockConversationStore.getSession).toHaveBeenCalledWith('sdk-session-1');
      expect(mockConversationStore.createSession).toHaveBeenCalled();
      expect(sdkClients.get(ws as any)?.dbSessionId).toBe('db-session-1');

      const sessionStart = findSentMessage(ws, 'session_start');
      expect(sessionStart.sessionId).toBe('sdk-session-1');
    });

    test('emits tool warnings and session health diagnostics after session_start', async () => {
      executor.createSessionFromResolved.mockReturnValue(
        makeRuntimeSession({
          id: 'sdk-session-1',
          toolWarnings: ['Calendar credentials missing'],
          sessionHealth: [
            {
              category: 'llm',
              severity: 'error',
              code: 'MODEL_MISSING',
              message: 'No model available',
            },
          ],
        }),
      );

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(findSentMessage(ws, 'session_start')).toBeTruthy();
      expect(findSentMessage(ws, 'tool_warnings')).toEqual({
        type: 'tool_warnings',
        sessionId: 'sdk-session-1',
        warnings: ['Calendar credentials missing'],
      });
      expect(findSentMessage(ws, 'session_health')).toEqual({
        type: 'session_health',
        sessionId: 'sdk-session-1',
        health: [
          {
            category: 'llm',
            severity: 'error',
            code: 'MODEL_MISSING',
            message: 'No model available',
          },
        ],
      });
    });

    test('replays pending async results on reconnect for SDK chat sessions', async () => {
      const pendingDeliveryStore = {
        retrieve: vi.fn(async () => [
          {
            result: {
              response: 'Pending async reply',
              richContent: { type: 'card', title: 'Pending card' },
              actions: [{ type: 'button', label: 'Open' }],
              voiceConfig: { plain_text: 'Pending async reply' },
              responseMetadata: {
                isLlmGenerated: true,
                responseProvenance: {
                  schemaVersion: 1,
                  kind: 'llm',
                  disclaimerRequired: true,
                  usedLlmInternally: true,
                },
              },
            },
          },
        ]),
        remove: vi.fn(async () => {}),
      };

      executor = makeMockExecutor({
        _asyncInfra: { pendingDeliveryStore },
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      const sent = getSentMessages(ws);
      expect(sent[0]).toMatchObject({ type: 'session_start', sessionId: 'sdk-session-1' });

      const pendingStart = sent.find(
        (message: any) =>
          message.type === 'response_start' && message.sessionId === 'sdk-session-1',
      );
      const pendingChunk = sent.find(
        (message: any) =>
          message.type === 'response_chunk' && message.chunk === 'Pending async reply',
      );
      const pendingEnd = sent.find(
        (message: any) =>
          message.type === 'response_end' && message.fullText === 'Pending async reply',
      );

      expect(pendingStart).toBeTruthy();
      expect(pendingChunk).toBeTruthy();
      expect(pendingEnd).toMatchObject({
        type: 'response_end',
        sessionId: 'sdk-session-1',
        fullText: 'Pending async reply',
        richContent: { type: 'card', title: 'Pending card' },
        actions: [{ type: 'button', label: 'Open' }],
        voiceConfig: { plain_text: 'Pending async reply' },
        metadata: {
          isLlmGenerated: true,
          responseProvenance: {
            schemaVersion: 1,
            kind: 'llm',
            disclaimerRequired: true,
            usedLlmInternally: true,
          },
        },
      });
      expect(pendingDeliveryStore.retrieve).toHaveBeenCalledWith('sdk-session-1');
      expect(pendingDeliveryStore.remove).toHaveBeenCalledWith('sdk-session-1');
    });

    test('emits voice-capable structured-only ON_START responses and persists them for SDK clients', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSDKChannelById.mockResolvedValue({
        id: 'channel-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isActive: true,
        publicApiKeyId: 'pk-1',
        deploymentId: null,
        environment: 'production',
        followEnvironment: true,
        config: {},
      });

      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };

      mockCreateRuntimeSession.mockImplementationOnce(async (ctx: Record<string, any>) => {
        const runtimeSession = makeRuntimeSession({
          id: ctx.sessionId,
          agentName: 'test_agent',
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          currentFlowStep: 'welcome',
          versionInfo: {
            environment: ctx.environment ?? 'production',
            versions: { test_agent: 1 },
          },
        });

        return {
          runtimeSession,
          entryAgentName: 'test_agent',
          resolved: {
            entryAgent: 'test_agent',
            versionInfo: runtimeSession.versionInfo,
          },
        };
      });
      executor.initializeSession.mockResolvedValueOnce({
        response: '',
        action: { type: 'continue' },
        richContent: { markdown: '**Welcome**' },
        actions: { elements: [{ id: 'continue', type: 'button', label: 'Continue' }] },
        voiceConfig: { plain_text: 'Welcome' },
        responseMetadata: canonicalResponseMetadata,
      });

      const token = createSDKToken({
        environment: 'production',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
        verifiedUserId: 'customer-1',
        channelArtifact: 'artifact-hash-1',
      });

      await handleSDKConnection(ws as any, makeReq({ token }));

      await vi.waitFor(() => {
        const end = getSentMessages(ws).find(
          (message: any) =>
            message.type === 'response_end' && message.richContent?.markdown === '**Welcome**',
        );
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: '',
          voiceConfig: { plain_text: 'Welcome' },
          actions: { elements: [{ id: 'continue', type: 'button', label: 'Continue' }] },
          metadata: { ...canonicalResponseMetadata, agentName: 'test_agent' },
        });

        const assistantPersist = mockPersistScopedMessage.mock.calls.find(
          ([payload]) => payload.message.role === 'assistant' && payload.message.content === '',
        )?.[0];
        expect(assistantPersist).toMatchObject({
          scope: expect.objectContaining({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            environment: 'production',
            subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
          }),
          message: {
            dbSessionId: 'db-session-1',
            role: 'assistant',
            content: '',
            structuredContent: {
              richContent: { markdown: '**Welcome**' },
              actions: { elements: [{ id: 'continue', type: 'button', label: 'Continue' }] },
              voiceConfig: { plain_text: 'Welcome' },
            },
            channel: 'web_chat',
            metadata: { ...canonicalResponseMetadata, agentName: 'test_agent' },
          },
        });
      });
    });

    test('registers and unregisters SDK websocket sessions in the shared connection registry', async () => {
      const mockRegistry = {
        register: vi.fn(),
        unregister: vi.fn(),
      };
      setConnectionRegistry(mockRegistry as any);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      const clientState = sdkClients.get(ws as any);
      expect(clientState).toBeDefined();
      expect(mockRegistry.register).toHaveBeenCalledWith(
        clientState!.connectionId,
        'sdk-session-1',
        ws,
      );

      ws.simulateClose();

      expect(mockRegistry.unregister).toHaveBeenCalledWith(clientState!.connectionId);
    });

    test('loads project agents from database in legacy path', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindProjectWithAgents.mockResolvedValue({
        _id: 'proj-1',
        tenantId: 'tenant-1',
        agents: [makeValidatedProjectAgent('booking_agent', BOOKING_AGENT_DSL)],
      } as any);

      const token = createSDKToken();

      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(mockFindProjectWithAgents).toHaveBeenCalledWith('proj-1', 'tenant-1');
      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          sessionId: 'sdk-session-1',
          channelType: 'sdk_websocket',
        }),
      );
      expect(executor.createSessionFromResolved).not.toHaveBeenCalled();
    });

    test('sends error and closes on deployment resolution failure', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSDKChannelById.mockResolvedValue({
        id: 'channel-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isActive: true,
        publicApiKeyId: 'pk-1',
        deploymentId: 'deploy-bad',
        environment: 'dev',
        followEnvironment: true,
        config: {},
      });
      mockFindDeploymentById.mockResolvedValue({
        id: 'deploy-bad',
        status: 'active',
        environment: 'dev',
      });

      // Override shared factory to throw a generic error
      mockCreateRuntimeSession.mockRejectedValueOnce(new Error('Deployment not found'));

      const token = createSDKToken({ deploymentId: 'deploy-bad' });

      await handleSDKConnection(ws as any, makeReq({ token }));

      const errorMsg = findSentMessage(ws, 'error');
      expect(errorMsg).toBeDefined();
      expect(ws.close).toHaveBeenCalledWith(
        4010,
        expect.stringContaining('Deployment resolution failed'),
      );
    });

    test('detects retired deployment and closes with 4010', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSDKChannelById.mockResolvedValue({
        id: 'channel-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isActive: true,
        publicApiKeyId: 'pk-1',
        deploymentId: 'deploy-retired',
        environment: 'dev',
        followEnvironment: false,
        config: {},
      });
      mockFindDeploymentById.mockResolvedValue({
        id: 'deploy-retired',
        status: 'active',
        environment: 'dev',
      });

      // Override shared factory to throw a 410 error
      const retiredError = new Error('Retired') as any;
      retiredError.statusCode = 410;
      mockCreateRuntimeSession.mockRejectedValueOnce(retiredError);

      const token = createSDKToken({ deploymentId: 'deploy-retired' });

      await handleSDKConnection(ws as any, makeReq({ token }));

      const errorMsg = findSentMessage(ws, 'error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toBe('Deployment is retired');
      expect(ws.close).toHaveBeenCalledWith(4010, 'Deployment retired');
    });
  });

  // ---------------------------------------------------------------------------
  // Message handling — chat_message
  // ---------------------------------------------------------------------------

  describe('chat_message', () => {
    test('uses scoped persistence for chat turns when canonical SDK scope is available', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockFindSDKChannelById.mockResolvedValue({
        id: 'channel-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        isActive: true,
        publicApiKeyId: 'pk-1',
        deploymentId: null,
        environment: 'production',
        followEnvironment: true,
        config: {},
      });

      const token = createSDKToken({
        environment: 'production',
        identityTier: 2,
        verificationMethod: 'hmac',
      });
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const clientState = sdkClients.get(ws as any);
      if (!clientState?.callerContext) {
        throw new Error('expected SDK callerContext to exist');
      }
      clientState.callerContext.contactId = 'contact-scoped-1';
      clientState.callerContext.channelArtifact = 'artifact-hash-1';
      clientState.callerContext.channelArtifactType = 'cookie';

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Hello', messageId: 'msg-scoped' }),
      );

      await vi.waitFor(() => {
        expect(mockPersistScopedMessage).toHaveBeenCalledTimes(2);
        expect(mockPersistScopedTurnMetrics).toHaveBeenCalledTimes(1);
      });

      expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          scope: expect.objectContaining({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            channelId: 'channel-1',
            environment: 'production',
            authType: 'sdk_session',
            source: 'sdk_ws',
            subject: { kind: 'contact', contactId: 'contact-scoped-1' },
          }),
          message: expect.objectContaining({
            dbSessionId: 'db-session-1',
            role: 'user',
            content: 'Hello',
            channel: 'web_chat',
          }),
        }),
      );
      expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          message: expect.objectContaining({
            dbSessionId: 'db-session-1',
            role: 'assistant',
            content: 'Hello world',
            channel: 'web_chat',
          }),
        }),
      );
      expect(mockPersistScopedTurnMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({
            subject: { kind: 'contact', contactId: 'contact-scoped-1' },
          }),
          metrics: expect.objectContaining({
            dbSessionId: 'db-session-1',
          }),
        }),
      );
      expect(vi.mocked(persistMessage)).not.toHaveBeenCalled();
    });

    test('persists structured-only SDK chat assistant replies with voice metadata', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);

      const responseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };
      const localization = {
        domain: 'project' as const,
        locale: 'en-US',
        messageKey: 'assistant.choose_plan',
        catalogId: 'catalog-v1',
      };

      const token = createSDKToken({
        environment: 'production',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
        verifiedUserId: 'customer-1',
        channelArtifact: 'artifact-hash-1',
      });
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockResolvedValueOnce({
        response: '',
        action: { type: 'continue' },
        richContent: { markdown: '**Choose a plan**' },
        actions: { elements: [{ id: 'basic', type: 'button', label: 'Basic' }] },
        voiceConfig: { plain_text: 'Choose a plan' },
        localization,
        responseMetadata,
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Show plans', messageId: 'msg-structured' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: '',
          richContent: { markdown: '**Choose a plan**' },
          actions: { elements: [{ id: 'basic', type: 'button', label: 'Basic' }] },
          voiceConfig: { plain_text: 'Choose a plan' },
          localization,
          metadata: { ...responseMetadata, agentName: 'test_agent' },
        });

        expect(mockPersistScopedMessage).toHaveBeenCalledTimes(2);
      });

      expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          scope: expect.objectContaining({
            subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
          }),
          message: expect.objectContaining({
            dbSessionId: 'db-session-1',
            role: 'assistant',
            content: '',
            channel: 'web_chat',
            structuredContent: {
              richContent: { markdown: '**Choose a plan**' },
              actions: { elements: [{ id: 'basic', type: 'button', label: 'Basic' }] },
              voiceConfig: { plain_text: 'Choose a plan' },
              localization,
            },
            metadata: { ...responseMetadata, agentName: 'test_agent' },
          }),
        }),
      );
    });

    test('uses scoped persistence for anonymous session-scoped auth after contact resolution', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);

      const token = createSDKToken({
        identityTier: 2,
        verificationMethod: 'hmac',
      });
      await handleSDKConnection(ws as any, makeReq({ token }));

      await vi.waitFor(() => {
        expect(mockConversationStore.linkContact).toHaveBeenCalledWith(
          'db-session-1',
          'contact-sdk-verified-1',
        );
      });

      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Hello', messageId: 'msg-legacy' }),
      );

      await vi.waitFor(() => {
        expect(mockPersistScopedMessage).toHaveBeenCalledTimes(2);
      });

      expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          scope: expect.objectContaining({
            subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
          }),
          message: expect.objectContaining({
            dbSessionId: 'db-session-1',
            role: 'user',
            content: 'Hello',
          }),
        }),
      );
      expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          scope: expect.objectContaining({
            subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
          }),
          message: expect.objectContaining({
            dbSessionId: 'db-session-1',
            role: 'assistant',
            content: 'Hello world',
          }),
        }),
      );
      expect(mockPersistScopedTurnMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({
            subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
          }),
          metrics: expect.objectContaining({
            dbSessionId: 'db-session-1',
          }),
        }),
      );
      expect(vi.mocked(persistMessage)).not.toHaveBeenCalled();
    });

    test('sends response_start, response_chunk, and response_end for chat message', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          if (onChunk) {
            onChunk('chunk1');
            onChunk('chunk2');
          }
          return { response: 'chunk1chunk2', metadata: {} };
        },
      );

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Hello', messageId: 'msg-1' }),
      );

      await vi.waitFor(() => {
        const msgs = getSentMessages(ws);
        const start = msgs.find((m: any) => m.type === 'response_start');
        const end = msgs.find((m: any) => m.type === 'response_end');
        expect(start).toBeDefined();
        expect(end).toBeDefined();
        expect(end.fullText).toBe('chunk1chunk2');
      });
    });

    test('streams response chunks for each onChunk callback', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          if (onChunk) {
            onChunk('A');
            onChunk('B');
            onChunk('C');
          }
          return { response: 'ABC', metadata: {} };
        },
      );

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'test', messageId: 'msg-2' }),
      );

      await vi.waitFor(() => {
        const chunks = findAllSentMessages(ws, 'response_chunk');
        expect(chunks).toHaveLength(3);
        expect(chunks.map((c: any) => c.chunk)).toEqual(['A', 'B', 'C']);
      });
    });

    test('surfaces empty execution results as a diagnostic response_end payload', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockResolvedValue({
        response: '',
        action: { type: 'continue' },
        richContent: undefined,
        actions: undefined,
        metadata: {},
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Hello', messageId: 'msg-empty' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toBeDefined();
        expect(end.fullText).toContain('empty response');
      });
    });

    test('summarizes channel-native rich content when the sdk response has no plain text', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockResolvedValue({
        response: '',
        action: { type: 'continue' },
        richContent: {
          slack:
            '{"text":"Approval required","blocks":[{"type":"section","text":{"type":"mrkdwn","text":"Approve invoice INV-42"}}]}',
        },
        actions: undefined,
        metadata: {},
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Hello', messageId: 'msg-channel-native' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toBeDefined();
        expect(end.fullText).toContain('Approval required');
        expect(end.richContent).toEqual(
          expect.objectContaining({
            slack: expect.stringContaining('Approve invoice INV-42'),
          }),
        );
      });
    });

    test('sends error when chat permission is not granted', async () => {
      const token = createSDKToken({ permissions: [] }); // no chat permission
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Hello', messageId: 'msg-3' }),
      );

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Chat not enabled');
      });
    });

    test('sends fallback response when executor is not configured', async () => {
      executor.isConfigured.mockReturnValue(false);
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Hello', messageId: 'msg-4' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toBeDefined();
        expect(end.fullText).toContain('demo mode');
      });
    });

    test('sends error message on execution failure', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockRejectedValue(new Error('LLM timeout'));

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'Fail', messageId: 'msg-5' }),
      );

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Failed to process message');
      });
    });

    test('forwards trace events during chat execution', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockImplementation(
        async (
          _sid: string,
          _text: string,
          _onChunk?: (c: string) => void,
          onTrace?: (e: any) => void,
        ) => {
          if (onTrace) {
            onTrace({ type: 'llm_call', data: { tokensIn: 10, tokensOut: 20, cost: 0.001 } });
          }
          return { response: 'Hi', metadata: {} };
        },
      );

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'test', messageId: 'msg-6' }),
      );

      await vi.waitFor(() => {
        const traceEvents = findAllSentMessages(ws, 'trace_event');
        expect(traceEvents.length).toBeGreaterThanOrEqual(1);
        expect(traceEvents[0].sessionId).toBe('sdk-session-1');
        expect(traceEvents[0].event.type).toBe('llm_call');
        expect(traceEvents[0].event.sessionId).toBe('sdk-session-1');
      });
    });

    test('attaches provenance metadata to response_end when chat execution emits llm_call traces', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEnqueueLLMRequest.mockImplementation(
        async (
          _sid: string,
          _text: string,
          onChunk?: (c: string) => void,
          onTrace?: (e: any) => void,
        ) => {
          onChunk?.('Hi');
          onTrace?.({
            type: 'llm_call',
            data: {
              tokensIn: 10,
              tokensOut: 20,
              cost: 0.001,
              operationType: 'response_gen',
              responseContribution: 'customer_visible',
            },
          });
          return { response: 'Hi', metadata: {} };
        },
      );

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'test', messageId: 'msg-provenance' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: 'Hi',
          metadata: {
            isLlmGenerated: true,
            responseProvenance: {
              schemaVersion: 1,
              kind: 'llm',
              disclaimerRequired: true,
              usedLlmInternally: true,
            },
          },
        });
      });
    });

    test('prefers canonical responseMetadata from chat execution results over recomputed trace metadata', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        provenanceTag: 'canonical-sdk-chat',
      };

      mockEnqueueLLMRequest.mockImplementation(
        async (_sid: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('Hi');
          return {
            response: 'Hi',
            action: { type: 'continue' },
            stateUpdates: { gatherProgress: {}, context: {}, conversationPhase: 'active' },
            responseMetadata: canonicalResponseMetadata,
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'test', messageId: 'msg-canonical' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end?.metadata).toEqual({ ...canonicalResponseMetadata, agentName: 'test_agent' });
      });
    });

    test('passes unique SDK message ids into coordinator dedup so identical turns execute independently', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockIsCoordinatorAvailable.mockReturnValue(true);
      mockExecutionCoordinator.submit
        .mockResolvedValueOnce({
          status: 'completed',
          response: 'PIN mismatch. Attempts=1. Try again.Enter your PIN.',
          resultData: {
            response: 'PIN mismatch. Attempts=1. Try again.Enter your PIN.',
            action: { type: 'continue' },
          },
        })
        .mockResolvedValueOnce({
          status: 'completed',
          response: 'Account locked after 2 attempts. status=locked',
          resultData: {
            response: 'Account locked after 2 attempts. status=locked',
            action: { type: 'continue' },
          },
        });

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: '9999', messageId: 'msg-1' }),
      );
      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: '9999', messageId: 'msg-2' }),
      );

      await vi.waitFor(() => {
        expect(mockExecutionCoordinator.submit).toHaveBeenCalledTimes(2);
      });

      expect(mockExecutionCoordinator.submit).toHaveBeenNthCalledWith(
        1,
        'sdk-session-1',
        '9999',
        expect.objectContaining({ dedupKey: 'sdk:msg-1' }),
      );
      expect(mockExecutionCoordinator.submit).toHaveBeenNthCalledWith(
        2,
        'sdk-session-1',
        '9999',
        expect.objectContaining({ dedupKey: 'sdk:msg-2' }),
      );

      await vi.waitFor(() => {
        const ends = findAllSentMessages(ws, 'response_end');
        expect(ends).toHaveLength(2);
        expect(ends.map((message: any) => message.fullText)).toEqual([
          'PIN mismatch. Attempts=1. Try again.Enter your PIN.',
          'Account locked after 2 attempts. status=locked',
        ]);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Message validation
  // ---------------------------------------------------------------------------

  describe('message validation', () => {
    test('responds to legacy ping heartbeat without triggering timeout side effects', async () => {
      vi.useFakeTimers();
      try {
        const token = createSDKToken();
        await handleSDKConnection(ws as any, makeReq({ token }));
        ws.send.mockClear();
        ws.close.mockClear();

        ws.simulateMessage(JSON.stringify({ type: 'ping' }));
        await vi.advanceTimersByTimeAsync(0);

        expect(findSentMessage(ws, 'pong')).toEqual({ type: 'pong' });
        expect(findSentMessage(ws, 'error')).toBeUndefined();

        await vi.advanceTimersByTimeAsync(WS_MESSAGE_TIMEOUT_MS + 1000);

        expect(findAllSentMessages(ws, 'error')).toHaveLength(0);
        expect(ws.close).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Message parsing edge cases
  // ---------------------------------------------------------------------------

  describe('message parsing', () => {
    test('returns error for non-JSON data', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage('this is not json');

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Invalid message format');
      });
    });

    test('returns error for JSON without type field', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ foo: 'bar' }));

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Missing message type');
      });
    });

    test('returns error when session not found in sdkClients map', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      // Manually remove from sdkClients to simulate missing state
      sdkClients.delete(ws as any);
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'test', messageId: 'msg-x' }),
      );

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Session not found');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Voice token request
  // ---------------------------------------------------------------------------

  describe('voice_token_request', () => {
    test('sends error when voice permission is not granted', async () => {
      const token = createSDKToken({ permissions: ['session:send_message'] }); // no voice
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'voice_token_request' }));

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Voice not enabled');
      });
    });

    test('sends a voice token when the voice service is configured', async () => {
      const getTwilioService = vi.fn(async () => ({
        isConfigured: vi.fn(() => true),
        generateAccessToken: vi.fn(async () => 'voice-token-123'),
      }));
      mockServerApp.locals.voiceServiceFactory = { getTwilioService };

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'voice_token_request' }));

      await vi.waitFor(() => {
        const voiceToken = findSentMessage(ws, 'voice_token');
        expect(voiceToken).toBeDefined();
        expect(voiceToken.token).toBe('voice-token-123');
        expect(voiceToken.identity).toBe('sdk_sdk-session-1');
      });
      expect(getTwilioService).toHaveBeenCalledWith('tenant-1');
    });
  });

  describe('voice_start', () => {
    test('starts realtime voice and publishes the capabilities contract', async () => {
      const executor = {
        config: {},
        start: vi.fn(async () => {}),
      };
      const runtimeSession = makeRuntimeSession({
        id: 'sdk-session-1',
        agentIR: {
          metadata: { name: 'voice-agent' },
        },
      });
      mockResolveVoiceSession.mockResolvedValueOnce({
        mode: 'realtime',
        reason: 'resolved_as_realtime',
        executor,
      });

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const clientState = sdkClients.get(ws as any);
      if (!clientState) {
        throw new Error('expected SDK client state to exist');
      }
      clientState.runtimeSession = runtimeSession;
      clientState.sessionId = runtimeSession.id;

      ws.simulateMessage(JSON.stringify({ type: 'voice_start', sessionId: 'sdk-session-1' }));

      await vi.waitFor(() => {
        const started = findSentMessage(ws, 'voice_started');
        expect(started).toEqual(
          toWireServerMessage(
            ServerMessages.voiceStarted('sdk-session-1', 'realtime', {
              localBargeIn: true,
              remoteTypedInterrupt: true,
              dtmf: false,
              returnToParent: true,
              activeAgentSync: false,
            }),
          ),
        );
      });

      expect(executor.start).toHaveBeenCalledTimes(1);
      expect(sdkClients.get(ws as any)?.voiceMode).toBe('realtime');
      expect(mockResolveVoiceSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sdk-session-1',
          runtimeSession,
          agentIR: runtimeSession.agentIR,
        }),
      );
    });
  });

  describe('voice_stop', () => {
    test('stops realtime voice and acknowledges the stop request', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const clientState = sdkClients.get(ws as any);
      if (!clientState) {
        throw new Error('expected SDK client state to exist');
      }

      const stop = vi.fn(async () => {});
      clientState.voiceMode = 'realtime';
      clientState.realtimeExecutor = {
        stop,
        cancelResponse: vi.fn(),
      } as any;

      ws.simulateMessage(JSON.stringify({ type: 'voice_stop' }));

      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledTimes(1);
        expect(findSentMessage(ws, 'voice_stopped')).toBeDefined();
      });
      expect(clientState.voiceMode).toBeUndefined();
      expect(clientState.realtimeExecutor).toBeUndefined();
    });
  });

  describe('end_session', () => {
    test('forces a real session end and auth cleanup even when the channel default is detach', async () => {
      mockTerminateConversationSession.mockResolvedValue({
        sessionId: 'sess-end-session',
        disposition: 'completed',
        status: 'completed',
        endedAt: '2026-03-30T10:00:00.000Z',
        eventEmitted: true,
        eventId: 'evt-sdk-end',
        hook: { attempted: false },
        runtimeEnded: true,
        dbUpdated: true,
        artifactSessionIds: ['sess-end-session'],
      });

      const session = makeRuntimeSession({
        id: 'sess-end-session',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });
      executor.createSessionFromResolved.mockReturnValue(session);
      executor.getSession.mockReturnValue(session);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'end_session' }));

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'session_ended')).toBeDefined();
        expect(ws.close).toHaveBeenCalledWith(1000, 'Session ended by client');
      });

      ws.simulateClose();

      await vi.waitFor(() => {
        expect(mockTerminateConversationSession).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            sessionId: 'sess-end-session',
            agentName: 'test_agent',
            channel: 'web_chat',
            disposition: 'completed',
            source: 'sdk_end_session',
            hook: {
              sendResponse: expect.any(Function),
            },
          }),
        );
        expect(mockCleanupClosedSessionArtifacts).toHaveBeenCalledWith(['sess-end-session']);
        expect(mockPausedExecutionStore.cleanupSession).toHaveBeenCalledWith(
          'sess-end-session',
          'disconnect',
        );
        expect(mockCleanupAuthGateAsync).toHaveBeenCalledWith('sess-end-session');
      });
      expect(executor.endSession).not.toHaveBeenCalled();
      expect(executor.detachSession).not.toHaveBeenCalled();
    });

    test('delivers the configured respond hook before acknowledging explicit SDK end', async () => {
      mockTerminateConversationSession.mockImplementation(async (input: any) => {
        await input.hook?.sendResponse?.('This chat has ended.');
        return {
          sessionId: 'sess-end-hook',
          disposition: 'completed',
          status: 'completed',
          endedAt: '2026-03-30T10:00:00.000Z',
          eventEmitted: true,
          eventId: 'evt-sdk-end-hook',
          hook: {
            attempted: true,
            mode: 'respond',
            outcome: 'sent',
          },
          runtimeEnded: true,
          dbUpdated: true,
          artifactSessionIds: ['sess-end-hook'],
        };
      });

      const session = makeRuntimeSession({
        id: 'sess-end-hook',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });
      executor.createSessionFromResolved.mockReturnValue(session);
      executor.getSession.mockReturnValue(session);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      ws.simulateMessage(JSON.stringify({ type: 'end_session' }));

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'response_start')).toBeDefined();
        expect(findSentMessage(ws, 'response_end')).toMatchObject({
          fullText: 'This chat has ended.',
        });
        expect(findSentMessage(ws, 'session_ended')).toBeDefined();
      });

      ws.simulateClose();

      await vi.waitFor(() => {
        expect(mockTerminateConversationSession).toHaveBeenCalledTimes(1);
      });
      expect(executor.endSession).not.toHaveBeenCalled();
      expect(executor.detachSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Connection lifecycle — close handler
  // ---------------------------------------------------------------------------

  describe('close handler', () => {
    test('removes client from sdkClients map on close', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(sdkClients.has(ws as any)).toBe(true);

      ws.simulateClose();

      await vi.waitFor(() => {
        expect(sdkClients.has(ws as any)).toBe(false);
      });
    });

    test('detaches runtime session on close (default disconnect behavior)', async () => {
      const session = makeRuntimeSession({ id: 'sess-close-1' });
      executor.createSessionFromResolved.mockReturnValue(session);
      executor.getSession.mockReturnValue(session);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      ws.simulateClose();

      // saveSessionSnapshot is called, then detach on finally
      await vi.waitFor(() => {
        expect(executor.detachSession).toHaveBeenCalled();
      });
    });

    test('ends runtime session on close when the project web_chat override forces end', async () => {
      mockFindProjectSettings.mockResolvedValue({
        sessionLifecycle: {
          channels: {
            web_chat: {
              defaultDisposition: 'timeout',
              disconnectBehavior: 'end',
            },
          },
        },
      });

      const session = makeRuntimeSession({
        id: 'sess-close-project-end',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });
      executor.createSessionFromResolved.mockReturnValue(session);
      executor.getSession.mockReturnValue(session);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      ws.simulateClose();

      await vi.waitFor(() => {
        expect(mockTerminateConversationSession).toHaveBeenCalledWith({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: 'sess-close-project-end',
          agentName: 'test_agent',
          channel: 'web_chat',
          disposition: 'timeout',
          source: 'disconnect',
        });
        expect(mockCleanupClosedSessionArtifacts).toHaveBeenCalledWith(['runtime-session-001']);
        expect(mockPausedExecutionStore.cleanupSession).toHaveBeenCalledWith(
          'sess-close-project-end',
          'disconnect',
        );
        expect(mockCleanupAuthGateAsync).toHaveBeenCalledWith('sess-close-project-end');
      });
      expect(executor.endSession).not.toHaveBeenCalled();
      expect(executor.detachSession).not.toHaveBeenCalled();
    });

    test('flushes message queue for DB session on close', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);
      const session = makeRuntimeSession({ id: 'sess-close-flush' });
      executor.createSessionFromResolved.mockReturnValue(session);

      // Make project load work so DB session gets created
      mockFindProjectWithAgents.mockResolvedValue({
        _id: 'proj-1',
        tenantId: 'tenant-1',
        agents: [makeValidatedProjectAgent('test_agent', TEST_AGENT_DSL)],
      });
      mockCompileToResolvedAgent.mockReturnValue({
        agents: {},
        entryAgent: 'test_agent',
        compilationOutput: { agents: {} },
        sourceHash: 'abc',
        versionInfo: { versions: {} },
      });

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      // DB session creation is deferred until first chat_message (ensureDbSession).
      // Send a message to trigger it, then wait for the response to complete.
      ws.simulateMessage(
        JSON.stringify({ type: 'chat_message', text: 'test', messageId: 'msg-flush' }),
      );
      await vi.waitFor(() => {
        const end = getSentMessages(ws).find((m: any) => m.type === 'response_end');
        expect(end).toBeDefined();
      });

      ws.simulateClose();

      const { flushMessageQueue } = await import('../../services/message-persistence-queue.js');
      await vi.waitFor(() => {
        expect(flushMessageQueue).toHaveBeenCalledWith('db-session-1');
      });
      expect(mockConversationStore.endSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Connection lifecycle — error handler
  // ---------------------------------------------------------------------------

  describe('error handler', () => {
    test('removes client from sdkClients map on error', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));

      expect(sdkClients.has(ws as any)).toBe(true);

      ws.simulateError(new Error('connection reset'));

      await vi.waitFor(() => {
        expect(sdkClients.has(ws as any)).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Send guard (ws not OPEN)
  // ---------------------------------------------------------------------------

  describe('send guard', () => {
    test('does not call ws.send when readyState is not OPEN', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      // Set readyState to CLOSING
      ws.readyState = 2;

      ws.simulateMessage('not json');

      // Wait a tick for the async handler
      await new Promise((r) => setTimeout(r, 50));

      // No messages should have been sent since ws is not OPEN
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Action submit
  // ---------------------------------------------------------------------------

  describe('action_submit', () => {
    test('returns error when actionId is missing', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'action_submit' }));

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Missing actionId');
      });
    });

    test('routes SDK action_submit through executeMessage with actionEvent metadata', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'action_submit',
          actionId: 'approve',
          value: 'yes',
          formData: { ticketId: 'T-123', approved: true },
          renderId: 'render-1',
        }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toBeDefined();
        expect(end.fullText).toBe('Hello world');
      });

      expect(executor.executeMessage).toHaveBeenCalledWith(
        'sdk-session-1',
        '',
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          actionEvent: {
            actionId: 'approve',
            value: 'yes',
            source: 'sdk',
            formData: { ticketId: 'T-123', approved: true },
            renderId: 'render-1',
          },
          channelMetadata: { channel: 'sdk' },
          sessionLocator: expect.objectContaining({
            kind: 'production',
            sessionId: 'sdk-session-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    test('rejects malformed SDK action_submit formData before agent execution', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'action_submit',
          actionId: 'approve',
          value: 'yes',
          formData: ['not', 'an', 'object'],
        }),
      );

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Invalid formData');
      });
      expect(executor.executeMessage).not.toHaveBeenCalled();
    });

    test('forwards canonical responseMetadata when SDK action execution already finalized provenance', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        provenanceTag: 'canonical-sdk-action',
      };

      executor.executeMessage.mockImplementationOnce(
        async (_id: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('Action reply');
          return {
            response: 'Action reply',
            action: { type: 'continue' },
            responseMetadata: canonicalResponseMetadata,
          };
        },
      );

      ws.simulateMessage(
        JSON.stringify({ type: 'action_submit', actionId: 'approve', value: 'yes' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end?.metadata).toEqual({ ...canonicalResponseMetadata, agentName: 'test_agent' });
      });
    });

    test('persists SDK action_submit assistant replies with structured content and provenance', async () => {
      mockIsDatabaseAvailable.mockReturnValue(true);

      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      };
      const localization = {
        domain: 'project' as const,
        locale: 'en-US',
        messageKey: 'assistant.action_accepted',
        catalogId: 'catalog-v1',
      };
      const token = createSDKToken({
        environment: 'production',
        identityTier: 2,
        verificationMethod: 'hmac',
        authScope: 'user',
        verifiedUserId: 'customer-1',
        channelArtifact: 'artifact-hash-1',
      });
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      executor.executeMessage.mockResolvedValueOnce({
        response: '',
        action: { type: 'continue' },
        richContent: { markdown: '**Action accepted**' },
        actions: { elements: [{ id: 'next', type: 'button', label: 'Next' }] },
        voiceConfig: { plain_text: 'Action accepted' },
        localization,
        responseMetadata: canonicalResponseMetadata,
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'action_submit', actionId: 'approve', value: 'yes' }),
      );

      await vi.waitFor(() => {
        const end = findSentMessage(ws, 'response_end');
        expect(end).toMatchObject({
          type: 'response_end',
          fullText: '',
          richContent: { markdown: '**Action accepted**' },
          actions: { elements: [{ id: 'next', type: 'button', label: 'Next' }] },
          voiceConfig: { plain_text: 'Action accepted' },
          localization,
          metadata: { ...canonicalResponseMetadata, agentName: 'test_agent' },
        });

        expect(mockPersistScopedMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: expect.objectContaining({
              subject: { kind: 'contact', contactId: 'contact-sdk-verified-1' },
            }),
            message: expect.objectContaining({
              dbSessionId: 'db-session-1',
              role: 'assistant',
              content: '',
              channel: 'web_chat',
              structuredContent: {
                richContent: { markdown: '**Action accepted**' },
                actions: { elements: [{ id: 'next', type: 'button', label: 'Next' }] },
                voiceConfig: { plain_text: 'Action accepted' },
                localization,
              },
              metadata: { ...canonicalResponseMetadata, agentName: 'test_agent' },
            }),
          }),
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Execution cancellation
  // ---------------------------------------------------------------------------

  describe('cancel_execution', () => {
    test('returns error when the execution coordinator is unavailable', async () => {
      mockIsCoordinatorAvailable.mockReturnValue(false);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'cancel_execution', executionId: 'exec-1' }));

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Execution coordinator not available');
      });
    });

    test('cancels a specific execution when executionId is provided', async () => {
      mockIsCoordinatorAvailable.mockReturnValue(true);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(JSON.stringify({ type: 'cancel_execution', executionId: 'exec-42' }));

      await vi.waitFor(() => {
        expect(mockExecutionCoordinator.cancel).toHaveBeenCalledWith('exec-42');
      });
      expect(mockExecutionCoordinator.cancelSession).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Auth response / consent gate flows
  // ---------------------------------------------------------------------------

  describe('auth_response', () => {
    test('ignores auth responses for paused executions owned by a different session', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockPausedExecutionStore.get.mockReturnValue({
        sessionId: 'different-runtime-session',
      });

      ws.simulateMessage(
        JSON.stringify({ type: 'auth_response', toolCallId: 'tool-1', status: 'completed' }),
      );

      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(mockPausedExecutionStore.resolveDistributed).not.toHaveBeenCalled();
      expect(mockPausedExecutionStore.rejectDistributed).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
    });

    test('surfaces a retryable error when the paused execution is missing', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockPausedExecutionStore.resolveDistributed.mockResolvedValue('missing');

      ws.simulateMessage(
        JSON.stringify({ type: 'auth_response', toolCallId: 'tool-2', status: 'completed' }),
      );

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('paused tool execution');
      });
      expect(mockPausedExecutionStore.resolveDistributed).toHaveBeenCalledWith(
        'sdk-session-1',
        'tool-2',
      );
    });
  });

  describe('consent_satisfy', () => {
    test('rejects consent updates for a different SDK session owner', async () => {
      const session = makeRuntimeSession({
        id: 'runtime-session-auth',
        compilationOutput: { agents: {} },
      });
      executor.createSessionFromResolved.mockReturnValue(session);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'consent_satisfy',
          authProfileRef: 'google',
          sessionId: 'sdk-session-other',
        }),
      );

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Session ownership validation failed');
      });
      expect(mockEvaluateAuthPreflightFromIR).not.toHaveBeenCalled();
    });

    test('emits auth lifecycle trace when consent satisfies the auth gate', async () => {
      const satisfiedRequirement = {
        connector: 'google',
        authProfileRef: 'google',
        connectionMode: 'per_user',
      } satisfies AuthRequirement;
      const session = makeRuntimeSession({
        id: 'sdk-session-1',
        compilationOutput: { agents: {} },
      });
      executor.createSessionFromResolved.mockReturnValue(session);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEvaluateAuthPreflightFromIR.mockResolvedValue({
        pending: [],
        satisfied: [satisfiedRequirement],
      });
      mockReconcileAuthGateWithEvaluationAsync.mockResolvedValue({
        allSatisfied: true,
        queuedMessages: [],
        state: {
          active: false,
          pending: [],
          satisfied: [satisfiedRequirement],
          queuedMessages: [],
          createdAt: Date.now(),
        },
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'consent_satisfy',
          authProfileRef: 'google',
          sessionId: 'sdk-session-1',
        }),
      );

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'auth_gate_satisfied')).toBeDefined();
      });

      const authTrace = findAllSentMessages(ws, 'trace_event').find(
        (message: any) => message.event?.data?.source === 'auth_contract',
      );
      expect(authTrace).toBeDefined();
      expect(authTrace.sessionId).toBe('sdk-session-1');
      expect(authTrace.event.data.code).toBe('AUTH_PREFLIGHT_SATISFIED');
      expect(authTrace.event.data.decision).toBe('gate_satisfied');
      expect(authTrace.event.data.queuedMessageCount).toBe(0);
    });

    test('replays queued message metadata after the auth gate is satisfied', async () => {
      const satisfiedRequirement = {
        connector: 'google',
        authProfileRef: 'google',
        connectionMode: 'per_user',
      } satisfies AuthRequirement;
      const queuedMetadata = {
        locale: 'en-US',
        context: { plan: 'enterprise' },
      };
      const session = makeRuntimeSession({
        id: 'sdk-session-1',
        compilationOutput: { agents: {} },
      });
      executor.createSessionFromResolved.mockReturnValue(session);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      mockEvaluateAuthPreflightFromIR.mockResolvedValue({
        pending: [],
        satisfied: [satisfiedRequirement],
      });
      mockReconcileAuthGateWithEvaluationAsync.mockResolvedValue({
        allSatisfied: true,
        queuedMessages: [
          {
            text: 'queued follow-up',
            attachmentIds: ['att-1'],
            messageMetadata: queuedMetadata,
            interactionContext: {
              language: 'es',
              locale: 'es-MX',
              timezone: 'America/Mexico_City',
            },
          },
        ],
        state: {
          active: false,
          pending: [],
          satisfied: [satisfiedRequirement],
          queuedMessages: [],
          createdAt: Date.now(),
        },
      });

      ws.simulateMessage(
        JSON.stringify({
          type: 'consent_satisfy',
          authProfileRef: 'google',
          sessionId: 'sdk-session-1',
        }),
      );

      await vi.waitFor(() => {
        expect(mockEnqueueLLMRequest).toHaveBeenCalled();
      });

      const replayExecOptions = mockEnqueueLLMRequest.mock.calls.at(-1)?.[5];
      expect(replayExecOptions).toEqual(
        expect.objectContaining({
          attachmentIds: ['att-1'],
          messageMetadata: queuedMetadata,
          interactionContext: {
            language: 'es',
            locale: 'es-MX',
            timezone: 'America/Mexico_City',
          },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Omnichannel live session flows
  // ---------------------------------------------------------------------------

  describe('omnichannel live session flows', () => {
    test('discovers an active live session for the contact', async () => {
      const discoveryResult = {
        sessionId: 'live-123',
        participants: [
          {
            participantId: 'voice:abc',
            sessionId: 'live-123',
            contactId: 'contact-123',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            interactive: true,
            attachedAt: new Date('2026-03-22T10:00:00Z'),
          },
        ],
        liveSyncState: 'active',
      } satisfies LiveSessionDiscoveryResult;
      mockDiscoverLiveSession.mockResolvedValue(discoveryResult);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({ type: 'discover_live_session', contactId: 'contact-123' }),
      );

      await vi.waitFor(() => {
        const discovered = findSentMessage(ws, 'live_session_discovered');
        expect(discovered).toEqual(
          toWireServerMessage(ServerMessages.liveSessionDiscovered(discoveryResult)),
        );
      });
      expect(mockDiscoverLiveSession).toHaveBeenCalledWith(
        'tenant-1',
        'proj-1',
        'contact-sdk-verified-1',
        0,
      );
    });

    test('joins a live session and fans out the participant attachment', async () => {
      const joinResult = {
        success: true,
        backfill: [
          {
            id: 'item-1',
            sessionId: 'live-join-1',
            role: 'assistant',
            content: 'Hello from voice',
            channel: 'voice',
            sourceChannel: 'voice',
            inputMode: 'system',
            sequence: 1,
            timestamp: new Date('2026-03-22T10:00:00Z'),
            final: true,
          },
        ],
        participants: [
          {
            participantId: 'voice:abc',
            sessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            interactive: true,
            attachedAt: new Date('2026-03-22T10:00:00Z'),
          },
        ],
      } satisfies JoinResult;
      mockJoinLiveSession.mockResolvedValue(joinResult);

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'join_live_session',
          targetSessionId: 'live-join-1',
          contactId: 'contact-join-1',
          surface: 'web',
        }),
      );

      await vi.waitFor(() => {
        const joined = findSentMessage(ws, 'live_session_joined');
        expect(findSentMessage(ws, 'transcript_backfill')).toBeUndefined();
        expect(joined).toEqual(
          toWireServerMessage(
            ServerMessages.liveSessionJoined('live-join-1', joined.participantId, {
              backfill: joinResult.backfill,
              participants: joinResult.participants,
            }),
          ),
        );
        expect(joined.participantId).toMatch(/^ws:sdk-session-1:/);
      });

      expect(mockJoinLiveSession).toHaveBeenCalledWith(
        'tenant-1',
        'proj-1',
        'live-join-1',
        expect.objectContaining({
          sessionId: 'live-join-1',
          contactId: 'contact-sdk-verified-1',
          surface: 'web',
          channel: 'text',
          mode: 'typed',
        }),
        'contact-sdk-verified-1',
        0,
        undefined,
      );
      expect(mockFanOutParticipantEvent).toHaveBeenCalledWith(
        'live-join-1',
        'participant_attached',
        expect.objectContaining({
          sessionId: 'live-join-1',
          contactId: 'contact-sdk-verified-1',
        }),
      );
    });

    test('forwards live session join capacity errors without fanning out an attachment', async () => {
      mockJoinLiveSession.mockResolvedValue({
        success: false,
        backfill: [],
        participants: [],
        error: {
          code: 'MAX_CONNECTIONS_EXCEEDED',
          message: 'Maximum connections per session exceeded',
        },
      });

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      ws.simulateMessage(
        JSON.stringify({
          type: 'join_live_session',
          targetSessionId: 'live-join-1',
          contactId: 'contact-join-1',
          surface: 'web',
        }),
      );

      await vi.waitFor(() => {
        expect(findSentMessage(ws, 'live_session_join_error')).toEqual(
          toWireServerMessage(
            ServerMessages.liveSessionJoinError({
              code: 'MAX_CONNECTIONS_EXCEEDED',
              message: 'Maximum connections per session exceeded',
            }),
          ),
        );
      });

      expect(findSentMessage(ws, 'live_session_joined')).toBeUndefined();
      expect(mockFanOutParticipantEvent).not.toHaveBeenCalled();
    });

    test('registers joined live-session sockets for fan-out and detaches them from the joined session on disconnect', async () => {
      const registry = new WebSocketConnectionRegistry();
      setConnectionRegistry(registry);

      mockJoinLiveSession.mockResolvedValue({
        success: true,
        backfill: [],
        participants: [
          {
            participantId: 'voice:abc',
            sessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            interactive: true,
            attachedAt: new Date('2026-03-22T10:00:00Z'),
          },
        ],
      } satisfies JoinResult);

      try {
        const token = createSDKToken();
        await handleSDKConnection(ws as any, makeReq({ token }));

        expect(registry.getConnectionsForSession('sdk-session-1')).toEqual([ws as any]);

        ws.send.mockClear();
        ws.simulateMessage(
          JSON.stringify({
            type: 'join_live_session',
            targetSessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'web',
          }),
        );

        await vi.waitFor(() => {
          expect(findSentMessage(ws, 'live_session_joined')).toBeDefined();
          expect(registry.getConnectionsForSession('live-join-1')).toEqual([ws as any]);
        });

        const clientState = sdkClients.get(ws as any);
        expect(clientState?.joinedLiveSessionId).toBe('live-join-1');
        expect(clientState?.liveSessionParticipantId).toMatch(/^ws:sdk-session-1:/);

        const participantId = clientState?.liveSessionParticipantId;
        ws.simulateClose();

        await vi.waitFor(() => {
          expect(registry.getConnectionsForSession('live-join-1')).toEqual([]);
          expect(mockDetachParticipant).toHaveBeenCalledWith(
            'live-join-1',
            participantId,
            'tenant-1',
            'proj-1',
          );
        });
      } finally {
        registry.stopStaleSweep();
      }
    });

    test('fans out canonical participant_detached payloads to remaining joined sockets on disconnect', async () => {
      const registry = new WebSocketConnectionRegistry();
      setConnectionRegistry(registry);

      const actualTranscriptFanout = await vi.importActual<
        typeof import('../../services/omnichannel/transcript-fanout.js')
      >('../../services/omnichannel/transcript-fanout.js');
      actualTranscriptFanout.initTranscriptFanout(registry);
      mockFanOutParticipantEvent.mockImplementation(actualTranscriptFanout.fanOutParticipantEvent);

      mockJoinLiveSession.mockResolvedValue({
        success: true,
        backfill: [],
        participants: [
          {
            participantId: 'voice:abc',
            sessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            interactive: true,
            attachedAt: new Date('2026-03-22T10:00:00Z'),
          },
        ],
      } satisfies JoinResult);
      mockParticipantGetParticipants.mockResolvedValue([
        {
          participantId: 'voice:abc',
          sessionId: 'live-join-1',
          contactId: 'contact-join-1',
          surface: 'voice',
          channel: 'voice',
          mode: 'speech',
          interactive: true,
          attachedAt: new Date('2026-03-22T10:00:00Z'),
        },
      ]);

      const observerWs = new MockWebSocket();

      try {
        const observerToken = createSDKToken({ sessionId: 'sdk-session-observer' });
        await handleSDKConnection(observerWs as any, makeReq({ token: observerToken }));
        observerWs.send.mockClear();
        observerWs.simulateMessage(
          JSON.stringify({
            type: 'join_live_session',
            targetSessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'web',
          }),
        );

        await vi.waitFor(() => {
          expect(findSentMessage(observerWs, 'live_session_joined')).toBeDefined();
          expect(registry.getConnectionsForSession('live-join-1')).toContain(observerWs as any);
        });

        const token = createSDKToken({ sessionId: 'sdk-session-primary' });
        await handleSDKConnection(ws as any, makeReq({ token }));
        ws.send.mockClear();
        observerWs.send.mockClear();

        ws.simulateMessage(
          JSON.stringify({
            type: 'join_live_session',
            targetSessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'web',
          }),
        );

        await vi.waitFor(() => {
          expect(findSentMessage(ws, 'live_session_joined')).toBeDefined();
          expect(registry.getConnectionsForSession('live-join-1')).toContain(ws as any);
        });

        const disconnectParticipantId = sdkClients.get(ws as any)?.liveSessionParticipantId;
        expect(disconnectParticipantId).toMatch(/^ws:sdk-session-primary:/);

        observerWs.send.mockClear();
        ws.simulateClose();

        await vi.waitFor(() => {
          const detached = findSentMessage(observerWs, 'participant_detached');
          expect(detached).toEqual(
            toWireServerMessage(
              ServerMessages.participantEvent('participant_detached', 'live-join-1', {
                participantId: disconnectParticipantId!,
                sessionId: 'live-join-1',
                contactId: 'contact-sdk-verified-1',
                surface: 'web',
                channel: 'text',
                mode: 'typed',
                interactive: false,
                attachedAt: new Date(detached.participant.attachedAt),
              }),
            ),
          );
        });

        expect(mockDetachParticipant).toHaveBeenCalledWith(
          'live-join-1',
          disconnectParticipantId,
          'tenant-1',
          'proj-1',
        );
      } finally {
        registry.stopStaleSweep();
      }
    });

    test('fans out canonical participant and transcript payloads over the joined live-session socket', async () => {
      const registry = new WebSocketConnectionRegistry();
      setConnectionRegistry(registry);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockConversationStore.getSession.mockImplementation(async (sessionId: string) => {
        if (sessionId === 'live-join-1') {
          return { id: 'live-join-1' };
        }
        return null;
      });

      const actualTranscriptFanout = await vi.importActual<
        typeof import('../../services/omnichannel/transcript-fanout.js')
      >('../../services/omnichannel/transcript-fanout.js');
      actualTranscriptFanout.initTranscriptFanout(registry);
      mockFanOutParticipantEvent.mockImplementation(actualTranscriptFanout.fanOutParticipantEvent);
      mockFanOutTranscriptItem.mockImplementation(actualTranscriptFanout.fanOutTranscriptItem);

      const joinResult = {
        success: true,
        backfill: [],
        participants: [
          {
            participantId: 'voice:abc',
            sessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            interactive: true,
            attachedAt: new Date('2026-03-22T10:00:00Z'),
          },
        ],
      } satisfies JoinResult;
      mockJoinLiveSession.mockResolvedValue(joinResult);
      mockParticipantGetParticipants.mockResolvedValue([
        {
          participantId: 'voice:abc',
          sessionId: 'live-join-1',
          contactId: 'contact-join-1',
          surface: 'voice',
          channel: 'voice',
          mode: 'speech',
          interactive: true,
          attachedAt: new Date('2026-03-22T10:00:00Z'),
        },
      ]);
      mockParticipantNextSequence.mockResolvedValueOnce(11).mockResolvedValueOnce(12);

      try {
        const token = createSDKToken();
        await handleSDKConnection(ws as any, makeReq({ token }));
        ws.send.mockClear();

        ws.simulateMessage(
          JSON.stringify({
            type: 'join_live_session',
            targetSessionId: 'live-join-1',
            contactId: 'contact-join-1',
            surface: 'web',
          }),
        );

        await vi.waitFor(() => {
          const joined = findSentMessage(ws, 'live_session_joined');
          const attached = findSentMessage(ws, 'participant_attached');
          expect(joined).toEqual(
            toWireServerMessage(
              ServerMessages.liveSessionJoined('live-join-1', joined.participantId, {
                backfill: joinResult.backfill,
                participants: joinResult.participants,
              }),
            ),
          );
          expect(attached).toEqual(
            toWireServerMessage(
              ServerMessages.participantEvent('participant_attached', 'live-join-1', {
                participantId: attached.participant.participantId,
                sessionId: 'live-join-1',
                contactId: 'contact-sdk-verified-1',
                surface: 'web',
                channel: 'text',
                mode: 'typed',
                interactive: true,
                attachedAt: new Date(attached.participant.attachedAt),
              }),
            ),
          );
          expect(attached.participant.participantId).toMatch(/^ws:sdk-session-1:/);
        });

        const clientState = sdkClients.get(ws as any);
        if (!clientState?.callerContext) {
          throw new Error('expected SDK callerContext to exist');
        }
        clientState.callerContext.contactId = 'contact-join-1';

        ws.send.mockClear();
        ws.simulateMessage(
          JSON.stringify({
            type: 'typed_interrupt',
            messageId: 'typed-msg-1',
            sessionId: 'live-join-1',
            text: 'Stop talking',
          }),
        );

        await vi.waitFor(() => {
          const transcriptItems = findAllSentMessages(ws, 'transcript_item');
          expect(transcriptItems).toHaveLength(2);
          expect(transcriptItems[0]).toEqual(
            toWireServerMessage(
              ServerMessages.transcriptItem({
                id: 'typed-msg-1',
                sessionId: 'live-join-1',
                role: 'user',
                content: 'Stop talking',
                channel: 'text',
                sourceChannel: 'text',
                inputMode: 'typed',
                sequence: 11,
                timestamp: new Date(transcriptItems[0].timestamp),
                final: true,
              }),
            ),
          );
          expect(transcriptItems[1]).toEqual(
            toWireServerMessage(
              ServerMessages.transcriptItem({
                id: transcriptItems[1].id,
                sessionId: 'live-join-1',
                role: 'assistant',
                content: 'Hello world',
                channel: 'text',
                sourceChannel: 'text',
                inputMode: 'system',
                sequence: 12,
                timestamp: new Date(transcriptItems[1].timestamp),
                final: true,
                metadata: {
                  agentName: 'test_agent',
                  isLlmGenerated: false,
                  responseProvenance: {
                    schemaVersion: 1,
                    kind: 'scripted',
                    disclaimerRequired: false,
                    usedLlmInternally: false,
                  },
                },
              }),
            ),
          );
        });

        expect(executor.executeMessage).toHaveBeenCalledWith(
          'live-join-1',
          'Stop talking',
          expect.any(Function),
          expect.any(Function),
          expect.objectContaining({
            channelMetadata: {
              channel: 'sdk_inbound',
              contentLength: 'Stop talking'.length,
            },
          }),
        );
        expect(mockConversationStore.getSession).toHaveBeenCalledWith('live-join-1');
        expect(vi.mocked(persistMessage)).toHaveBeenNthCalledWith(
          1,
          'live-join-1',
          'user',
          'Stop talking',
          'web_chat',
          'tenant-1',
          undefined,
          'contact-join-1',
          'proj-1',
          expect.any(Number),
        );
        // The typed-interrupt path persists the assistant reply through
        // persistMessageRecord (structured payload + responseMetadata)
        // rather than the legacy positional persistMessage signature.
        expect(vi.mocked(persistMessageRecord)).toHaveBeenCalledWith(
          expect.objectContaining({
            dbSessionId: 'live-join-1',
            role: 'assistant',
            content: 'Hello world',
            channel: 'web_chat',
            tenantId: 'tenant-1',
            contactId: 'contact-join-1',
            projectId: 'proj-1',
            metadata: expect.objectContaining({
              isLlmGenerated: false,
              responseProvenance: {
                schemaVersion: 1,
                kind: 'scripted',
                disclaimerRequired: false,
                usedLlmInternally: false,
              },
            }),
          }),
        );
      } finally {
        registry.stopStaleSweep();
      }
    });

    test('preserves canonical responseMetadata for typed interrupt assistant replies', async () => {
      const registry = new WebSocketConnectionRegistry();
      setConnectionRegistry(registry);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockConversationStore.getSession.mockImplementation(async (sessionId: string) => {
        if (sessionId === 'live-join-canonical') {
          return { id: 'live-join-canonical' };
        }
        return null;
      });

      const actualTranscriptFanout = await vi.importActual<
        typeof import('../../services/omnichannel/transcript-fanout.js')
      >('../../services/omnichannel/transcript-fanout.js');
      actualTranscriptFanout.initTranscriptFanout(registry);
      mockFanOutParticipantEvent.mockImplementation(actualTranscriptFanout.fanOutParticipantEvent);
      mockFanOutTranscriptItem.mockImplementation(actualTranscriptFanout.fanOutTranscriptItem);

      const joinResult = {
        success: true,
        backfill: [],
        participants: [
          {
            participantId: 'voice:typed-canonical',
            sessionId: 'live-join-canonical',
            contactId: 'contact-join-canonical',
            surface: 'voice',
            channel: 'voice',
            mode: 'speech',
            interactive: true,
            attachedAt: new Date('2026-03-22T10:00:00Z'),
          },
        ],
      } satisfies JoinResult;
      mockJoinLiveSession.mockResolvedValue(joinResult);
      mockParticipantGetParticipants.mockResolvedValue([
        {
          participantId: 'voice:typed-canonical',
          sessionId: 'live-join-canonical',
          contactId: 'contact-join-canonical',
          surface: 'voice',
          channel: 'voice',
          mode: 'speech',
          interactive: true,
          attachedAt: new Date('2026-03-22T10:00:00Z'),
        },
      ]);
      mockParticipantNextSequence.mockResolvedValueOnce(21).mockResolvedValueOnce(22);

      const canonicalResponseMetadata = {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1 as const,
          kind: 'llm' as const,
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
        provenanceTag: 'canonical-sdk-typed-interrupt',
      };

      executor.executeMessage.mockImplementationOnce(
        async (_id: string, _text: string, onChunk?: (c: string) => void) => {
          onChunk?.('Interrupt handled');
          return {
            response: 'Interrupt handled',
            action: { type: 'continue' },
            responseMetadata: canonicalResponseMetadata,
          };
        },
      );

      try {
        const token = createSDKToken();
        await handleSDKConnection(ws as any, makeReq({ token }));
        ws.send.mockClear();

        ws.simulateMessage(
          JSON.stringify({
            type: 'join_live_session',
            targetSessionId: 'live-join-canonical',
            contactId: 'contact-join-canonical',
            surface: 'web',
          }),
        );

        await vi.waitFor(() => {
          expect(findSentMessage(ws, 'live_session_joined')).toBeDefined();
        });

        const clientState = sdkClients.get(ws as any);
        if (!clientState?.callerContext) {
          throw new Error('expected SDK callerContext to exist');
        }
        clientState.callerContext.contactId = 'contact-join-canonical';

        ws.send.mockClear();
        vi.mocked(persistMessage).mockClear();

        ws.simulateMessage(
          JSON.stringify({
            type: 'typed_interrupt',
            messageId: 'typed-msg-canonical',
            sessionId: 'live-join-canonical',
            text: 'Stop talking',
          }),
        );

        await vi.waitFor(() => {
          const end = findSentMessage(ws, 'response_end');
          expect(end?.metadata).toEqual({ ...canonicalResponseMetadata, agentName: 'test_agent' });

          const transcriptItems = findAllSentMessages(ws, 'transcript_item');
          expect(transcriptItems[1]?.metadata).toEqual({
            ...canonicalResponseMetadata,
            agentName: 'test_agent',
          });
        });

        // Assistant reply for the typed-interrupt path persists through
        // persistMessageRecord — see sdk-handler typed-interrupt branch.
        expect(vi.mocked(persistMessageRecord)).toHaveBeenCalledWith(
          expect.objectContaining({
            dbSessionId: 'live-join-canonical',
            role: 'assistant',
            content: 'Interrupt handled',
            channel: 'web_chat',
            tenantId: 'tenant-1',
            contactId: 'contact-join-canonical',
            projectId: 'proj-1',
            metadata: { ...canonicalResponseMetadata, agentName: 'test_agent' },
          }),
        );
      } finally {
        registry.stopStaleSweep();
      }
    });

    test('typed interrupt cancels realtime voice playback on the live session owner connection', async () => {
      const voiceWs = new MockWebSocket();
      const cancelResponse = vi.fn();
      const start = vi.fn(async () => undefined);
      const stop = vi.fn(async () => undefined);

      const voiceToken = createSDKToken({ sessionId: 'live-voice-1' });
      mockResolveVoiceSession.mockResolvedValueOnce({
        mode: 'realtime',
        reason: 'resolved_as_realtime',
        executor: {
          config: {},
          start,
          stop,
          cancelResponse,
        },
      });
      await handleSDKConnection(voiceWs as any, makeReq({ token: voiceToken }));
      voiceWs.send.mockClear();

      voiceWs.simulateMessage(JSON.stringify({ type: 'voice_start', sessionId: 'live-voice-1' }));

      await vi.waitFor(() => {
        expect(start).toHaveBeenCalledTimes(1);
        expect(findSentMessage(voiceWs, 'voice_started')).toEqual(
          toWireServerMessage(
            ServerMessages.voiceStarted('live-voice-1', 'realtime', {
              localBargeIn: true,
              remoteTypedInterrupt: true,
              dtmf: false,
              returnToParent: true,
              activeAgentSync: false,
            }),
          ),
        );
      });

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const clientState = sdkClients.get(ws as any);
      if (!clientState?.callerContext) {
        throw new Error('expected SDK callerContext to exist');
      }
      clientState.callerContext.contactId = 'contact-sdk-verified-1';
      mockParticipantGetParticipants.mockResolvedValue([
        {
          participantId: 'web:sdk-session-1',
          sessionId: 'live-voice-1',
          contactId: 'contact-sdk-verified-1',
          surface: 'web',
          channel: 'text',
          mode: 'typed',
          interactive: true,
          attachedAt: new Date('2026-03-22T10:00:00Z'),
        },
      ]);

      ws.simulateMessage(
        JSON.stringify({
          type: 'typed_interrupt',
          messageId: 'typed-msg-voice-1',
          sessionId: 'live-voice-1',
          text: 'Stop talking',
        }),
      );

      await vi.waitFor(() => {
        expect(cancelResponse).toHaveBeenCalledTimes(1);
      });

      expect(findSentMessage(voiceWs, 'voice_barge_in_ack')).toEqual(
        toWireServerMessage(ServerMessages.voiceBargeInAck()),
      );
      expect(executor.executeMessage).toHaveBeenCalledWith(
        'live-voice-1',
        'Stop talking',
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          channelMetadata: {
            channel: 'sdk_inbound',
            contentLength: 'Stop talking'.length,
          },
        }),
      );
    });

    test('typed interrupt cancels provider-neutral realtime owner registrations', async () => {
      const cancelResponse = vi.fn();
      registerRealtimeInterruptionTarget({
        sessionIds: ['live-voice-2'],
        tenantId: 'tenant-1',
        provider: 'twilio',
        interrupt: () => {
          cancelResponse();
        },
      });

      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const clientState = sdkClients.get(ws as any);
      if (!clientState?.callerContext) {
        throw new Error('expected SDK callerContext to exist');
      }
      clientState.callerContext.contactId = 'contact-sdk-verified-1';
      mockParticipantGetParticipants.mockResolvedValue([
        {
          participantId: 'web:sdk-session-2',
          sessionId: 'live-voice-2',
          contactId: 'contact-sdk-verified-1',
          surface: 'web',
          channel: 'text',
          mode: 'typed',
          interactive: true,
          attachedAt: new Date('2026-03-22T10:05:00Z'),
        },
      ]);

      ws.simulateMessage(
        JSON.stringify({
          type: 'typed_interrupt',
          messageId: 'typed-msg-voice-2',
          sessionId: 'live-voice-2',
          text: 'Please switch topics',
        }),
      );

      await vi.waitFor(() => {
        expect(cancelResponse).toHaveBeenCalledTimes(1);
      });

      expect(executor.executeMessage).toHaveBeenCalledWith(
        'live-voice-2',
        'Please switch topics',
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          channelMetadata: {
            channel: 'sdk_inbound',
            contentLength: 'Please switch topics'.length,
          },
        }),
      );
    });

    test('rejects typed interrupt when the caller is not a participant', async () => {
      const token = createSDKToken();
      await handleSDKConnection(ws as any, makeReq({ token }));
      ws.send.mockClear();

      const clientState = sdkClients.get(ws as any);
      if (!clientState?.callerContext) {
        throw new Error('expected SDK callerContext to exist');
      }
      clientState.callerContext.contactId = 'contact-typed-1';
      mockParticipantGetParticipants.mockResolvedValue([
        {
          id: 'voice:other',
          sessionId: 'live-typed-1',
          contactId: 'contact-other',
          surface: 'voice',
          joinedAt: new Date().toISOString(),
        },
      ]);

      ws.simulateMessage(
        JSON.stringify({
          type: 'typed_interrupt',
          sessionId: 'live-typed-1',
          text: 'Stop talking',
        }),
      );

      await vi.waitFor(() => {
        const error = findSentMessage(ws, 'error');
        expect(error).toBeDefined();
        expect(error.message).toContain('Not a participant');
      });
      expect(executor.executeMessage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  describe('rate limiting', () => {
    test('closes connection with 4029 when rate limit exceeded', async () => {
      // Create many connections from the same IP rapidly
      // The default limit is 30 per minute, so create 31 connections
      const connections: MockWebSocket[] = [];

      for (let i = 0; i < 31; i++) {
        const testWs = new MockWebSocket();
        connections.push(testWs);
        const token = createSDKToken({ sessionId: `rate-sess-${i}` });
        await handleSDKConnection(testWs as any, makeReq({ token, remoteAddress: '127.0.0.250' }));
      }

      // The 31st connection should be rate limited
      const lastWs = connections[30];
      expect(lastWs.close).toHaveBeenCalledWith(
        4029,
        expect.stringContaining('Too many connections'),
      );
    });
  });
});
