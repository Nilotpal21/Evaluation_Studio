/**
 * Twilio Media Stream WebSocket Handler Tests
 *
 * Tests the Twilio media stream handler (websocket/twilio-media-handler.ts).
 * Exercises Twilio protocol message handling (connected, start, media, stop),
 * stream SID tracking, audio payload forwarding, lifecycle cleanup, and
 * error handling.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// =============================================================================
// MOCK DECLARATIONS — must come before any import that pulls them in
// =============================================================================

const mockGetRuntimeExecutor = vi.fn();
const mockCompileToResolvedAgent = vi.fn();

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: (...args: any[]) => mockGetRuntimeExecutor(...args),
  compileToResolvedAgent: (...args: any[]) => mockCompileToResolvedAgent(...args),
}));

const mockGetDeepgramService = vi.fn();
vi.mock('../../services/voice/deepgram-service.js', () => ({
  getDeepgramService: (...args: any[]) => mockGetDeepgramService(...args),
}));

const mockGetElevenLabsService = vi.fn();
vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  getElevenLabsService: (...args: any[]) => mockGetElevenLabsService(...args),
}));

const mockTwilioIsConfigured = vi.fn(() => true);
const mockValidateWebhookSignature = vi.fn(async () => true);
const mockValidateMediaStreamToken = vi.fn(() => true);
vi.mock('../../services/voice/twilio-service.js', () => ({
  getTwilioService: vi.fn(() => ({
    isConfigured: mockTwilioIsConfigured,
    validateWebhookSignature: mockValidateWebhookSignature,
    validateMediaStreamToken: mockValidateMediaStreamToken,
  })),
}));

const mockIsDatabaseAvailable = vi.fn(() => false);
vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: (...args: any[]) => mockIsDatabaseAvailable(...args),
}));

const mockIsConfigLoaded = vi.fn(() => false);
const mockGetConfig = vi.fn(() => ({
  channelLifecycle: {
    voice: { defaultDisposition: 'completed' },
  },
}));

vi.mock('../../config/index.js', () => ({
  isConfigLoaded: (...args: any[]) => mockIsConfigLoaded(...args),
  getConfig: (...args: any[]) => mockGetConfig(...args),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      createSession: vi.fn(async () => ({ id: 'db-session-1' })),
      endSession: vi.fn(async () => {}),
    },
  })),
}));

const mockResolveVoiceSession = vi.fn(async () => ({
  mode: 'pipeline' as const,
  reason: 'default',
}));
const mockEvaluateAuthPreflightFromIR = vi.fn();
const mockCreateTokenLookups = vi.fn(() => ({}));
const mockEmitChannelResponseSent = vi.fn();
const mockRecordSyntheticTraceEvent = vi.fn();
const mockCreateRuntimeSession = vi.fn();
const mockCreateAndLinkDBSession = vi.fn();
const mockResolveEnvironmentLabel = vi.fn((environment?: string) => environment ?? 'dev');
const mockHandleDisconnect = vi.fn(async () => {});
const mockFindSessionById = vi.fn();
const mockResolveContactIdFromChannelIdentity = vi.fn();
const mockLinkResolvedContactToSession = vi.fn();
const mockResolveCanonicalContactForProductionScope = vi.fn();

vi.mock('../../services/voice/voice-session-resolver.js', () => ({
  resolveVoiceSession: (...args: any[]) => mockResolveVoiceSession(...args),
}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: (...args: any[]) => mockEvaluateAuthPreflightFromIR(...args),
  createTokenLookups: (...args: any[]) => mockCreateTokenLookups(...args),
}));

vi.mock('../../services/channel-trace-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/channel-trace-utils.js')>();
  return {
    ...actual,
    emitChannelResponseSent: (...args: any[]) => mockEmitChannelResponseSent(...args),
    recordSyntheticTraceEvent: (...args: any[]) => mockRecordSyntheticTraceEvent(...args),
  };
});

vi.mock('../../channels/pipeline/index.js', () => ({
  createRuntimeSession: (...args: any[]) => mockCreateRuntimeSession(...args),
  createAndLinkDBSession: (...args: any[]) => mockCreateAndLinkDBSession(...args),
  resolveEnvironmentLabel: (...args: any[]) => mockResolveEnvironmentLabel(...args),
  handleDisconnect: (...args: any[]) => mockHandleDisconnect(...args),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: vi.fn(),
  mergeWorkingCopyModules: vi.fn(async (working: unknown) => working),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectWithAgents: vi.fn(async () => null),
}));

vi.mock('../../repos/session-repo.js', () => ({
  findSessionById: (...args: any[]) => mockFindSessionById(...args),
  updateSession: vi.fn(async () => ({})),
}));

vi.mock('../../services/identity/channel-contact-linking.js', () => ({
  resolveContactIdFromChannelIdentity: (...args: any[]) =>
    mockResolveContactIdFromChannelIdentity(...args),
  linkResolvedContactToSession: (...args: any[]) => mockLinkResolvedContactToSession(...args),
}));

vi.mock('../../services/identity/production-contact-resolution.js', () => ({
  resolveCanonicalContactForProductionScope: (...args: any[]) =>
    mockResolveCanonicalContactForProductionScope(...args),
}));

vi.mock('../../server.js', () => ({
  app: { locals: {} },
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
  handleTwilioMediaConnection,
  getMediaSession,
} from '../../websocket/twilio-media-handler.js';
import {
  interruptRealtimeVoiceSession,
  resetRealtimeInterruptionCoordinatorForTests,
} from '../../services/voice/realtime-interruption-coordinator.js';
import { PLATFORM_MESSAGES } from '../../services/channel/constants.js';

// =============================================================================
// HELPERS
// =============================================================================

/** WebSocket mock that supports EventEmitter pattern */
class MockWebSocket extends EventEmitter {
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

/** Create a minimal IncomingMessage stub */
function makeReq(): any {
  return {
    url: '/voice/media?token=valid-token',
    headers: {
      host: 'localhost:3112',
      'x-twilio-signature': 'valid-signature',
    },
    socket: {
      encrypted: false,
      remoteAddress: '127.0.0.1',
    },
  };
}

/** Build a mock RuntimeExecutor */
function makeMockExecutor(overrides: Record<string, any> = {}) {
  return {
    isConfigured: vi.fn(() => false),
    createSessionFromResolved: vi.fn(),
    executeMessage: vi.fn(async () => ({
      response: 'agent reply',
      action: { type: 'continue' },
      stateUpdates: {},
    })),
    getSession: vi.fn(() => undefined),
    rehydrateSession: vi.fn(async () => undefined),
    endSession: vi.fn(),
    ...overrides,
  };
}

/** Build a mock Deepgram service that is NOT configured */
function makeMockDeepgramNotConfigured() {
  return {
    isConfigured: vi.fn(() => false),
    createConnection: vi.fn(),
  };
}

/** Build a mock ElevenLabs service that is NOT configured */
function makeMockElevenLabsNotConfigured() {
  return {
    isConfigured: vi.fn(() => false),
    synthesizeStream: vi.fn(),
  };
}

/** Parse all messages sent via ws.send */
function getSentMessages(ws: MockWebSocket): any[] {
  return ws.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw));
}

/** Build a Twilio 'start' message */
function makeTwilioStartMessage(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    event: 'start',
    start: {
      streamSid: overrides.streamSid ?? 'stream-001',
      accountSid: overrides.accountSid ?? 'AC123',
      callSid: overrides.callSid ?? 'CA456',
      customParameters: overrides.customParameters ?? {},
    },
    ...overrides,
  });
}

/**
 * Send a start message and wait for handleStreamStart to fully complete.
 *
 * The message handler is async: `session = await handleStreamStart(ws, message)`.
 * We need handleStreamStart to fully return so the closure variable `session`
 * is assigned. We detect completion by waiting for the ElevenLabs service
 * isConfigured() to have been called (the last step in handleStreamStart
 * for pipeline mode) or for the Deepgram service to have been called.
 */
async function sendStartAndWait(
  ws: MockWebSocket,
  streamSid: string,
  customParameters?: Record<string, string>,
): Promise<void> {
  ws.simulateMessage(makeTwilioStartMessage({ streamSid, customParameters }));

  // Wait for the session to appear in the mediaSessions map
  await vi.waitFor(() => {
    expect(getMediaSession(streamSid)).toBeDefined();
  });

  // Wait for ElevenLabs isConfigured to be called — this happens at the very
  // end of handleStreamStart (in synthesizeAndSend), confirming the async
  // function has completed past the voice resolution and Deepgram setup stages.
  await vi.waitFor(() => {
    expect(mockGetElevenLabsService).toHaveBeenCalled();
  });

  // Yield to the microtask queue so the async message handler finishes
  // assigning the `session` closure variable after handleStreamStart returns.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// =============================================================================
// SHARED SETUP
// =============================================================================

let ws: MockWebSocket;
let executor: ReturnType<typeof makeMockExecutor>;

beforeEach(() => {
  vi.clearAllMocks();
  resetRealtimeInterruptionCoordinatorForTests();

  ws = new MockWebSocket();
  executor = makeMockExecutor();

  mockTwilioIsConfigured.mockReturnValue(true);
  mockValidateWebhookSignature.mockResolvedValue(true);
  mockValidateMediaStreamToken.mockReturnValue(true);
  mockGetRuntimeExecutor.mockReturnValue(executor);
  mockIsDatabaseAvailable.mockReturnValue(false);
  mockIsConfigLoaded.mockReturnValue(false);
  mockGetDeepgramService.mockReturnValue(makeMockDeepgramNotConfigured());
  mockGetElevenLabsService.mockReturnValue(makeMockElevenLabsNotConfigured());
  mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);
  mockCreateRuntimeSession.mockImplementation(async (params: { sessionId?: string }) => ({
    runtimeSession: { id: params.sessionId ?? 'rt-voice-1' },
    entryAgentName: 'voice-agent',
    resolved: {
      versionInfo: {
        versions: { voice_agent: '1.0.0' },
        environment: 'prod',
      },
    },
  }));
  mockCreateAndLinkDBSession.mockResolvedValue({ dbSessionId: 'db-session-1' });
  mockHandleDisconnect.mockResolvedValue(undefined);
  mockFindSessionById.mockResolvedValue(null);
  mockResolveContactIdFromChannelIdentity.mockImplementation(
    async (params: { verificationMethod?: string; identityTier?: number }) =>
      params.verificationMethod === 'provider' || (params.identityTier ?? 0) >= 2
        ? 'contact-twilio-default-1'
        : undefined,
  );
  mockLinkResolvedContactToSession.mockResolvedValue(undefined);
  mockResolveCanonicalContactForProductionScope.mockResolvedValue({
    contactId: 'contact-twilio-canonical-1',
    displayName: null,
  });
});

// =============================================================================
// TESTS
// =============================================================================

describe('Twilio Media Handler — handleTwilioMediaConnection', () => {
  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  describe('connection lifecycle', () => {
    test('registers message, close, and error listeners on connect', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());

      expect(ws.listenerCount('message')).toBe(1);
      expect(ws.listenerCount('close')).toBe(1);
      expect(ws.listenerCount('error')).toBe(1);
    });

    test('handles connected event without error', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());

      // 'connected' is the first Twilio event — should not throw
      ws.simulateMessage(JSON.stringify({ event: 'connected' }));

      // Give async handler time to process
      await vi.waitFor(() => {
        // No errors should have been thrown; ws should not have been closed
        expect(ws.close).not.toHaveBeenCalled();
      });
    });

    test('handles unknown event types gracefully', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());

      ws.simulateMessage(JSON.stringify({ event: 'dtmf' }));

      // Should not crash — just log debug and move on
      await vi.waitFor(() => {
        expect(ws.close).not.toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Start event / stream SID tracking
  // ---------------------------------------------------------------------------

  describe('start event', () => {
    test('creates media session and tracks stream SID on start event', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-abc', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });

      const session = getMediaSession('stream-abc');
      expect(session).toBeDefined();
      expect(session!.streamSid).toBe('stream-abc');
      expect(session!.callSid).toBe('CA456');
    });

    test('extracts custom parameters from start event (sessionId, tenantId, projectId)', async () => {
      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-custom', {
        sessionId: 'custom-session-id',
        tenantId: 'tenant-42',
        projectId: 'proj-99',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-custom',
        providerVerificationStrength: 'strong',
      });

      const session = getMediaSession('stream-custom');
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe('custom-session-id');
      expect(session!.tenantId).toBe('tenant-42');
      expect(session!.projectId).toBe('proj-99');
      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'custom-session-id',
          tenantId: 'tenant-42',
          projectId: 'proj-99',
        }),
      );
    });

    test('passes provider-verified caller context into runtime session creation', async () => {
      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-identity', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-1',
        providerVerificationStrength: 'strong',
      });

      const createRuntimeSessionArgs = mockCreateRuntimeSession.mock.calls.at(-1)?.[0];
      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          channelType: 'voice_twilio',
          callerContext: expect.objectContaining({
            tenantId: 'tenant-1',
            channel: 'voice_twilio',
            channelId: 'voice-number-1',
            anonymousId: '+15551230001',
            identityTier: 2,
            verificationMethod: 'provider',
            channelArtifactType: 'caller_id',
          }),
        }),
      );
      expect(createRuntimeSessionArgs?.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          sessionId: createRuntimeSessionArgs?.sessionId,
          subject: { kind: 'contact', contactId: 'contact-twilio-default-1' },
        }),
      );
      expect(createRuntimeSessionArgs).not.toHaveProperty('userId');
    });

    test('fails closed when canonical production scope cannot be resolved', async () => {
      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockResolveContactIdFromChannelIdentity.mockResolvedValue(undefined);
      mockResolveCanonicalContactForProductionScope.mockResolvedValue(undefined);

      await handleTwilioMediaConnection(ws as any, makeReq());

      ws.simulateMessage(
        makeTwilioStartMessage({
          streamSid: 'stream-scope-invalid',
          customParameters: {
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            caller: '+15551230001',
            called: '+15558675309',
            channelId: 'voice-number-1',
            providerVerificationStrength: 'strong',
          },
        }),
      );

      await vi.waitFor(() => {
        expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid session scope');
      });

      expect(getMediaSession('stream-scope-invalid')).toBeUndefined();
      expect(mockGetElevenLabsService).not.toHaveBeenCalled();
    });

    test('registers realtime Twilio sessions with the shared interruption coordinator', async () => {
      const cancelResponse = vi.fn();
      const stop = vi.fn(async () => undefined);
      const start = vi.fn(async () => undefined);
      const runtimeSession = {
        id: 'twilio-realtime-1',
        agentIR: {
          metadata: { name: 'voice-agent' },
        },
      };

      executor = makeMockExecutor({
        getSession: vi.fn((sessionId?: string) =>
          sessionId === runtimeSession.id ? runtimeSession : undefined,
        ),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      mockResolveVoiceSession.mockResolvedValueOnce({
        mode: 'realtime',
        reason: 'realtime_resolved',
        executor: {
          start,
          stop,
          cancelResponse,
          sendAudio: vi.fn(),
          config: {},
        },
      });

      await handleTwilioMediaConnection(ws as any, makeReq());

      ws.simulateMessage(
        makeTwilioStartMessage({
          streamSid: 'stream-rt',
          customParameters: {
            sessionId: 'twilio-realtime-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
          },
        }),
      );

      await vi.waitFor(() => {
        const session = getMediaSession('stream-rt');
        expect(session?.voiceMode).toBe('realtime');
        expect(start).toHaveBeenCalledTimes(1);
      });
      expect(mockResolveVoiceSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'twilio-realtime-1',
          runtimeSession,
          agentIR: runtimeSession.agentIR,
        }),
      );

      expect(
        interruptRealtimeVoiceSession('twilio-realtime-1', {
          tenantId: 'tenant-1',
          reason: 'typed_interrupt',
        }),
      ).toEqual({
        interrupted: 1,
        acknowledgements: 0,
      });
      expect(cancelResponse).toHaveBeenCalledTimes(1);

      ws.simulateMessage(JSON.stringify({ event: 'stop' }));

      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledTimes(1);
        expect(getMediaSession('stream-rt')).toBeUndefined();
      });

      expect(
        interruptRealtimeVoiceSession('twilio-realtime-1', {
          tenantId: 'tenant-1',
          reason: 'typed_interrupt',
        }),
      ).toEqual({
        interrupted: 0,
        acknowledgements: 0,
      });
    });
  });

  describe('caller context parity', () => {
    test('reuses existing runtime-session caller identity when a canonical session is supplied', async () => {
      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
        getSession: vi.fn((sessionId?: string) =>
          sessionId === 'voice-existing-session-1'
            ? {
                id: 'voice-existing-session-1',
                tenantId: 'tenant-1',
                callerContext: {
                  tenantId: 'tenant-1',
                  channel: 'web_chat',
                  customerId: 'user-123',
                  contactId: 'contact-123',
                  sessionPrincipalId: 'sdk-session-123',
                  anonymousId: 'sdk-session-123',
                  identityTier: 2,
                  verificationMethod: 'oauth',
                  authScope: 'user',
                },
              }
            : undefined,
        ),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);

      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-existing-identity', {
        sessionId: 'voice-existing-session-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-1',
        providerVerificationStrength: 'weak',
      });

      const createRuntimeSessionArgs = mockCreateRuntimeSession.mock.calls.at(-1)?.[0];
      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'voice-existing-session-1',
          callerContext: expect.objectContaining({
            channel: 'voice_twilio',
            channelId: 'voice-number-1',
            channelArtifactType: 'caller_id',
            customerId: 'user-123',
            contactId: 'contact-123',
            sessionPrincipalId: 'sdk-session-123',
            authScope: 'user',
            identityTier: 2,
            verificationMethod: 'oauth',
          }),
        }),
      );
      expect(createRuntimeSessionArgs?.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          sessionId: 'voice-existing-session-1',
          subject: { kind: 'contact', contactId: 'contact-123' },
        }),
      );
      expect(createRuntimeSessionArgs).not.toHaveProperty('userId');
    });

    test('falls back to stored-session caller identity when runtime session is absent', async () => {
      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
        getSession: vi.fn(() => undefined),
        rehydrateSession: vi.fn(async () => undefined),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockFindSessionById.mockResolvedValue({
        _id: 'voice-stored-session-1',
        tenantId: 'tenant-1',
        customerId: 'user-789',
        contactId: 'contact-789',
        anonymousId: 'sdk-session-789',
        channelArtifact: 'persisted-artifact',
        channelId: 'persisted-channel',
        identityTier: 2,
        verificationMethod: 'oauth',
      });

      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-stored-identity', {
        sessionId: 'voice-stored-session-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        called: '+15558675309',
      });

      expect(mockFindSessionById).toHaveBeenCalledWith('voice-stored-session-1', 'tenant-1');
      const createRuntimeSessionArgs = mockCreateRuntimeSession.mock.calls.at(-1)?.[0];
      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'voice-stored-session-1',
          callerContext: expect.objectContaining({
            channel: 'voice_twilio',
            customerId: 'user-789',
            contactId: 'contact-789',
            sessionPrincipalId: 'sdk-session-789',
            authScope: 'user',
            identityTier: 2,
            verificationMethod: 'oauth',
          }),
        }),
      );
      expect(createRuntimeSessionArgs?.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          sessionId: 'voice-stored-session-1',
          subject: { kind: 'contact', contactId: 'contact-789' },
        }),
      );
      expect(createRuntimeSessionArgs).not.toHaveProperty('userId');
    });

    test('resolves trusted caller artifacts into contact identity when no existing session identity is present', async () => {
      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockResolveContactIdFromChannelIdentity.mockResolvedValue('contact-twilio-strong-1');

      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-contact-resolution', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-1',
        providerVerificationStrength: 'strong',
      });

      expect(mockResolveContactIdFromChannelIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          channelType: 'voice_twilio',
          rawArtifact: '+15551230001',
          verificationMethod: 'provider',
          identityTier: 2,
        }),
      );
      const createRuntimeSessionArgs = mockCreateRuntimeSession.mock.calls.at(-1)?.[0];
      expect(mockCreateRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          callerContext: expect.objectContaining({
            contactId: 'contact-twilio-strong-1',
            identityTier: 2,
            verificationMethod: 'provider',
          }),
        }),
      );
      expect(createRuntimeSessionArgs?.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          subject: { kind: 'contact', contactId: 'contact-twilio-strong-1' },
        }),
      );
      expect(createRuntimeSessionArgs).not.toHaveProperty('userId');
    });

    test('persists caller context into the lazy DB session on first utterance', async () => {
      let transcriptHandler: ((result: { isFinal: boolean; text: string }) => void) | undefined;
      const mockDeepgramConn = {
        send: vi.fn(),
        close: vi.fn(),
        isOpen: vi.fn(() => true),
        onTranscript: vi.fn((handler) => {
          transcriptHandler = handler;
        }),
        onError: vi.fn(),
        onClose: vi.fn(),
      };
      const mockDeepgram = {
        isConfigured: vi.fn(() => true),
        createConnection: vi.fn(async () => mockDeepgramConn),
      };

      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockGetDeepgramService.mockReturnValue(mockDeepgram);

      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-db-identity', {
        sessionId: 'voice-db-session-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-1',
        providerVerificationStrength: 'strong',
      });

      transcriptHandler?.({ isFinal: true, text: 'hello there' });
      await new Promise((resolve) => setTimeout(resolve, 1700));

      await vi.waitFor(() => {
        expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            sessionId: 'voice-db-session-1',
            callerNumber: '+15551230001',
            anonymousId: '+15551230001',
            channelId: 'voice-number-1',
            channelArtifactType: 'caller_id',
            identityTier: 2,
            verificationMethod: 'provider',
          }),
        );
      });
    });

    test('links a resolved contact into the lazy DB session on first utterance', async () => {
      let transcriptHandler: ((result: { isFinal: boolean; text: string }) => void) | undefined;
      const mockDeepgramConn = {
        send: vi.fn(),
        close: vi.fn(),
        isOpen: vi.fn(() => true),
        onTranscript: vi.fn((handler) => {
          transcriptHandler = handler;
        }),
        onError: vi.fn(),
        onClose: vi.fn(),
      };
      const mockDeepgram = {
        isConfigured: vi.fn(() => true),
        createConnection: vi.fn(async () => mockDeepgramConn),
      };

      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockIsDatabaseAvailable.mockReturnValue(true);
      mockGetDeepgramService.mockReturnValue(mockDeepgram);
      mockResolveContactIdFromChannelIdentity.mockResolvedValue('contact-twilio-db-1');

      await handleTwilioMediaConnection(ws as any, makeReq());

      await sendStartAndWait(ws, 'stream-db-contact', {
        sessionId: 'voice-db-contact-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-1',
        providerVerificationStrength: 'strong',
      });

      transcriptHandler?.({ isFinal: true, text: 'hello there' });
      await new Promise((resolve) => setTimeout(resolve, 1700));

      await vi.waitFor(() => {
        expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 'voice-db-contact-1',
            contactId: 'contact-twilio-db-1',
          }),
        );
      });
      expect(mockLinkResolvedContactToSession).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          channelType: 'voice_twilio',
          sessionId: 'voice-db-contact-1',
          contactId: 'contact-twilio-db-1',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Media event / audio forwarding
  // ---------------------------------------------------------------------------

  describe('media event', () => {
    test('forwards audio payload to Deepgram when connection exists in pipeline mode', async () => {
      const mockDeepgramConn = {
        send: vi.fn(),
        close: vi.fn(),
        isOpen: vi.fn(() => true),
        onTranscript: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
      };

      const mockDeepgram = {
        isConfigured: vi.fn(() => true),
        createConnection: vi.fn(async () => mockDeepgramConn),
      };
      mockGetDeepgramService.mockReturnValue(mockDeepgram);

      await handleTwilioMediaConnection(ws as any, makeReq());

      // Send start and wait for full handleStreamStart completion
      // (including Deepgram connection creation)
      await sendStartAndWait(ws, 'stream-media', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });

      // Also verify Deepgram connection was created
      await vi.waitFor(() => {
        expect(mockDeepgram.createConnection).toHaveBeenCalled();
      });
      // Extra yield to ensure session.deepgramConnection is assigned
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send media event
      const audioPayload = Buffer.from('test-audio-bytes').toString('base64');
      ws.simulateMessage(
        JSON.stringify({
          event: 'media',
          media: { payload: audioPayload },
        }),
      );

      await vi.waitFor(() => {
        expect(mockDeepgramConn.send).toHaveBeenCalled();
        const sentBuffer = mockDeepgramConn.send.mock.calls[0][0] as Buffer;
        expect(sentBuffer.toString()).toBe('test-audio-bytes');
      });
    });

    test('ignores media event when no session has been started', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());

      // Send media without a prior start — should be silently ignored
      ws.simulateMessage(
        JSON.stringify({
          event: 'media',
          media: { payload: Buffer.from('audio').toString('base64') },
        }),
      );

      // No crash expected
      await vi.waitFor(() => {
        expect(ws.close).not.toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Audio response formatting
  // ---------------------------------------------------------------------------

  describe('audio response formatting', () => {
    test('sends audio to Twilio in correct media message format with streamSid and base64 payload', async () => {
      const mockElevenlabs = {
        isConfigured: vi.fn(() => true),
        synthesizeStream: vi.fn(async function* () {
          yield Buffer.from([0x01, 0x02, 0x03]);
        }),
      };
      mockGetElevenLabsService.mockReturnValue(mockElevenlabs);

      await handleTwilioMediaConnection(ws as any, makeReq());
      await sendStartAndWait(ws, 'stream-fmt', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });

      // handleStreamStart sends initial greeting via synthesizeAndSend.
      // With ElevenLabs configured, it should send audio + mark to Twilio.
      await vi.waitFor(() => {
        const msgs = getSentMessages(ws);
        const mediaMsg = msgs.find((m: any) => m.event === 'media');
        expect(mediaMsg).toBeDefined();
        expect(mediaMsg.streamSid).toBe('stream-fmt');
        expect(mediaMsg.media).toBeDefined();
        expect(mediaMsg.media.payload).toBeDefined();
        // Verify it's valid base64
        expect(() => Buffer.from(mediaMsg.media.payload, 'base64')).not.toThrow();
      });

      // Also verify mark message is sent after audio
      const msgs = getSentMessages(ws);
      const markMsg = msgs.find((m: any) => m.event === 'mark');
      expect(markMsg).toBeDefined();
      expect(markMsg.streamSid).toBe('stream-fmt');
      expect(markMsg.mark.name).toBe('response_complete');
    });
  });

  describe('shared outcome parity', () => {
    test('uses auth-required fallback and synthetic trace when voice auth preflight blocks execution', async () => {
      let transcriptHandler: ((result: { isFinal: boolean; text: string }) => void) | undefined;
      const mockDeepgramConn = {
        send: vi.fn(),
        close: vi.fn(),
        isOpen: vi.fn(() => true),
        onTranscript: vi.fn((handler) => {
          transcriptHandler = handler;
        }),
        onError: vi.fn(),
        onClose: vi.fn(),
      };
      const mockDeepgram = {
        isConfigured: vi.fn(() => true),
        createConnection: vi.fn(async () => mockDeepgramConn),
      };
      const mockSynthesizeStream = vi.fn(async function* (_text: string) {
        yield Buffer.from('audio');
      });
      const mockElevenlabs = {
        isConfigured: vi.fn(() => true),
        synthesizeStream: mockSynthesizeStream,
      };
      const canonicalSessionId = 'voice-auth-session-1';
      const runtimeSession = {
        id: canonicalSessionId,
        userId: 'user-1',
        agentName: 'voice-agent',
        compilationOutput: {},
        versionInfo: { environment: 'prod' },
        tracer: undefined,
        configHash: 'cfg-1',
      };

      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
        getSession: vi.fn((sessionId?: string) =>
          sessionId === canonicalSessionId ? runtimeSession : undefined,
        ),
        executeMessage: vi.fn(async () => ({
          response: 'agent reply',
          action: { type: 'continue' },
          stateUpdates: {},
        })),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetDeepgramService.mockReturnValue(mockDeepgram);
      mockGetElevenLabsService.mockReturnValue(mockElevenlabs);
      mockEvaluateAuthPreflightFromIR.mockResolvedValue({
        pending: [
          {
            connector: 'google',
            authProfileRef: 'google-creds',
            connectionMode: 'per_user',
          },
        ],
        satisfied: [],
      });

      await handleTwilioMediaConnection(ws as any, makeReq());
      await sendStartAndWait(ws, 'stream-auth', {
        sessionId: canonicalSessionId,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-1',
      });

      transcriptHandler?.({ isFinal: true, text: 'Book a flight' });
      await new Promise((resolve) => setTimeout(resolve, 1700));

      await vi.waitFor(() => {
        expect(mockSynthesizeStream).toHaveBeenCalledTimes(2);
      });

      expect(executor.executeMessage).not.toHaveBeenCalled();
      expect(mockSynthesizeStream.mock.calls.at(-1)?.[0]).toBe(
        PLATFORM_MESSAGES.AUTH_REQUIRED_FALLBACK,
      );
      expect(mockRecordSyntheticTraceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: canonicalSessionId,
        }),
      );
      expect(mockEmitChannelResponseSent).toHaveBeenCalledWith(
        canonicalSessionId,
        'twilio_voice',
        expect.any(Number),
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          configHash: 'cfg-1',
        }),
      );
    });

    test('uses shared execution-error fallback and synthetic trace when executeMessage fails', async () => {
      let transcriptHandler: ((result: { isFinal: boolean; text: string }) => void) | undefined;
      const mockDeepgramConn = {
        send: vi.fn(),
        close: vi.fn(),
        isOpen: vi.fn(() => true),
        onTranscript: vi.fn((handler) => {
          transcriptHandler = handler;
        }),
        onError: vi.fn(),
        onClose: vi.fn(),
      };
      const mockDeepgram = {
        isConfigured: vi.fn(() => true),
        createConnection: vi.fn(async () => mockDeepgramConn),
      };
      const mockSynthesizeStream = vi.fn(async function* (_text: string) {
        yield Buffer.from('audio');
      });
      const mockElevenlabs = {
        isConfigured: vi.fn(() => true),
        synthesizeStream: mockSynthesizeStream,
      };
      const canonicalSessionId = 'voice-error-session-1';
      const runtimeSession = {
        id: canonicalSessionId,
        userId: 'user-1',
        agentName: 'voice-agent',
        compilationOutput: {},
        versionInfo: { environment: 'prod' },
        tracer: undefined,
        configHash: 'cfg-1',
      };

      executor = makeMockExecutor({
        isConfigured: vi.fn(() => true),
        getSession: vi.fn((sessionId?: string) =>
          sessionId === canonicalSessionId ? runtimeSession : undefined,
        ),
        executeMessage: vi.fn(async () => {
          throw new Error('runtime exploded');
        }),
      });
      mockGetRuntimeExecutor.mockReturnValue(executor);
      mockGetDeepgramService.mockReturnValue(mockDeepgram);
      mockGetElevenLabsService.mockReturnValue(mockElevenlabs);
      mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);

      await handleTwilioMediaConnection(ws as any, makeReq());
      await sendStartAndWait(ws, 'stream-error', {
        sessionId: canonicalSessionId,
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        caller: '+15551230001',
        called: '+15558675309',
        channelId: 'voice-number-1',
      });

      transcriptHandler?.({ isFinal: true, text: 'Need help' });
      await new Promise((resolve) => setTimeout(resolve, 1700));

      await vi.waitFor(() => {
        expect(mockSynthesizeStream).toHaveBeenCalledTimes(2);
      });

      expect(mockSynthesizeStream.mock.calls.at(-1)?.[0]).toBe(
        PLATFORM_MESSAGES.EXECUTION_FAILED_FALLBACK,
      );
      expect(mockRecordSyntheticTraceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: canonicalSessionId,
        }),
      );
      expect(mockEmitChannelResponseSent).toHaveBeenCalledWith(
        canonicalSessionId,
        'twilio_voice',
        expect.any(Number),
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          configHash: 'cfg-1',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Stop event
  // ---------------------------------------------------------------------------

  describe('stop event', () => {
    test('cleans up media session on stop event', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());
      await sendStartAndWait(ws, 'stream-stop', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });

      expect(getMediaSession('stream-stop')).toBeDefined();

      ws.simulateMessage(JSON.stringify({ event: 'stop' }));

      await vi.waitFor(() => {
        expect(getMediaSession('stream-stop')).toBeUndefined();
      });
    });

    test('closes Deepgram connection on stop', async () => {
      const mockDeepgramConn = {
        send: vi.fn(),
        close: vi.fn(),
        isOpen: vi.fn(() => true),
        onTranscript: vi.fn(),
        onError: vi.fn(),
        onClose: vi.fn(),
      };

      const mockDeepgram = {
        isConfigured: vi.fn(() => true),
        createConnection: vi.fn(async () => mockDeepgramConn),
      };
      mockGetDeepgramService.mockReturnValue(mockDeepgram);

      await handleTwilioMediaConnection(ws as any, makeReq());
      await sendStartAndWait(ws, 'stream-dg-stop', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });

      // Verify Deepgram was set up
      await vi.waitFor(() => {
        expect(mockDeepgram.createConnection).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      ws.simulateMessage(JSON.stringify({ event: 'stop' }));

      await vi.waitFor(() => {
        expect(mockDeepgramConn.close).toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnect cleanup
  // ---------------------------------------------------------------------------

  describe('disconnect cleanup', () => {
    test('cleans up session on WebSocket close', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());
      await sendStartAndWait(ws, 'stream-close', {
        tenantId: 'tenant-1',
        projectId: 'proj-1',
      });

      expect(getMediaSession('stream-close')).toBeDefined();

      ws.simulateClose();

      // handleStreamStop is called fire-and-forget in the close handler
      await vi.waitFor(() => {
        expect(getMediaSession('stream-close')).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    test('handles WebSocket error event without crashing', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());

      // Should not throw
      ws.simulateError(new Error('connection reset by peer'));

      expect(ws.close).not.toHaveBeenCalled();
    });

    test('handles malformed JSON messages gracefully', async () => {
      await handleTwilioMediaConnection(ws as any, makeReq());

      // Send non-JSON data
      ws.simulateMessage('this is not valid json {{{');

      // Should not crash — error logged internally
      await vi.waitFor(() => {
        expect(ws.close).not.toHaveBeenCalled();
      });
    });
  });
});
