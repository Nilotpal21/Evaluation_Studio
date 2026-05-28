import { beforeEach, describe, expect, test, vi } from 'vitest';

const {
  traceEvents,
  mockLogger,
  mockEvaluateAuthPreflightFromIR,
  mockCreateTokenLookups,
  mockPersistMessage,
  mockPersistTurnMetrics,
  mockGetSupportedLanguagesAndVoices,
} = vi.hoisted(() => {
  const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockEvaluateAuthPreflightFromIR = vi.fn();
  const mockCreateTokenLookups = vi.fn(() => ({}));
  const mockPersistMessage = vi.fn(async () => undefined);
  const mockPersistTurnMetrics = vi.fn(async () => undefined);
  const mockGetSupportedLanguagesAndVoices = vi.fn();

  return {
    traceEvents,
    mockLogger,
    mockEvaluateAuthPreflightFromIR,
    mockCreateTokenLookups,
    mockPersistMessage,
    mockPersistTurnMetrics,
    mockGetSupportedLanguagesAndVoices,
  };
});

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    addEvent: vi.fn(
      (_sessionId: string, event: { type: string; data: Record<string, unknown> }) => {
        traceEvents.push(event);
      },
    ),
    getEvents: vi.fn(() => traceEvents),
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

vi.mock('../services/message-persistence-queue.js', () => ({
  persistMessage: (...args: unknown[]) => mockPersistMessage(...args),
  persistMessageRecord: vi.fn(async () => undefined),
  persistTurnMetrics: (...args: unknown[]) => mockPersistTurnMetrics(...args),
}));

vi.mock('../services/voice/jambonz-provisioning.service.js', () => ({
  getJambonzProvisioningService: vi.fn(() => ({
    getSupportedLanguagesAndVoices: mockGetSupportedLanguagesAndVoices,
  })),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { KorevgSession } from '../services/voice/korevg/korevg-session.js';
import { clearTtsLanguageResolutionCache } from '../services/voice/tts-language-resolver.js';

const NEAR_LIMIT_SESSION_METADATA = {
  preserved: 'x'.repeat(250_000),
};

const FOLLOW_UP_SESSION_METADATA = {
  next: 'y'.repeat(20_000),
};

describe('KorevgSession voice behavior', () => {
  beforeEach(() => {
    traceEvents.length = 0;
    vi.clearAllMocks();
    mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);
    mockPersistMessage.mockClear();
    mockPersistTurnMetrics.mockClear();
    mockGetSupportedLanguagesAndVoices.mockReset();
    clearTtsLanguageResolutionCache();
  });

  test('emits sttModel on voice_stt and voice_turn events', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
    } as any;

    const executor = {
      getSession: vi.fn(() => undefined),
      rehydrateSession: vi.fn(async () => null),
      executeMessage: vi.fn(
        async (
          _sessionId: string,
          _userInput: string,
          onChunk?: ((chunk: string) => void) | undefined,
          onTraceEvent?:
            | ((event: { type: string; data: Record<string, unknown> }) => void)
            | undefined,
        ) => {
          onTraceEvent?.({
            type: 'agent_enter',
            data: { agentName: 'supervisor' },
          });
          onChunk?.('Hello from the agent.');
          return {
            response: 'Hello from the agent.',
            action: { type: 'continue' },
            stateUpdates: { currentAgent: 'supervisor' },
          };
        },
      ),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
        voiceMode: 'pipeline',
      },
      executor,
    ) as any;

    session.ttsStreamOpen = true;

    await session.handleVerbHook({
      type: 'verb:hook',
      msgid: 'msg-1',
      call_sid: 'call-1',
      data: {
        speech: {
          alternatives: [{ transcript: 'Check the STT model', confidence: 0.93 }],
          language_code: 'en-US',
        },
        stt_latency_ms: '250',
      },
    });

    const voiceSttEvent = traceEvents.find((event) => event.type === 'voice_stt');
    const voiceTurnEvent = traceEvents.find((event) => event.type === 'voice_turn');

    expect(voiceSttEvent).toBeTruthy();
    expect(voiceSttEvent?.data).toMatchObject({
      transcript: 'Check the STT model',
      provider: 'deepgram',
      sttLatencyMs: 250,
      sttModel: 'nova-3',
    });

    expect(voiceTurnEvent).toBeTruthy();
    expect(voiceTurnEvent?.data).toMatchObject({
      utterance: 'Check the STT model',
      response: 'Hello from the agent.',
      sttModel: 'nova-3',
    });
    expect(voiceTurnEvent?.data.timing).toEqual(
      expect.objectContaining({
        stt: expect.any(Number),
        llm: expect.any(Number),
        tts: expect.any(Number),
      }),
    );

    expect(executor.executeMessage).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalled();
  });

  test('uses plain-text voiceConfig for non-streaming KoreVG speech delivery', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      getSession: vi.fn(() => undefined),
      rehydrateSession: vi.fn(async () => null),
      executeMessage: vi.fn(
        async (
          _sessionId: string,
          _userInput: string,
          _onChunk?: ((chunk: string) => void) | undefined,
          onTraceEvent?:
            | ((event: { type: string; data: Record<string, unknown> }) => void)
            | undefined,
        ) => {
          onTraceEvent?.({
            type: 'agent_enter',
            data: { agentName: 'supervisor' },
          });
          return {
            response: 'Hello **bold**',
            voiceConfig: { plain_text: 'Hello bold' },
            action: { type: 'continue' },
          };
        },
      ),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-plain-text',
        callSid: 'call-plain-text',
        streamId: 'stream-plain-text',
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
        voiceMode: 'pipeline',
      },
      executor,
    ) as any;

    session.useStreaming = false;
    session.waitForTtsSynthEvent = vi.fn(async () => 0);

    await session.handleVerbHook({
      type: 'verb:hook',
      msgid: 'msg-plain-text',
      call_sid: 'call-plain-text',
      data: {
        speech: {
          alternatives: [{ transcript: 'Say hello', confidence: 0.97 }],
          language_code: 'en-US',
        },
      },
    });

    const redirectCommand = ws.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(payload))
      .find(
        (message: { command?: string; data?: Array<{ verb?: string; text?: string }> }) =>
          message.command === 'redirect' &&
          Array.isArray(message.data) &&
          message.data.some((verb) => verb.verb === 'say'),
      );

    expect(redirectCommand).toBeDefined();
    expect(redirectCommand?.data?.[0]).toMatchObject({
      verb: 'say',
      text: 'Hello bold',
    });
    expect(JSON.stringify(redirectCommand)).not.toContain('**');
  });

  test('uses supported gateway-reported language for current-turn TTS and execution hint', async () => {
    mockGetSupportedLanguagesAndVoices.mockResolvedValue({
      tts: [
        {
          code: 'es-MX',
          name: 'Spanish Mexico',
          voices: [{ value: 'voice-en', name: 'Configured Voice' }],
        },
      ],
      stt: [],
    });

    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      getSession: vi.fn(() => undefined),
      rehydrateSession: vi.fn(async () => null),
      executeMessage: vi.fn(async () => ({
        response: 'Hola, puedo ayudar.',
        action: { type: 'continue' },
      })),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-language-supported',
        callSid: 'call-language-supported',
        streamId: 'stream-language-supported',
        sttVendor: 'deepgram',
        ttsVendor: 'elevenlabs',
        ttsVoice: 'voice-en',
        ttsLanguage: 'en',
        tenantId: 'tenant-1',
        voiceMode: 'pipeline',
      },
      executor,
    ) as any;

    session.useStreaming = false;
    session.waitForTtsSynthEvent = vi.fn(async () => 0);

    await session.handleVerbHook({
      type: 'verb:hook',
      msgid: 'msg-language-supported',
      call_sid: 'call-language-supported',
      data: {
        speech: {
          alternatives: [{ transcript: 'Necesito ayuda', confidence: 0.97 }],
          language_code: 'es-MX',
        },
      },
    });

    const redirectCommand = ws.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(payload))
      .find(
        (message: { command?: string; data?: Array<{ verb?: string }> }) =>
          message.command === 'redirect' &&
          Array.isArray(message.data) &&
          message.data.some((verb) => verb.verb === 'say'),
      );

    expect(redirectCommand?.data?.[0]).toMatchObject({
      verb: 'say',
      text: 'Hola, puedo ayudar.',
      synthesizer: {
        language: 'es-MX',
        voice: 'voice-en',
      },
    });
    expect(executor.executeMessage).toHaveBeenCalledWith(
      'session-language-supported',
      'Necesito ayuda',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        interactionContextHint: {
          language: 'es',
          locale: 'es-MX',
        },
      }),
    );
  });

  test('keeps configured TTS language for unsupported gateway-reported language without error log', async () => {
    mockGetSupportedLanguagesAndVoices.mockResolvedValue({
      tts: [
        {
          code: 'es-MX',
          name: 'Spanish Mexico',
          voices: [{ value: 'voice-es', name: 'Spanish Voice' }],
        },
      ],
      stt: [],
    });

    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      getSession: vi.fn(() => undefined),
      rehydrateSession: vi.fn(async () => null),
      executeMessage: vi.fn(async () => ({
        response: 'Hello from configured TTS.',
        action: { type: 'continue' },
      })),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-language-unsupported',
        callSid: 'call-language-unsupported',
        streamId: 'stream-language-unsupported',
        sttVendor: 'deepgram',
        ttsVendor: 'elevenlabs',
        ttsVoice: 'voice-en',
        ttsLanguage: 'en',
        tenantId: 'tenant-1',
        voiceMode: 'pipeline',
      },
      executor,
    ) as any;

    session.useStreaming = false;
    session.waitForTtsSynthEvent = vi.fn(async () => 0);

    await session.handleVerbHook({
      type: 'verb:hook',
      msgid: 'msg-language-unsupported',
      call_sid: 'call-language-unsupported',
      data: {
        speech: {
          alternatives: [{ transcript: 'Necesito ayuda', confidence: 0.97 }],
          language_code: 'es-MX',
        },
      },
    });

    const redirectCommand = ws.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(payload))
      .find(
        (message: { command?: string; data?: Array<{ verb?: string }> }) =>
          message.command === 'redirect' &&
          Array.isArray(message.data) &&
          message.data.some((verb) => verb.verb === 'say'),
      );

    expect(redirectCommand?.data?.[0]).toMatchObject({
      verb: 'say',
      text: 'Hello from configured TTS.',
      synthesizer: {
        language: 'en',
        voice: 'voice-en',
      },
    });
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'voice_config_resolved',
          data: expect.objectContaining({
            scope: 'tts_language',
            reason: 'unsupported',
            diagnosticCode: 'VOICE_TTS_LANGUAGE_UNSUPPORTED',
            severity: 'warning',
            effectiveTtsLanguage: 'en',
          }),
        }),
      ]),
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('does not reopen an active streaming TTS connection for the configured default language', () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const session = new KorevgSession(ws, {
      projectId: 'project-1',
      agentId: 'supervisor',
      deploymentId: 'deployment-1',
      sessionId: 'session-streaming-default-language',
      callSid: 'call-streaming-default-language',
      streamId: 'stream-streaming-default-language',
      sttVendor: 'microsoft',
      sttLanguage: 'zh-CN',
      ttsVendor: 'microsoft',
      ttsVoice: 'zh-CN-XiaoxiaoNeural',
      ttsLanguage: 'zh-CN',
      tenantId: 'tenant-1',
      voiceMode: 'pipeline',
    }) as any;

    session.useStreaming = true;
    session.ttsStreamOpen = true;
    session.currentTurnTtsLanguage = undefined;
    session.activeStreamingTtsLanguage = undefined;

    session.ensureStreamingTtsReady('turn_start');

    expect(ws.send).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      '[TTS-STREAM] Reconfiguring streaming TTS language',
      expect.anything(),
    );
  });

  test('persists assistant voice turns with canonical response metadata', async () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };
    const voiceConfig = { plain_text: 'Hello from the voice agent.' };
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      getSession: vi.fn(() => undefined),
      rehydrateSession: vi.fn(async () => null),
      executeMessage: vi.fn(
        async (
          _sessionId: string,
          _userInput: string,
          _onChunk?: ((chunk: string) => void) | undefined,
          onTraceEvent?:
            | ((event: { type: string; data: Record<string, unknown> }) => void)
            | undefined,
        ) => {
          onTraceEvent?.({
            type: 'agent_enter',
            data: { agentName: 'supervisor' },
          });
          return {
            response: 'Hello from the voice agent.',
            action: { type: 'continue' },
            voiceConfig,
            responseMetadata,
          };
        },
      ),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-provenance',
        callSid: 'call-provenance',
        streamId: 'stream-provenance',
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
        voiceMode: 'pipeline',
      },
      executor,
    ) as any;

    session.dbSessionId = 'db-session-1';
    session.useStreaming = false;
    session.waitForTtsSynthEvent = vi.fn(async () => 0);

    await session.handleVerbHook({
      type: 'verb:hook',
      msgid: 'msg-provenance',
      call_sid: 'call-provenance',
      data: {
        speech: {
          alternatives: [{ transcript: 'Hello', confidence: 0.98 }],
          language_code: 'en-US',
        },
      },
    });

    expect(mockPersistMessage).toHaveBeenCalledWith(
      'db-session-1',
      'assistant',
      'Hello from the voice agent.',
      'voice',
      'tenant-1',
      undefined,
      undefined,
      'project-1',
      undefined,
      { voiceConfig },
      responseMetadata,
    );
  });

  test('records auth_required outcome traces and skips execution when voice auth preflight blocks', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const runtimeSession = {
      id: 'session-1',
      agentName: 'supervisor',
      compilationOutput: {},
      userId: 'user-1',
      versionInfo: { environment: 'prod' },
      conversationHistory: [],
      state: { gatherProgress: {}, context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      isComplete: false,
      isEscalated: false,
      handoffStack: [],
      threads: [],
      activeThreadIndex: 0,
      threadStack: [],
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    const executor = {
      getSession: vi.fn(() => runtimeSession),
      rehydrateSession: vi.fn(async () => runtimeSession),
      executeMessage: vi.fn(),
    } as any;

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

    const session = new KorevgSession(
      ws,
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
        sttVendor: 'deepgram',
        sttModel: 'nova-3',
        voiceMode: 'pipeline',
      },
      executor,
    ) as any;

    session.ttsStreamOpen = true;

    await session.handleVerbHook({
      type: 'verb:hook',
      msgid: 'msg-auth-1',
      call_sid: 'call-1',
      data: {
        speech: {
          alternatives: [{ transcript: 'Check my calendar', confidence: 0.93 }],
          language_code: 'en-US',
        },
      },
    });

    expect(executor.executeMessage).not.toHaveBeenCalled();
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          data: expect.objectContaining({
            code: 'AUTH_PREFLIGHT_REQUIRED',
            category: 'auth',
            source: 'channel_outcome',
          }),
        }),
      ]),
    );
    expect(ws.send).toHaveBeenCalled();
  });

  test('uses configured welcomeMessage instead of init response for pipeline greeting', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      initializeSession: vi.fn(async () => ({
        response: 'Hello from init result.',
      })),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
        voiceMode: 'pipeline',
        welcomeMessage: 'Hi, I am calling about order 4521847.',
      },
      executor,
    ) as any;

    session.createDBSession = vi.fn(async () => undefined);
    session.resolveStreamingMode = vi.fn(async () => undefined);

    await session.sendGreeting();

    expect(executor.initializeSession).toHaveBeenCalledTimes(1);
    expect(session.ttsBuffer).toEqual(['Hi, I am calling about order 4521847.']);
    expect(ws.send).toHaveBeenCalledTimes(1);

    const sentCommand = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentCommand).toMatchObject({
      type: 'command',
      command: 'redirect',
    });
    expect(sentCommand.data).toHaveLength(1);
  });

  test('suppresses greeting when welcomeMessage is empty', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      initializeSession: vi.fn(async () => ({
        response: 'Hello from init result.',
      })),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
        voiceMode: 'pipeline',
        welcomeMessage: '',
      },
      executor,
    ) as any;

    session.createDBSession = vi.fn(async () => undefined);
    session.resolveStreamingMode = vi.fn(async () => undefined);

    await session.sendGreeting();

    expect(executor.initializeSession).toHaveBeenCalledTimes(1);
    expect(session.ttsBuffer).toEqual([]);
    expect(ws.send).toHaveBeenCalledTimes(1);

    const sentCommand = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sentCommand).toMatchObject({
      type: 'command',
      command: 'redirect',
    });
    expect(sentCommand.data).toHaveLength(1);
  });

  test('emits voice_session_start once when session:new arrives after bootstrap', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      initializeSession: vi.fn(async () => ({
        response: 'Hello from init result.',
      })),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-from-config',
        streamId: 'stream-1',
        voiceMode: 'pipeline',
        caller: '+15550009999',
        called: '+15550008888',
        ttsVendor: 'elevenlabs',
        ttsVoice: 'voice-1',
        sttVendor: 'deepgram',
      },
      executor,
    ) as any;

    session.createDBSession = vi.fn(async () => undefined);
    session.resolveStreamingMode = vi.fn(async () => undefined);

    await session.handleSessionNew({
      type: 'session:new',
      msgid: 'session-new-1',
      call_sid: 'call-from-session-new',
      data: {
        call_sid: 'call-from-data',
        from: '+15550001111',
        to: '+15550002222',
        call_id: 'sip-call-id-1',
        sbc_callid: 'sbc-call-id-1',
        direction: 'outbound',
        trace_id: 'trace-1',
        account_sid: 'account-1',
        application_sid: 'application-1',
        defaults: {
          synthesizer: { vendor: 'elevenlabs', voice: 'voice-1' },
          recognizer: { vendor: 'deepgram', language: 'en-US' },
        },
      },
    });

    await session.sendGreeting();

    const voiceSessionStartEvents = traceEvents.filter(
      (event) => event.type === 'voice_session_start',
    );
    expect(voiceSessionStartEvents).toHaveLength(1);
    expect(voiceSessionStartEvents[0]?.data).toMatchObject({
      callSid: 'call-from-session-new',
      caller: '[REDACTED_PHONE]',
      called: '[REDACTED_PHONE]',
      callId: 'sip-call-id-1',
      sbcCallId: 'sbc-call-id-1',
      direction: 'outbound',
      traceId: 'trace-1',
      accountSid: 'account-1',
      applicationSid: 'application-1',
      ttsVendor: 'elevenlabs',
      ttsVoice: 'voice-1',
      sttVendor: 'deepgram',
      channel: 'voice',
    });
  });

  test('ignores llm:event messages in pipeline sessions with a single warning', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const session = new KorevgSession(
      ws,
      {
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
        voiceMode: 'pipeline',
      },
      undefined,
    ) as any;

    await session.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: 'llm:event',
          msgid: 'msg-llm-1',
          call_sid: 'call-1',
          data: { type: 'response.output_text.delta', text: 'hello' },
        }),
      ),
    );

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Received llm:event in KorevgSession (should use S2SSessionBridge instead)',
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('fails closed when a KoreVG session:new metadata merge would overflow post-merge session metadata', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    } as any;

    const runtimeSession = {
      data: {
        values: {
          _metadata: { ...NEAR_LIMIT_SESSION_METADATA },
        },
      },
    };

    const executor = {
      getSession: vi.fn(() => runtimeSession),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'supervisor',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
        voiceMode: 'realtime',
        sessionMetadata: { ...NEAR_LIMIT_SESSION_METADATA },
      },
      executor,
    ) as any;

    session.createDBSession = vi.fn(async () => undefined);

    await session.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: 'session:new',
          msgid: 'msg-metadata-overflow',
          call_sid: 'call-1',
          data: {
            sessionMetadata: FOLLOW_UP_SESSION_METADATA,
          },
        }),
      ),
    );

    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid session metadata');
    expect(session.config.sessionMetadata).toEqual(NEAR_LIMIT_SESSION_METADATA);
    expect(runtimeSession.data.values._metadata).toEqual(NEAR_LIMIT_SESSION_METADATA);
  });
});
