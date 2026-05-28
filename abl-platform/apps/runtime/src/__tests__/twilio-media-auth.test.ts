/**
 * Twilio Media WebSocket — Connection-Level Auth & Idempotent Cleanup Tests
 *
 * Verifies that handleTwilioMediaConnection:
 *   1. Rejects connections with invalid or missing HMAC connection tokens
 *   2. Rejects connections when Twilio is not configured
 *   3. Allows the production Twilio upgrade shape (valid token, no signature header)
 *   4. Validates the upgrade URL passed to Twilio signature verification when present
 *   5. handleStreamStop is idempotent (stop event + ws close don't cause double cleanup)
 *
 * NOTE: This file necessarily mocks internal modules because the handler
 * has deep dependencies on runtime services, DB, Redis, etc. These are
 * infrastructure mocks — the handler cannot be instantiated otherwise.
 * The TwilioService signature and token helpers themselves are tested without mocks in
 * twilio-service.test.ts.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// HOISTED MOCKS — must be hoisted so vi.mock factories can reference them
// =============================================================================

const {
  mockIsConfigured,
  mockValidateWebhookSignature,
  mockValidateMediaStreamToken,
  mockGetSession,
  mockIsRuntimeConfigured,
  mockHandleDisconnect,
} = vi.hoisted(() => ({
  mockIsConfigured: vi.fn(),
  mockValidateWebhookSignature: vi.fn(),
  mockValidateMediaStreamToken: vi.fn(),
  mockGetSession: vi.fn(),
  mockIsRuntimeConfigured: vi.fn(),
  mockHandleDisconnect: vi.fn(),
}));

// =============================================================================
// MOCKS
// =============================================================================

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../services/voice/twilio-service.js', () => ({
  getTwilioService: vi.fn(() => ({
    isConfigured: mockIsConfigured,
    validateWebhookSignature: mockValidateWebhookSignature,
    validateMediaStreamToken: mockValidateMediaStreamToken,
  })),
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: mockGetSession,
    isConfigured: mockIsRuntimeConfigured,
    executeMessage: vi.fn().mockResolvedValue({ response: 'ok' }),
    rehydrateSession: vi.fn().mockResolvedValue(undefined),
  })),
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../services/voice/deepgram-service.js', () => ({
  getDeepgramService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../services/voice/elevenlabs-service.js', () => ({
  getElevenLabsService: vi.fn(() => ({
    isConfigured: () => false,
  })),
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: () => false,
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../server.js', () => ({
  app: { locals: {} },
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../services/channel/constants.js', () => ({
  RUNTIME_CHANNEL: { VOICE: 'voice' },
  PLATFORM_MESSAGES: {
    VOICE_RUNTIME_NOT_CONFIGURED: 'Runtime not configured',
    VOICE_PROCESSING_ERROR: 'Processing error',
  },
  MAX_MEDIA_SESSIONS: 100,
  MEDIA_SESSION_TTL_MS: 3600000,
  WS_MESSAGE_TIMEOUT_MS: 90000,
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../services/channel/channel-adapter.js', () => ({
  getChannelAdapterRegistry: vi.fn(() => ({
    resolve: vi.fn(({ text }: any) => text),
  })),
}));

// eslint-disable-next-line -- infrastructure mock required for handler isolation
vi.mock('../channels/pipeline/index.js', () => ({
  createRuntimeSession: vi.fn().mockResolvedValue({
    runtimeSession: { id: 'runtime-1' },
    entryAgentName: 'test-agent',
    resolved: null,
  }),
  createAndLinkDBSession: vi.fn().mockResolvedValue({ dbSessionId: 'db-1' }),
  resolveEnvironmentLabel: vi.fn(() => 'dev'),
  handleDisconnect: mockHandleDisconnect,
}));

// eslint-disable-next-line -- infrastructure mock for contact linking (used in handleStreamStart)
vi.mock('../services/identity/channel-contact-linking.js', () => ({
  resolveContactIdFromChannelIdentity: vi.fn().mockResolvedValue(undefined),
  linkResolvedContactToSession: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line -- infrastructure mock for session repo (used in handleStreamStart)
vi.mock('../repos/session-repo.js', () => ({
  findSessionById: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line -- infrastructure mock for trace utils
vi.mock('../services/channel-trace-utils.js', () => ({
  emitChannelResponseSent: vi.fn(),
  recordSyntheticTraceEvent: vi.fn(),
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { handleTwilioMediaConnection } from '../websocket/twilio-media-handler.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a mock WebSocket that captures event handlers.
 *
 * `simulateMessage` RETURNS the Promise from the async handler so callers
 * can `await` it — this is essential because handleStreamStart contains a
 * slow dynamic import; without awaiting, the local `session` variable in
 * the handler closure is not yet assigned.
 */
function createMockWs() {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    on: vi.fn((event: string, handler: any) => {
      handlers.set(event, handler);
    }),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    OPEN: 1,
    _handlers: handlers,
    /** Simulate receiving a Twilio message — returns the handler's Promise */
    simulateMessage(msg: any): Promise<void> {
      const handler = handlers.get('message');
      if (handler) return handler(Buffer.from(JSON.stringify(msg)));
      return Promise.resolve();
    },
    /** Simulate WebSocket close event */
    simulateClose() {
      const handler = handlers.get('close');
      if (handler) handler();
    },
  };
}

function createMockReq(
  url = '/voice/media',
  headers: Record<string, string> = { host: 'localhost:3112' },
) {
  return {
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    url,
  } as any;
}

// =============================================================================
// TESTS — Connection-Level Authentication
// =============================================================================

describe('Twilio Media WS — connection-level auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReset();
    mockIsConfigured.mockReturnValue(false);
    mockValidateWebhookSignature.mockResolvedValue(true);
    mockValidateMediaStreamToken.mockReturnValue(true);
    mockIsRuntimeConfigured.mockReturnValue(true);
    mockHandleDisconnect.mockResolvedValue(undefined);
  });

  test('rejects connection when Twilio is configured but the connection token is missing', async () => {
    mockIsConfigured.mockReturnValue(true);
    const ws = createMockWs();
    const req = createMockReq('/voice/media');

    await handleTwilioMediaConnection(ws as any, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(ws.on).not.toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockValidateMediaStreamToken).not.toHaveBeenCalled();
    expect(mockValidateWebhookSignature).not.toHaveBeenCalled();
  });

  test('rejects connection when the connection token is invalid even if a signature header is present', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockValidateMediaStreamToken.mockReturnValue(false);
    const ws = createMockWs();
    const req = createMockReq('/voice/media?token=bad-token', {
      host: 'localhost:3112',
      'x-twilio-signature': 'valid-signature',
    });

    await handleTwilioMediaConnection(ws as any, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(mockValidateMediaStreamToken).toHaveBeenCalledWith('bad-token');
    expect(mockValidateWebhookSignature).not.toHaveBeenCalled();
  });

  test('allows connection when the token is valid and no signature header is present', async () => {
    mockIsConfigured.mockReturnValue(true);
    const ws = createMockWs();
    const req = createMockReq('/voice/media?token=valid-token');

    await handleTwilioMediaConnection(ws as any, req);

    expect(ws.close).not.toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(ws.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockValidateMediaStreamToken).toHaveBeenCalledWith('valid-token');
    expect(mockValidateWebhookSignature).not.toHaveBeenCalled();
  });

  test('rejects connection when Twilio is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);
    const ws = createMockWs();
    const req = createMockReq('/voice/media?token=unused-token', {
      host: 'localhost:3112',
      'x-twilio-signature': 'unused-signature',
    });

    await handleTwilioMediaConnection(ws as any, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(mockValidateWebhookSignature).not.toHaveBeenCalled();
    expect(mockValidateMediaStreamToken).not.toHaveBeenCalled();
    expect(ws.on).not.toHaveBeenCalledWith('message', expect.any(Function));
  });

  test('validates the reconstructed upgrade URL when an optional signature header is present', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockValidateMediaStreamToken.mockReturnValue(true);
    const ws = createMockWs();
    const tokenWithDot = '1234567890.abcdef';
    const req = createMockReq(`/voice/media?token=${encodeURIComponent(tokenWithDot)}`, {
      host: 'internal-runtime:3112',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'voice.example.com',
      'x-twilio-signature': 'forwarded-signature',
    });

    await handleTwilioMediaConnection(ws as any, req);

    expect(mockValidateWebhookSignature).toHaveBeenCalledWith(
      'forwarded-signature',
      'wss://voice.example.com/voice/media?token=1234567890.abcdef',
      {},
    );
    expect(mockValidateMediaStreamToken).toHaveBeenCalledWith(tokenWithDot);
    expect(ws.close).not.toHaveBeenCalledWith(1008, 'Unauthorized');
  });

  test('rejects connection when an optional signature header is present but invalid', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockValidateMediaStreamToken.mockReturnValue(true);
    mockValidateWebhookSignature.mockResolvedValue(false);
    const ws = createMockWs();
    const req = createMockReq('/voice/media?token=valid-token', {
      host: 'localhost:3112',
      'x-twilio-signature': 'bad-signature',
    });

    await handleTwilioMediaConnection(ws as any, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(mockValidateMediaStreamToken).toHaveBeenCalledWith('valid-token');
    expect(mockValidateWebhookSignature).toHaveBeenCalledWith(
      'bad-signature',
      'ws://localhost:3112/voice/media?token=valid-token',
      {},
    );
  });

  test('rejects connection when optional signature validation throws', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockValidateMediaStreamToken.mockReturnValue(true);
    mockValidateWebhookSignature.mockRejectedValue(new Error('signature failure'));
    const ws = createMockWs();
    const req = createMockReq('/voice/media?token=valid-token', {
      host: 'localhost:3112',
      'x-twilio-signature': 'signature-that-throws',
    });

    await handleTwilioMediaConnection(ws as any, req);

    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(mockValidateMediaStreamToken).toHaveBeenCalledWith('valid-token');
    expect(mockValidateWebhookSignature).toHaveBeenCalledWith(
      'signature-that-throws',
      'ws://localhost:3112/voice/media?token=valid-token',
      {},
    );
  });
});

// =============================================================================
// TESTS — Idempotent Cleanup (double stop)
// =============================================================================

describe('Twilio Media WS — idempotent cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReset();
    mockIsConfigured.mockReturnValue(true);
    mockValidateMediaStreamToken.mockReturnValue(true);
    mockValidateWebhookSignature.mockResolvedValue(true);
    mockIsRuntimeConfigured.mockReturnValue(true);
    mockHandleDisconnect.mockResolvedValue(undefined);
  });

  test('handleStreamStop runs cleanup only once on stop event + ws close', async () => {
    const ws = createMockWs();
    const req = createMockReq('/voice/media?token=cleanup-token');

    await handleTwilioMediaConnection(ws as any, req);

    // Await the start handler so the local session variable is assigned
    await ws.simulateMessage({
      event: 'start',
      start: {
        streamSid: 'stream-cleanup-1',
        accountSid: 'acct-1',
        callSid: 'call-1',
        customParameters: { tenantId: 'tenant-1', projectId: 'proj-1' },
      },
    });

    // Await the stop handler — first cleanup
    await ws.simulateMessage({ event: 'stop' });

    // Fire WebSocket close — should NOT run cleanup again (idempotent guard)
    ws.simulateClose();
    // Let any fire-and-forget cleanup settle
    await new Promise((r) => setTimeout(r, 100));

    // handleDisconnect should only be called once despite both stop + close firing
    expect(mockHandleDisconnect).toHaveBeenCalledTimes(1);
  }, 30_000);

  test('ws close still cleans up when no stop event was received', async () => {
    const ws = createMockWs();
    const req = createMockReq('/voice/media?token=cleanup-token');

    await handleTwilioMediaConnection(ws as any, req);

    // Await the start handler
    await ws.simulateMessage({
      event: 'start',
      start: {
        streamSid: 'stream-cleanup-2',
        accountSid: 'acct-1',
        callSid: 'call-2',
        customParameters: { tenantId: 'tenant-1', projectId: 'proj-1' },
      },
    });

    // WebSocket close without stop event — should still clean up
    ws.simulateClose();
    await new Promise((r) => setTimeout(r, 200));

    expect(mockHandleDisconnect).toHaveBeenCalledTimes(1);
  }, 30_000);
});
