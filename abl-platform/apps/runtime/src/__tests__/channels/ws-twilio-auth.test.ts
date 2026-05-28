/**
 * Twilio Media WebSocket — Auth Validation Tests
 *
 * Verifies that handleStreamStart:
 *   1. Requires tenantId and projectId in customParameters
 *   2. Validates session belongs to the claimed tenant when sessionId is provided
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockGetSession = vi.fn();
const mockIsConfigured = vi.fn().mockReturnValue(true);
const mockTwilioIsConfigured = vi.fn().mockReturnValue(true);
const mockValidateWebhookSignature = vi.fn().mockResolvedValue(true);
const mockValidateMediaStreamToken = vi.fn().mockReturnValue(true);

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: mockGetSession,
    isConfigured: mockIsConfigured,
    executeMessage: vi.fn().mockResolvedValue({ response: 'ok' }),
  })),
}));

vi.mock('../../services/voice/twilio-service.js', () => ({
  getTwilioService: vi.fn(() => ({
    isConfigured: mockTwilioIsConfigured,
    validateWebhookSignature: mockValidateWebhookSignature,
    validateMediaStreamToken: mockValidateMediaStreamToken,
  })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../services/voice/deepgram-service.js', () => ({
  getDeepgramService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

vi.mock('../../services/voice/elevenlabs-service.js', () => ({
  getElevenLabsService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: () => false,
}));

vi.mock('../../server.js', () => ({
  app: { locals: {} },
}));

vi.mock('../../services/channel/constants.js', () => ({
  RUNTIME_CHANNEL: { VOICE: 'voice' },
  PLATFORM_MESSAGES: {
    VOICE_RUNTIME_NOT_CONFIGURED: 'Runtime not configured',
    VOICE_PROCESSING_ERROR: 'Processing error',
  },
  MAX_MEDIA_SESSIONS: 100,
  MEDIA_SESSION_TTL_MS: 3600000,
}));

vi.mock('../../services/channel/channel-adapter.js', () => ({
  getChannelAdapterRegistry: vi.fn(() => ({
    resolve: vi.fn(({ text }: any) => text),
  })),
}));

vi.mock('../../channels/pipeline/index.js', () => ({
  createRuntimeSession: vi.fn().mockResolvedValue({
    runtimeSession: { id: 'runtime-1' },
    entryAgentName: 'test-agent',
    resolved: null,
  }),
  createAndLinkDBSession: vi.fn().mockResolvedValue({ dbSessionId: 'db-1' }),
  resolveEnvironmentLabel: vi.fn(() => 'dev'),
  handleDisconnect: vi.fn(),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { handleTwilioMediaConnection } from '../../websocket/twilio-media-handler.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockWs() {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    on: vi.fn((event: string, handler: any) => {
      handlers.set(event, handler);
    }),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    OPEN: 1,
    _handlers: handlers,
    /** Simulate receiving a Twilio message */
    simulateMessage(msg: any) {
      const handler = handlers.get('message');
      if (handler) handler(Buffer.from(JSON.stringify(msg)));
    },
  };
}

function createMockReq() {
  return {
    headers: {
      host: 'localhost:3112',
      'x-twilio-signature': 'valid-signature',
    },
    socket: { remoteAddress: '127.0.0.1' },
    url: '/voice/media?token=valid-token',
  } as any;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Twilio Media WS — auth validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReset();
    mockTwilioIsConfigured.mockReturnValue(true);
    mockValidateWebhookSignature.mockResolvedValue(true);
    mockValidateMediaStreamToken.mockReturnValue(true);
  });

  test('closes connection when tenantId is missing', async () => {
    const ws = createMockWs();
    const req = createMockReq();

    await handleTwilioMediaConnection(ws as any, req);

    // Simulate Twilio start event without tenantId
    ws.simulateMessage({
      event: 'start',
      start: {
        streamSid: 'stream-1',
        accountSid: 'acct-1',
        callSid: 'call-1',
        customParameters: { projectId: 'proj-1' },
      },
    });

    // Allow async handler to run
    await new Promise((r) => setTimeout(r, 50));

    expect(ws.close).toHaveBeenCalledWith(1008, 'Missing required parameters');
  });

  test('closes connection when projectId is missing', async () => {
    const ws = createMockWs();
    const req = createMockReq();

    await handleTwilioMediaConnection(ws as any, req);

    ws.simulateMessage({
      event: 'start',
      start: {
        streamSid: 'stream-1',
        accountSid: 'acct-1',
        callSid: 'call-1',
        customParameters: { tenantId: 'tenant-1' },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ws.close).toHaveBeenCalledWith(1008, 'Missing required parameters');
  });

  test('closes connection when session tenant does not match', async () => {
    const ws = createMockWs();
    const req = createMockReq();

    // Mock: session belongs to tenant-B, but caller claims tenant-A
    mockGetSession.mockReturnValue({ tenantId: 'tenant-B' });

    await handleTwilioMediaConnection(ws as any, req);

    ws.simulateMessage({
      event: 'start',
      start: {
        streamSid: 'stream-1',
        accountSid: 'acct-1',
        callSid: 'call-1',
        customParameters: {
          tenantId: 'tenant-A',
          projectId: 'proj-1',
          sessionId: 'existing-session-1',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(ws.close).toHaveBeenCalledWith(1008, 'Session not found');
  });

  test('allows connection when tenantId and projectId are provided', async () => {
    const ws = createMockWs();
    const req = createMockReq();
    mockIsConfigured.mockReturnValue(false);

    await handleTwilioMediaConnection(ws as any, req);

    ws.simulateMessage({
      event: 'start',
      start: {
        streamSid: 'stream-1',
        accountSid: 'acct-1',
        callSid: 'call-1',
        customParameters: { tenantId: 'tenant-1', projectId: 'proj-1' },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Should NOT be closed with 1008
    const closeCalls = ws.close.mock.calls.filter((call: any[]) => call[0] === 1008);
    expect(closeCalls).toHaveLength(0);
  });

  test('allows connection when session tenant matches', async () => {
    const ws = createMockWs();
    const req = createMockReq();
    mockIsConfigured.mockReturnValue(false);

    // Session belongs to same tenant
    mockGetSession.mockReturnValue({ tenantId: 'tenant-A' });

    await handleTwilioMediaConnection(ws as any, req);

    ws.simulateMessage({
      event: 'start',
      start: {
        streamSid: 'stream-1',
        accountSid: 'acct-1',
        callSid: 'call-1',
        customParameters: {
          tenantId: 'tenant-A',
          projectId: 'proj-1',
          sessionId: 'existing-session-1',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    const closeCalls = ws.close.mock.calls.filter((call: any[]) => call[0] === 1008);
    expect(closeCalls).toHaveLength(0);
  });
});
