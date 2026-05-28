import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const traceEvents: Array<{
    id?: string;
    sessionId: string;
    type: string;
    data: Record<string, unknown>;
  }> = [];
  const emittedChannelEvents: Array<Record<string, unknown>> = [];
  const mockTraceAddEvent = vi.fn(
    (
      sessionId: string,
      event: {
        id?: string;
        type: string;
        data: Record<string, unknown>;
      },
    ) => {
      traceEvents.push({ sessionId, ...event });
    },
  );
  const mockChannelEventEmit = vi.fn((event: Record<string, unknown>) => {
    emittedChannelEvents.push(event);
  });

  return {
    resolveChannelConnection: vi.fn(),
    resolveSession: vi.fn(),
    executeMessage: vi.fn(),
    getSession: vi.fn(),
    rehydrateSession: vi.fn(),
    acquireSessionLock: vi.fn(),
    releaseSessionLock: vi.fn(),
    evaluateAuthPreflightFromIR: vi.fn(),
    createTokenLookups: vi.fn(() => ({})),
    handleDisconnect: vi.fn(),
    channelSessionFindOne: vi.fn(),
    traceEvents,
    emittedChannelEvents,
    mockTraceAddEvent,
    mockChannelEventEmit,
  };
});

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

vi.mock('../../channels/pipeline/lifecycle-manager.js', () => ({
  handleDisconnect: mocks.handleDisconnect,
}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: mocks.evaluateAuthPreflightFromIR,
  createTokenLookups: mocks.createTokenLookups,
}));

vi.mock('@agent-platform/database/models', () => ({
  ChannelSession: {
    findOne: mocks.channelSessionFindOne,
  },
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    addEvent: mocks.mockTraceAddEvent,
    getEvents: vi.fn(() => mocks.traceEvents),
    setSessionAgent: vi.fn(),
    removeSession: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../services/eventstore-singleton.js', () => ({
  getEventStore: vi.fn(() => ({
    emitter: {
      emit: mocks.mockChannelEventEmit,
    },
  })),
}));

vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: vi.fn(() => undefined),
}));

vi.mock('@agent-platform/shared-observability/sti', () => ({
  getSharedSTRBuffer: vi.fn(() => ({
    flush: vi.fn(() => []),
    reportFlushSuccess: vi.fn(),
    reportFlushFailure: vi.fn(),
  })),
}));

vi.mock('../../services/tracing/str-writer-singleton.js', () => ({
  getSTRWriter: vi.fn(() => null),
}));

function createMockRes() {
  const res: any = {
    statusCode: 200,
    typeValue: null as string | null,
    body: null as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(v: string) {
      res.typeValue = v;
      return res;
    },
    send(payload: any) {
      res.body = payload;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function findRouteHandlers(router: any, method: string, path: string) {
  for (const layer of router.stack || []) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((s: any) => s.handle);
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
    if (res.body !== null) break;
  }
}

describe('voice ingress auth hardening', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVxmlSecret = process.env.VXML_SHARED_SECRET;
  const originalRuntimeBase = process.env.RUNTIME_PUBLIC_BASE_URL;

  // Pre-import the module in beforeAll so the dynamic import doesn't time out
  // inside individual tests when many forked processes compete for resources.
  let vxmlHandlers: any[];
  let genesysHandlers: any[];
  beforeAll(async () => {
    const vxmlModule = await import('../../routes/channel-vxml.js');
    const genesysModule = await import('../../routes/channel-genesys.js');
    vxmlHandlers = findRouteHandlers(vxmlModule.default, 'post', '/hooks/:streamId')!;
    genesysHandlers = findRouteHandlers(genesysModule.default, 'post', '/hooks/:streamId')!;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'production';
    process.env.VXML_SHARED_SECRET = '';
    process.env.RUNTIME_PUBLIC_BASE_URL = '';
    mocks.traceEvents.length = 0;
    mocks.emittedChannelEvents.length = 0;

    mocks.resolveChannelConnection.mockResolvedValue({
      id: 'conn-vxml-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'voice_vxml',
      externalIdentifier: 'stream-1',
      credentials: null,
      config: {
        inboundAuthToken: 'vxml-secret',
        publicBaseUrl: 'https://voice.example.com',
      },
      status: 'active',
    });
    mocks.resolveSession.mockResolvedValue({
      sessionId: 'runtime-vxml-1',
      isNew: false,
    });
    mocks.getSession.mockReturnValue(undefined);
    mocks.rehydrateSession.mockResolvedValue(undefined);
    mocks.executeMessage.mockResolvedValue({ response: 'Hello from agent' });
    mocks.acquireSessionLock.mockResolvedValue(true);
    mocks.releaseSessionLock.mockResolvedValue(undefined);
    mocks.evaluateAuthPreflightFromIR.mockResolvedValue(null);
    mocks.handleDisconnect.mockResolvedValue(undefined);
    mocks.channelSessionFindOne.mockResolvedValue({ sessionId: 'runtime-vxml-1' });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.VXML_SHARED_SECRET = originalVxmlSecret;
    process.env.RUNTIME_PUBLIC_BASE_URL = originalRuntimeBase;
  });

  it('rejects VXML webhook requests with missing/invalid token in production', async () => {
    expect(vxmlHandlers).toBeTruthy();

    const req: any = {
      params: { streamId: 'stream-1' },
      body: { callId: 'call-1', message: 'Hi' },
      query: {},
      headers: { host: 'attacker.example' },
      protocol: 'https',
      get: vi.fn((header: string) => (header === 'host' ? 'attacker.example' : undefined)),
    };
    const res = createMockRes();

    await callHandlers(vxmlHandlers, req, res);

    expect(res.statusCode).toBe(401);
    expect(String(res.body)).toContain('Unauthorized request');
    expect(mocks.resolveSession).not.toHaveBeenCalled();
  });

  it('uses configured/public base URL for next-turn VXML webhook instead of request host', async () => {
    expect(vxmlHandlers).toBeTruthy();

    const req: any = {
      params: { streamId: 'stream-1' },
      body: { callId: 'call-1', message: 'Hi' },
      query: {},
      headers: {
        host: 'attacker.example',
        'x-channel-secret': 'vxml-secret',
      },
      protocol: 'https',
      get: vi.fn((header: string) => (header === 'host' ? 'attacker.example' : undefined)),
    };
    const res = createMockRes();

    await callHandlers(vxmlHandlers, req, res);

    expect(res.statusCode).toBe(200);
    const responseXml = String(res.body);
    expect(responseXml).toContain(
      'https://voice.example.com/api/v1/channels/vxml/hooks/stream-1?token=vxml-secret',
    );
    expect(responseXml).not.toContain('attacker.example');
  });

  it('renders VXML using the plain_text voice override when available', async () => {
    expect(vxmlHandlers).toBeTruthy();

    mocks.evaluateAuthPreflightFromIR.mockResolvedValue(null);
    mocks.executeMessage.mockResolvedValue({
      response: 'Hello **bold**',
      voiceConfig: { plain_text: 'Hello bold' },
    });

    const req: any = {
      params: { streamId: 'stream-1' },
      body: { callId: 'call-1', message: 'Hi' },
      query: {},
      headers: {
        host: 'voice.example.com',
        'x-channel-secret': 'vxml-secret',
      },
      protocol: 'https',
      get: vi.fn((header: string) => (header === 'host' ? 'voice.example.com' : undefined)),
    };
    const res = createMockRes();

    await callHandlers(vxmlHandlers, req, res);

    expect(res.statusCode).toBe(200);
    const responseXml = String(res.body);
    expect(responseXml).toContain('<prompt>Hello bold</prompt>');
    expect(responseXml).not.toContain('**bold**');
  });

  it('records an auth_required trace event and channel response event for VXML preflight responses', async () => {
    expect(vxmlHandlers).toBeTruthy();

    mocks.rehydrateSession.mockResolvedValue({
      id: 'runtime-vxml-1',
      agentName: 'voice-agent',
      compilationOutput: {},
      versionInfo: { environment: 'prod' },
      tracer: undefined,
    });
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

    const req: any = {
      params: { streamId: 'stream-1' },
      body: { callId: 'call-1', message: 'Hi' },
      query: {},
      headers: {
        host: 'attacker.example',
        'x-channel-secret': 'vxml-secret',
      },
      protocol: 'https',
      get: vi.fn((header: string) => (header === 'host' ? 'attacker.example' : undefined)),
    };
    const res = createMockRes();

    await callHandlers(vxmlHandlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain(
      'https://voice.example.com/api/v1/channels/vxml/hooks/stream-1?token=vxml-secret',
    );
    expect(mocks.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'runtime-vxml-1',
          type: 'error',
          data: expect.objectContaining({
            code: 'AUTH_PREFLIGHT_REQUIRED',
            category: 'auth',
            source: 'channel_outcome',
          }),
        }),
      ]),
    );
    expect(mocks.emittedChannelEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'channel.response.sent',
          category: 'channel',
          session_id: 'runtime-vxml-1',
          tenant_id: 'tenant-1',
          project_id: 'project-1',
          data: expect.objectContaining({
            channel: 'vxml',
          }),
        }),
      ]),
    );
    expect(mocks.executeMessage).not.toHaveBeenCalled();
  });

  it('routes VXML lifecycle callbacks through shared disconnect cleanup without creating a new turn', async () => {
    expect(vxmlHandlers).toBeTruthy();

    const req: any = {
      params: { streamId: 'stream-1' },
      body: {
        callId: 'call-1',
        _event: 'telephone.disconnect.hangup',
      },
      query: {},
      headers: {
        host: 'voice.example.com',
        'x-channel-secret': 'vxml-secret',
      },
      protocol: 'https',
      get: vi.fn((header: string) => (header === 'host' ? 'voice.example.com' : undefined)),
    };
    const res = createMockRes();

    await callHandlers(vxmlHandlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain('<disconnect/>');
    expect(mocks.resolveSession).not.toHaveBeenCalled();
    expect(mocks.executeMessage).not.toHaveBeenCalled();
    expect(mocks.channelSessionFindOne).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      channelConnectionId: 'conn-vxml-1',
      externalSessionKey: 'vxml:call-1',
      status: 'active',
    });
    expect(mocks.handleDisconnect).toHaveBeenCalledWith({
      channel: 'voice',
      sessionId: 'runtime-vxml-1',
      dbSessionId: 'runtime-vxml-1',
      tenantId: 'tenant-1',
    });
    expect(mocks.emittedChannelEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'channel.response.sent',
          category: 'channel',
          session_id: 'runtime-vxml-1',
          tenant_id: 'tenant-1',
          project_id: 'project-1',
          data: expect.objectContaining({
            channel: 'vxml',
          }),
        }),
      ]),
    );
  });

  it('records an auth_required trace event and channel response event for Genesys preflight responses', async () => {
    expect(genesysHandlers).toBeTruthy();

    mocks.resolveChannelConnection.mockResolvedValue({
      id: 'conn-genesys-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentId: null,
      channelType: 'genesys',
      externalIdentifier: 'stream-genesys-1',
      credentials: {
        client_secret: 'genesys-secret',
      },
      config: {},
      status: 'active',
    });
    mocks.resolveSession.mockResolvedValue({
      sessionId: 'runtime-genesys-1',
      isNew: false,
    });
    mocks.rehydrateSession.mockResolvedValue({
      id: 'runtime-genesys-1',
      agentName: 'genesys-agent',
      compilationOutput: {},
      versionInfo: { environment: 'prod' },
      tracer: undefined,
    });
    mocks.evaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [
        {
          connector: 'salesforce',
          authProfileRef: 'salesforce-creds',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    const req: any = {
      params: { streamId: 'stream-genesys-1' },
      body: {
        genesysConversationId: 'conv-1',
        inputMessage: {
          type: 'Text',
          text: 'Hi',
        },
      },
      headers: {
        authorization: 'Bearer genesys-secret',
      },
    };
    const res = createMockRes();

    await callHandlers(genesysHandlers, req, res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.replymessages)).toBe(true);
    expect(res.body.replymessages[0].text).toMatch(/authorization/i);
    expect(mocks.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'runtime-genesys-1',
          type: 'error',
          data: expect.objectContaining({
            code: 'AUTH_PREFLIGHT_REQUIRED',
            category: 'auth',
            source: 'channel_outcome',
          }),
        }),
      ]),
    );
    expect(mocks.emittedChannelEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'channel.response.sent',
          category: 'channel',
          session_id: 'runtime-genesys-1',
          tenant_id: 'tenant-1',
          project_id: 'project-1',
          data: expect.objectContaining({
            channel: 'genesys',
          }),
        }),
      ]),
    );
    expect(mocks.executeMessage).not.toHaveBeenCalled();
  });

  // Note: Korevg WebSocket authentication is handled through
  // the KorevgRouter (services/voice/korevg/korevg-router.ts) which uses
  // deployment-based resolution and tenant context authentication.
  // Authentication tests for the new integration should be added separately.
});
