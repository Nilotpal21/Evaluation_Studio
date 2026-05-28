import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveChannelConnection: vi.fn(),
  resolveSession: vi.fn(),
  executeMessage: vi.fn(),
  getSession: vi.fn(),
  rehydrateSession: vi.fn(),
  acquireSessionLock: vi.fn(),
  releaseSessionLock: vi.fn(),
  evaluateAuthPreflightFromIR: vi.fn(),
  createTokenLookups: vi.fn(() => ({})),
  emitChannelResponseSent: vi.fn(),
  recordSyntheticTraceEvent: vi.fn(),
  sendActivities: vi.fn(() => true),
  removeConnection: vi.fn(),
  handleDisconnect: vi.fn(),
  channelSessionFindOne: vi.fn(),
  channelSessionUpdateOne: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../channels/connection-resolver.js', () => ({
  resolveChannelConnection: mocks.resolveChannelConnection,
}));

vi.mock('../../channels/session-resolver.js', () => ({
  resolveSession: mocks.resolveSession,
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    executeMessage: mocks.executeMessage,
    getSession: mocks.getSession,
    rehydrateSession: mocks.rehydrateSession,
  })),
}));

vi.mock('../../services/queues/session-lock.js', () => ({
  acquireSessionLock: mocks.acquireSessionLock,
  releaseSessionLock: mocks.releaseSessionLock,
}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: mocks.evaluateAuthPreflightFromIR,
  createTokenLookups: mocks.createTokenLookups,
}));

vi.mock('../../channels/audiocodes/ws-manager.js', () => ({
  sendActivities: mocks.sendActivities,
  removeConnection: mocks.removeConnection,
}));

vi.mock('../../channels/pipeline/lifecycle-manager.js', () => ({
  handleDisconnect: mocks.handleDisconnect,
}));

vi.mock('@agent-platform/database/models', () => ({
  ChannelSession: {
    findOne: mocks.channelSessionFindOne,
    updateOne: mocks.channelSessionUpdateOne,
  },
}));

vi.mock('../../services/channel-trace-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/channel-trace-utils.js')>();
  return {
    ...actual,
    emitChannelResponseSent: mocks.emitChannelResponseSent,
    recordSyntheticTraceEvent: mocks.recordSyntheticTraceEvent,
  };
});

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
    send(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function findRouteHandlers(router: any, method: string, path: string) {
  for (const layer of router.stack || []) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((stackLayer: any) => stackLayer.handle);
    }
  }
  return null;
}

async function callHandlers(handlers: any[], req: any, res: any) {
  for (const handler of handlers) {
    await new Promise<void>((resolve, reject) => {
      const next = (err?: any) => (err ? reject(err) : resolve());
      const result = handler(req, res, next);
      if (result?.then) result.then(resolve).catch(reject);
    });
  }
}

describe('AudioCodes ingress auth + trace parity', () => {
  let activityHandlers: any[];
  let disconnectHandlers: any[];

  beforeAll(async () => {
    const module = await import('../../routes/channel-audiocodes.js');
    activityHandlers = findRouteHandlers(
      module.default,
      'post',
      '/webhook/:identifier/conversation/:conversationId/activities',
    )!;
    disconnectHandlers = findRouteHandlers(
      module.default,
      'post',
      '/webhook/:identifier/conversation/:conversationId/disconnect',
    )!;
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveChannelConnection.mockResolvedValue({
      id: 'conn-audio-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'audiocodes',
      externalIdentifier: 'audio-stream-1',
      environment: 'prod',
      credentials: {
        inboundAuthToken: 'audiocodes-secret',
      },
      config: {},
      status: 'active',
    });
    mocks.resolveSession.mockResolvedValue({
      sessionId: 'runtime-audio-1',
      isNew: false,
    });
    mocks.getSession.mockReturnValue(undefined);
    mocks.rehydrateSession.mockResolvedValue({
      id: 'runtime-audio-1',
      agentName: 'voice-agent',
      userId: 'user-1',
      compilationOutput: {},
      versionInfo: { environment: 'prod' },
      tracer: undefined,
    });
    mocks.executeMessage.mockResolvedValue({ response: 'Hello from runtime' });
    mocks.acquireSessionLock.mockResolvedValue(true);
    mocks.releaseSessionLock.mockResolvedValue(undefined);
    mocks.evaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [
        {
          connector: 'google',
          authProfileRef: 'google-creds',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });
    mocks.sendActivities.mockReturnValue(true);
    mocks.handleDisconnect.mockResolvedValue(undefined);
    mocks.channelSessionFindOne.mockResolvedValue({ sessionId: 'runtime-audio-1' });
    mocks.channelSessionUpdateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits synthetic trace + response bookkeeping for AudioCodes auth-preflight responses', async () => {
    expect(activityHandlers).toBeTruthy();

    const req: any = {
      params: { identifier: 'audio-stream-1', conversationId: 'conv-1' },
      body: {
        conversation: 'conv-1',
        activities: [
          {
            type: 'message',
            text: 'Hi there',
          },
        ],
      },
      query: {
        token: 'audiocodes-secret',
      },
      headers: {
        host: 'voice.example.com',
      },
    };
    const res = createMockRes();

    await callHandlers(activityHandlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ activities: [] });
    expect(mocks.recordSyntheticTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'runtime-audio-1',
      }),
    );
    expect(mocks.sendActivities).toHaveBeenCalledWith(
      'conv-1',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          text: expect.stringContaining('required authorization'),
        }),
      ]),
    );
    expect(mocks.emitChannelResponseSent).toHaveBeenCalledWith(
      'runtime-audio-1',
      'audiocodes',
      expect.any(Number),
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
      }),
    );
    expect(mocks.executeMessage).not.toHaveBeenCalled();
  });

  it('uses the plain_text voice override for AudioCodes outbound speech activities', async () => {
    expect(activityHandlers).toBeTruthy();

    mocks.evaluateAuthPreflightFromIR.mockResolvedValue(null);
    mocks.rehydrateSession.mockResolvedValue(undefined);
    mocks.executeMessage.mockResolvedValue({
      response: 'Hello **bold**',
      voiceConfig: { plain_text: 'Hello bold' },
    });

    const req: any = {
      params: { identifier: 'audio-stream-1', conversationId: 'conv-1' },
      body: {
        conversation: 'conv-1',
        activities: [
          {
            type: 'message',
            text: 'Hi there',
          },
        ],
      },
      query: {
        token: 'audiocodes-secret',
      },
      headers: {
        host: 'voice.example.com',
      },
    };
    const res = createMockRes();

    await callHandlers(activityHandlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ activities: [] });
    expect(mocks.sendActivities).toHaveBeenCalledWith(
      'conv-1',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          text: 'Hello bold',
        }),
      ]),
    );
  });

  it('routes disconnect cleanup through the shared lifecycle manager', async () => {
    expect(disconnectHandlers).toBeTruthy();

    const req: any = {
      params: { identifier: 'audio-stream-1', conversationId: 'conv-1' },
      body: {
        reason: 'hangup',
        reasonCode: 'NORMAL_CLEARING',
      },
      query: {
        token: 'audiocodes-secret',
      },
      headers: {
        host: 'voice.example.com',
      },
    };
    const res = createMockRes();

    await callHandlers(disconnectHandlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.removeConnection).toHaveBeenCalledWith('conv-1');
    expect(mocks.channelSessionFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      channelConnectionId: 'conn-audio-1',
      externalSessionKey: 'audiocodes:conv-1',
      status: 'active',
    });
    expect(mocks.handleDisconnect).toHaveBeenCalledWith({
      channel: 'voice',
      sessionId: 'runtime-audio-1',
      dbSessionId: 'runtime-audio-1',
      tenantId: 'tenant-1',
    });
    expect(mocks.channelSessionUpdateOne).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        channelConnectionId: 'conn-audio-1',
        externalSessionKey: 'audiocodes:conv-1',
        status: 'active',
      },
      { $set: { status: 'ended' } },
    );
  });
});
