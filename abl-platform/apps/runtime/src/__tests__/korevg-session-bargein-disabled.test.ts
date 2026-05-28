import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockLogger, traceEvents, mockPersistMessage } = vi.hoisted(() => {
  const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockPersistMessage = vi.fn(async () => undefined);

  return {
    mockLogger,
    traceEvents,
    mockPersistMessage,
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

vi.mock('../services/message-persistence-queue.js', () => ({
  persistMessage: (...args: unknown[]) => mockPersistMessage(...args),
  persistMessageRecord: vi.fn(async () => undefined),
  persistTurnMetrics: vi.fn(async () => undefined),
}));

vi.mock('../runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => null),
}));

vi.mock('../services/agent-transfer/index.js', () => ({
  getTransferSessionStore: vi.fn(() => ({
    get: vi.fn(),
  })),
  getTransferTraceEmitter: vi.fn(() => null),
}));

vi.mock('../services/agent-transfer/transcript-persistence.js', () => ({
  getAgentTransferTranscriptPersistenceService: vi.fn(() => ({
    persistForwardedUserMessage: vi.fn(),
    persistObservedAgentTranscript: vi.fn(),
  })),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

import {
  KorevgSession,
  type KorevgSessionConfig,
} from '../services/voice/korevg/korevg-session.js';

function createWs() {
  return {
    on: vi.fn(),
    send: vi.fn(),
    readyState: 1,
  } as any;
}

function createExecutor(greeting = 'Hello from runtime') {
  return {
    initializeSession: vi.fn(async () => ({ response: greeting })),
    getSession: vi.fn(() => undefined),
  } as any;
}

function createSession(overrides: Partial<KorevgSessionConfig> = {}, executor = createExecutor()) {
  const ws = createWs();
  const session = new KorevgSession(
    ws,
    {
      projectId: 'project-1',
      agentId: 'VisaAgent',
      deploymentId: 'deployment-1',
      sessionId: 'session-1',
      callSid: 'call-1',
      streamId: 'stream-1',
      voiceMode: 'pipeline',
      ...overrides,
    },
    executor,
  ) as any;

  session.dbSessionId = 'db-session-1';

  return { session, ws, executor };
}

function parseSend(ws: ReturnType<typeof createWs>, index: number) {
  const raw = ws.send.mock.calls[index]?.[0];
  expect(raw).toBeTypeOf('string');
  return JSON.parse(raw);
}

function parseLastCommand(ws: ReturnType<typeof createWs>) {
  const raw = ws.send.mock.calls.at(-1)?.[0];
  expect(raw).toBeTypeOf('string');
  return JSON.parse(raw);
}

async function startSession(session: any) {
  await session.handleSessionNew({
    type: 'session:new',
    msgid: 'msg-1',
    call_sid: 'call-1',
    data: {
      from: '+15550001111',
      to: '+15550002222',
    },
  });
}

describe('KorevgSession barge-in disabled startup', () => {
  beforeEach(() => {
    traceEvents.length = 0;
    vi.clearAllMocks();
  });

  test('sends greeting followed by an explicit post-prompt gather when barge-in is disabled', async () => {
    const { session, ws, executor } = createSession({ bargeIn: false });

    await startSession(session);

    expect(executor.initializeSession).toHaveBeenCalledOnce();
    expect(session.useStreaming).toBe(false);

    const answerAck = parseSend(ws, 0);
    expect(answerAck).toEqual({
      type: 'ack',
      msgid: 'msg-1',
      data: [{ verb: 'answer' }],
    });

    const command = parseLastCommand(ws);
    expect(command).toMatchObject({
      type: 'command',
      command: 'redirect',
    });
    expect(command.data).toEqual([
      expect.objectContaining({
        verb: 'say',
        text: 'Hello from runtime',
      }),
      expect.objectContaining({
        verb: 'gather',
        actionHook: '/ws/korevg/stream-1',
        timeout: 0,
        bargein: false,
        listenDuringPrompt: false,
      }),
    ]);
    expect(command.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verb: 'config',
          bargeIn: expect.objectContaining({ enable: false }),
        }),
      ]),
    );
  });

  test('keeps the normal streaming config before buffering the greeting when barge-in is enabled', async () => {
    const { session, ws, executor } = createSession();

    await startSession(session);

    expect(executor.initializeSession).toHaveBeenCalledOnce();
    expect(session.useStreaming).toBe(true);

    const ack = parseSend(ws, 0);
    expect(ack).toMatchObject({
      type: 'ack',
      msgid: 'msg-1',
      data: [{ verb: 'answer' }],
    });

    const command = parseLastCommand(ws);
    expect(command).toMatchObject({
      type: 'command',
      command: 'redirect',
    });
    expect(command.data).toEqual([
      expect.objectContaining({
        verb: 'config',
        bargeIn: expect.objectContaining({
          enable: true,
          sticky: true,
          actionHook: '/ws/korevg/stream-1',
        }),
        ttsStream: expect.objectContaining({
          enable: true,
        }),
      }),
    ]);
    expect(command.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verb: 'say',
        }),
      ]),
    );
    expect(session.ttsBuffer).toEqual(['Hello from runtime']);
  });

  test('clears streaming TTS and drops stale chunks when speech barge-in is detected', () => {
    const { session, ws } = createSession();

    session.handleVerbStatus({
      type: 'verb:status',
      msgid: 'status-1',
      call_sid: 'call-1',
      data: { event: 'speech-bargein-detected' },
    });

    expect(session.dropStreamingTokensUntilNextTurn).toBe(true);
    const command = parseLastCommand(ws);
    expect(command).toMatchObject({
      type: 'command',
      command: 'tts:clear',
      queueCommand: false,
    });
  });

  test('restores listening after mid-call playback without reintroducing disabled sticky barge-in', () => {
    const { session, ws } = createSession({ bargeIn: false });

    session.playMessage('Please hold while I check that.');

    const command = parseLastCommand(ws);
    expect(command).toMatchObject({
      type: 'command',
      command: 'redirect',
    });
    expect(command.data).toEqual([
      expect.objectContaining({
        verb: 'say',
        text: 'Please hold while I check that.',
      }),
      expect.objectContaining({
        verb: 'gather',
        actionHook: '/ws/korevg/stream-1',
        timeout: 0,
        bargein: false,
        listenDuringPrompt: false,
      }),
    ]);
    expect(command.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verb: 'config',
          bargeIn: expect.objectContaining({ enable: false }),
        }),
      ]),
    );
  });

  test('can wait for non-streaming filler playback before continuing the turn', async () => {
    const { session, ws } = createSession({ bargeIn: false });
    let resolved = false;

    const delivered = session
      .sendAgentMessage('Please stay connected while I review the information.', {
        waitForPlayback: true,
      })
      .then(() => {
        resolved = true;
      });

    await Promise.resolve();

    const command = parseLastCommand(ws);
    expect(command.data).toEqual([
      expect.objectContaining({
        verb: 'say',
        text: 'Please stay connected while I review the information.',
      }),
      expect.objectContaining({
        verb: 'gather',
        actionHook: '/ws/korevg/stream-1',
        bargein: false,
        listenDuringPrompt: false,
      }),
    ]);
    expect(resolved).toBe(false);

    session.handleVerbStatus({
      type: 'verb:status',
      msgid: 'status-1',
      call_sid: 'call-1',
      data: { event: 'stop-playback' },
    });

    await delivered;
    expect(resolved).toBe(true);
  });

  test('syncs late runtime conversation behavior into the session config used by speech helpers', () => {
    const { session, ws } = createSession();

    session.applyConversationBehaviorVoiceRuntimeConfig({
      _effectiveConfig: {
        conversationBehavior: {
          listening: {
            barge_in: 'disabled',
          },
        },
      },
    });
    session.playMessage('I found one option.');

    const command = parseLastCommand(ws);
    expect(session.config.bargeIn).toBe(false);
    expect(command.data).toEqual([
      expect.objectContaining({
        verb: 'say',
        text: 'I found one option.',
      }),
      expect.objectContaining({
        verb: 'gather',
        actionHook: '/ws/korevg/stream-1',
        timeout: 0,
        bargein: false,
        listenDuringPrompt: false,
      }),
    ]);
  });
});
