import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger, mockEvaluateAuthPreflightFromIR, mockCreateTokenLookups } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockEvaluateAuthPreflightFromIR = vi.fn();
  const mockCreateTokenLookups = vi.fn(() => ({}));

  return {
    mockLogger,
    mockEvaluateAuthPreflightFromIR,
    mockCreateTokenLookups,
  };
});

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    addEvent: vi.fn(),
    getEvents: vi.fn(() => []),
    setSessionAgent: vi.fn(),
    removeSession: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => null),
}));

vi.mock('../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: mockEvaluateAuthPreflightFromIR,
  createTokenLookups: mockCreateTokenLookups,
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { KorevgSession } from '../services/voice/korevg/korevg-session.js';

describe('KorevgSession Orpheus streaming mode', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);
  });

  function createSession(orpheusWsStreamingEnabled: boolean) {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      getSession: vi.fn(() => undefined),
      rehydrateSession: vi.fn(async () => null),
      executeMessage: vi.fn(),
    } as any;

    return new KorevgSession(
      ws,
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'agent-1',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
        voiceMode: 'pipeline',
        ttsVendor: 'custom:orpheus',
        ttsVoice: 'austin',
        orpheusWsStreamingEnabled,
      },
      executor,
    ) as any;
  }

  it('keeps Orpheus buffered when the connection is not opted in', async () => {
    process.env.ORPHEUS_TTS_ENABLE_WS_STREAMING = 'true';
    process.env.ORPHEUS_TTS_WS_VALIDATED = 'true';

    const session = createSession(false);
    await session.resolveStreamingMode();

    expect(session.useStreaming).toBe(false);
  });

  it('keeps Orpheus buffered until both runtime gates are enabled', async () => {
    process.env.ORPHEUS_TTS_ENABLE_WS_STREAMING = 'true';
    process.env.ORPHEUS_TTS_WS_VALIDATED = 'false';

    const session = createSession(true);
    await session.resolveStreamingMode();

    expect(session.useStreaming).toBe(false);
  });

  it('enables Orpheus WS streaming when the connection and runtime gates are all enabled', async () => {
    process.env.ORPHEUS_TTS_ENABLE_WS_STREAMING = 'true';
    process.env.ORPHEUS_TTS_WS_VALIDATED = 'true';

    const session = createSession(true);
    await session.resolveStreamingMode();

    expect(session.useStreaming).toBe(true);
  });
});
