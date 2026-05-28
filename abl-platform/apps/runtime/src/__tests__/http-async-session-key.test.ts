import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  findSubscription: vi.fn(),
  findConnectionById: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared', () => ({
  requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/database/models', () => ({
  WebhookSubscription: {
    findOne: vi.fn((...args: any[]) => mocks.findSubscription(...args)),
  },
  ChannelConnection: {
    findOne: vi.fn((...args: any[]) => mocks.findConnectionById(...args)),
  },
}));

vi.mock('../services/queues/channel-queues.js', () => ({
  getInboundQueue: vi.fn(() => ({ add: mocks.queueAdd })),
}));

vi.mock('../channels/connection-resolver.js', () => ({
  findOrCreateHttpAsyncConnection: vi.fn(),
}));

vi.mock('@abl/compiler/platform/observability', () => ({
  getCurrentTraceId: vi.fn(() => 'trace-123'),
  getObservabilityContext: vi.fn(() => null),
}));

vi.mock('@agent-platform/shared-observability/tracing', () => ({
  injectTrace: vi.fn(),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  generateWebhookSecret: vi.fn(() => 'test-secret'),
}));

vi.mock('../channels/security/callback-url-policy.js', () => ({
  assertAllowedCallbackUrl: vi.fn(),
  CallbackUrlError: class CallbackUrlError extends Error {},
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditSubscriptionCreated: vi.fn(),
  auditSubscriptionUpdated: vi.fn(),
  auditSubscriptionDeleted: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-message-id'),
}));

function createMockReq(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    params: {},
    query: {},
    tenantContext: { tenantId: 'tenant-1', userId: 'user-1' },
    ...overrides,
  } as any;
}

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
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

describe('http-async /message session_key ownership hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSubscription.mockImplementation(() => ({
      lean: vi.fn().mockResolvedValue({
        _id: 'sub-1',
        channelConnectionId: 'conn-1',
        status: 'active',
      }),
    }));
    mocks.findConnectionById.mockImplementation(() => ({
      lean: vi.fn().mockResolvedValue({
        _id: 'conn-1',
        projectId: 'project-1',
        agentId: null,
      }),
    }));
    mocks.queueAdd.mockResolvedValue(undefined);
  });

  it('accepts canonical session_key that belongs to current tenant/subscription', async () => {
    const module = await import('../routes/http-async-channel.js');
    const handlers = findRouteHandlers(module.default, 'post', '/message');
    expect(handlers).toBeTruthy();

    const req = createMockReq({
      body: {
        subscription_id: 'sub-1',
        message: 'Hello',
        session_key: 'http_async:tenant-1:sub-1:thread-1',
      },
    });
    const res = createMockRes();
    await callHandlers(handlers!, req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body.session_key).toBe('http_async:tenant-1:sub-1:thread-1');
    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    const payload = mocks.queueAdd.mock.calls[0][1];
    expect(payload.message.externalSessionKey).toBe('http_async:tenant-1:sub-1:thread-1');
  });

  it('rejects canonical session_key from a different subscription', async () => {
    const module = await import('../routes/http-async-channel.js');
    const handlers = findRouteHandlers(module.default, 'post', '/message');
    expect(handlers).toBeTruthy();

    const req = createMockReq({
      body: {
        subscription_id: 'sub-1',
        message: 'Hello',
        session_key: 'http_async:tenant-1:sub-OTHER:thread-1',
      },
    });
    const res = createMockRes();
    await callHandlers(handlers!, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        error: 'session_key does not belong to this tenant/subscription',
      }),
    );
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('namespaces token-style session_key under current tenant/subscription', async () => {
    const module = await import('../routes/http-async-channel.js');
    const handlers = findRouteHandlers(module.default, 'post', '/message');
    expect(handlers).toBeTruthy();

    const req = createMockReq({
      body: {
        subscription_id: 'sub-1',
        message: 'Hello',
        session_key: 'thread_abc',
      },
    });
    const res = createMockRes();
    await callHandlers(handlers!, req, res);

    expect(res.statusCode).toBe(202);
    const payload = mocks.queueAdd.mock.calls[0][1];
    expect(payload.message.externalSessionKey).toBe('http_async:tenant-1:sub-1:thread_abc');
  });
});
