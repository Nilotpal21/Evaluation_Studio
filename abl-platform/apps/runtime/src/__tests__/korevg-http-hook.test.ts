import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockLogger, mockTransferStore, mockTranscriptPersistenceService, traceEvents } = vi.hoisted(
  () => {
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const mockTransferStore = {
      get: vi.fn(),
    };
    const mockTranscriptPersistenceService = {
      persistForwardedUserMessage: vi.fn(),
      persistObservedAgentTranscript: vi.fn(),
    };

    return {
      mockLogger,
      mockTransferStore,
      mockTranscriptPersistenceService,
      traceEvents,
    };
  },
);

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

vi.mock('../services/agent-transfer/index.js', () => ({
  getTransferSessionStore: vi.fn(() => mockTransferStore),
  getTransferTraceEmitter: vi.fn(() => null),
}));

vi.mock('../services/agent-transfer/transcript-persistence.js', () => ({
  getAgentTransferTranscriptPersistenceService: vi.fn(() => mockTranscriptPersistenceService),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import { KorevgSession } from '../services/voice/korevg/korevg-session.js';

describe('KorevgSession HTTP actionHook compatibility', () => {
  const runtimeBaseUrl = process.env.RUNTIME_PUBLIC_BASE_URL;

  beforeEach(() => {
    traceEvents.length = 0;
    vi.clearAllMocks();
    process.env.RUNTIME_PUBLIC_BASE_URL = 'https://runtime.example.com';
  });

  afterEach(() => {
    if (runtimeBaseUrl === undefined) {
      delete process.env.RUNTIME_PUBLIC_BASE_URL;
    } else {
      process.env.RUNTIME_PUBLIC_BASE_URL = runtimeBaseUrl;
    }
  });

  test('returns HTTP verbs for dial actionHook payloads without writing to websocket', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const session = new KorevgSession(ws, {
      projectId: 'project-1',
      agentId: 'VisaAgent',
      deploymentId: 'deployment-1',
      sessionId: 'session-1',
      callSid: 'call-1',
      streamId: 'stream-1',
      voiceMode: 'pipeline',
    }) as any;

    const verbs = await session.handleHttpHook(
      {
        dial_call_status: 'completed',
        dial_sip_status: 200,
      },
      'agent-dial-status',
    );

    expect(verbs).toEqual([
      expect.objectContaining({
        verb: 'say',
        text: 'Please hold for a moment.',
      }),
    ]);
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('persists bridged user transcript received via call-transcriptions hook without writing to websocket', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const session = new KorevgSession(ws, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: 'VisaAgent',
      deploymentId: 'deployment-1',
      sessionId: 'session-1',
      callSid: 'call-1',
      streamId: 'stream-1',
      voiceMode: 'pipeline',
    }) as any;

    mockTransferStore.get.mockResolvedValue({
      ownerId: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'voice',
      provider: 'smartassist',
      providerSessionId: 'provider-1',
      state: 'transferred',
      metadata: { conversationSessionId: 'session-1' },
      providerData: {
        syntheticUserId: 'synthetic-user-1',
      },
      routing: {
        conversationSessionId: 'session-1',
        sourceChannelType: 'korevg',
      },
      contactId: 'contact-1',
    });

    const verbs = await session.handleHttpHook(
      {
        memberUserId: 'synthetic-user-1',
        speech: {
          channel_tag: 1,
          alternatives: [{ transcript: 'I need help with my appointment', confidence: 0.99 }],
        },
      },
      'call-transcriptions',
    );

    expect(verbs).toEqual([]);
    expect(mockTranscriptPersistenceService.persistForwardedUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        transferSessionId: 'agent_transfer:tenant-1:session-1:voice',
        content: 'I need help with my appointment',
      }),
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('persists bridged human-agent transcript received via call-transcriptions hook', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const session = new KorevgSession(ws, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: 'VisaAgent',
      deploymentId: 'deployment-1',
      sessionId: 'session-1',
      callSid: 'call-1',
      streamId: 'stream-1',
      voiceMode: 'pipeline',
    }) as any;

    mockTransferStore.get.mockResolvedValue({
      ownerId: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'voice',
      provider: 'smartassist',
      providerSessionId: 'provider-1',
      state: 'active',
      metadata: { conversationSessionId: 'session-1' },
      providerData: {
        syntheticUserId: 'synthetic-user-1',
      },
      routing: {
        conversationSessionId: 'session-1',
        sourceChannelType: 'korevg',
      },
      contactId: 'contact-1',
    });

    const verbs = await session.handleHttpHook(
      {
        memberUserId: 'agent-user-1',
        memberId: 'agent-member-1',
        speech: {
          channel_tag: 2,
          alternatives: [{ transcript: 'I am connected now and can help you', confidence: 0.95 }],
        },
      },
      'call-transcriptions',
    );

    expect(verbs).toEqual([]);
    expect(mockTranscriptPersistenceService.persistObservedAgentTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        transferSessionId: 'agent_transfer:tenant-1:session-1:voice',
        content: 'I am connected now and can help you',
        agentInfo: {
          memberId: 'agent-member-1',
          memberUserId: 'agent-user-1',
        },
      }),
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('suppresses duplicate bridged transcripts that arrive back-to-back for the same utterance', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const session = new KorevgSession(ws, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: 'VisaAgent',
      deploymentId: 'deployment-1',
      sessionId: 'session-1',
      callSid: 'call-1',
      streamId: 'stream-1',
      voiceMode: 'pipeline',
    }) as any;

    mockTransferStore.get.mockResolvedValue({
      ownerId: 'session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'voice',
      provider: 'smartassist',
      providerSessionId: 'provider-1',
      state: 'active',
      metadata: { conversationSessionId: 'session-1' },
      providerData: {
        syntheticUserId: 'synthetic-user-1',
      },
      routing: {
        conversationSessionId: 'session-1',
        sourceChannelType: 'korevg',
      },
      contactId: 'contact-1',
    });

    await session.handleHttpHook(
      {
        speech: {
          channel_tag: 1,
          alternatives: [{ transcript: 'next monday', confidence: 0.99 }],
        },
      },
      'call-transcriptions',
    );

    await session.handleHttpHook(
      {
        speech: {
          channel_tag: 2,
          alternatives: [{ transcript: 'next monday', confidence: 0.99 }],
        },
      },
      'call-transcriptions',
    );

    expect(mockTranscriptPersistenceService.persistForwardedUserMessage).toHaveBeenCalledTimes(1);
    expect(mockTranscriptPersistenceService.persistObservedAgentTranscript).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  test('keeps transfer-phase streaming config on the websocket hook when escalation begins', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const executor = {
      executeMessage: vi.fn(async () => ({
        response: "I'll transfer you to a live agent who can better assist you. Please hold.",
        action: {
          type: 'escalate',
          reason: 'User requested a live agent.',
          priority: 'high',
        },
      })),
      getSession: vi.fn(() => undefined),
      rehydrateSession: vi.fn(async () => undefined),
    } as any;

    const session = new KorevgSession(
      ws,
      {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'VisaAgent',
        deploymentId: 'deployment-1',
        sessionId: 'session-1',
        callSid: 'call-1',
        streamId: 'stream-1',
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
          alternatives: [{ transcript: 'Connect me to a live agent', confidence: 0.97 }],
          language_code: 'en-US',
        },
      },
    });

    const commandMessages = ws.send.mock.calls
      .map((call: any[]) => JSON.parse(call[0]))
      .filter((payload: { type?: string; command?: string }) => payload.command === 'redirect');
    const redirectPayload = commandMessages.at(-1);

    expect(redirectPayload).toBeTruthy();
    expect(redirectPayload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verb: 'config',
          bargeIn: expect.objectContaining({
            actionHook: '/ws/korevg/stream-1',
          }),
        }),
      ]),
    );
  });

  test('keeps dial actionHook on the stable status route and adds a bridged transcription hook', async () => {
    const ws = {
      on: vi.fn(),
      send: vi.fn(),
      readyState: 1,
    } as any;

    const session = new KorevgSession(ws, {
      projectId: 'project-1',
      agentId: 'VisaAgent',
      deploymentId: 'deployment-1',
      sessionId: 'session-1',
      callSid: 'call-1',
      streamId: 'stream-1',
      voiceMode: 'pipeline',
      caller: '+15555550123',
    }) as any;

    await session.dialAgent('sip:support@example.com:5060');

    expect(ws.send).toHaveBeenCalledOnce();
    const payload = JSON.parse(ws.send.mock.calls[0][0]);
    expect(payload.data[1]).toMatchObject({
      verb: 'dial',
      actionHook: '/agent-dial-status',
      transcribe: {
        transcriptionHook:
          'https://runtime.example.com/api/v1/voice/korevg/hook/session-1/call-transcriptions',
        recognizer: expect.objectContaining({
          dualChannel: true,
          separateRecognitionPerChannel: true,
          diarization: true,
          diarizationMinSpeakers: 1,
          diarizationMaxSpeakers: 2,
        }),
      },
    });
  });
});
