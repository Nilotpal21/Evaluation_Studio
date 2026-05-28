import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  save: vi.fn(),
  isEncryptionAvailable: vi.fn(),
  encryptForTenant: vi.fn(),
  generateWebhookSecret: vi.fn(),
  auditSubscriptionCreated: vi.fn(),
  auditSubscriptionUpdated: vi.fn(),
  auditSubscriptionDeleted: vi.fn(),
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

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: (...args: any[]) => mocks.isEncryptionAvailable(...args),
  getEncryptionService: () => ({
    encryptForTenant: (...args: any[]) => mocks.encryptForTenant(...args),
    decryptForTenant: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared-kernel/security', () => ({
  generateWebhookSecret: (...args: any[]) => mocks.generateWebhookSecret(...args),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditSubscriptionCreated: (...args: any[]) => mocks.auditSubscriptionCreated(...args),
  auditSubscriptionUpdated: (...args: any[]) => mocks.auditSubscriptionUpdated(...args),
  auditSubscriptionDeleted: (...args: any[]) => mocks.auditSubscriptionDeleted(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  WebhookSubscription: {
    findOne: (...args: any[]) => mocks.findOne(...args),
  },
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

describe('http-async PATCH /subscriptions/:id regenerate_secret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isEncryptionAvailable.mockReturnValue(true);
    mocks.generateWebhookSecret.mockReturnValue('whsec_new_secret');
    mocks.encryptForTenant.mockReturnValue('enc_new_secret');

    const docData = {
      _id: 'sub-1',
      tenantId: 'tenant-1',
      callbackUrl: 'https://example.com/webhook',
      events: JSON.stringify(['agent.response']),
      status: 'active',
      description: null,
      updatedAt: new Date('2026-02-15T00:00:00.000Z').toISOString(),
    };

    // First call: lean query for subscription check
    // Second call: non-lean for findOne + save() pattern
    let callCount = 0;
    mocks.findOne.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { lean: vi.fn().mockResolvedValue(docData) };
      }
      // Second call returns a Mongoose-like document with set() and save()
      const mockDoc: Record<string, unknown> = { ...docData };
      mockDoc.set = vi.fn((key: string, value: unknown) => {
        mockDoc[key] = value;
      });
      mockDoc.save = vi.fn().mockResolvedValue(mockDoc);
      return Promise.resolve(mockDoc);
    });

    mocks.save.mockResolvedValue(undefined);
  });

  it('rotates secret and returns plaintext once', async () => {
    const module = await import('../routes/http-async-channel.js');
    const handlers = findRouteHandlers(module.default, 'patch', '/subscriptions/:id');
    expect(handlers).toBeTruthy();

    const req = createMockReq({
      params: { id: 'sub-1' },
      body: { regenerate_secret: true },
    });
    const res = createMockRes();

    await callHandlers(handlers!, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.secret).toBe('whsec_new_secret');
    expect(res.body._note).toContain('Store the new secret securely');

    expect(mocks.generateWebhookSecret).toHaveBeenCalledTimes(1);
    // Plugin handles encryption transparently — no manual encryptForTenant call
    expect(mocks.auditSubscriptionUpdated).toHaveBeenCalledTimes(1);
  });

  it('succeeds even when encryption service is reported unavailable (plugin handles encryption)', async () => {
    // Encryption is now handled by the Mongoose plugin transparently,
    // so route no longer checks isEncryptionAvailable
    mocks.isEncryptionAvailable.mockReturnValue(false);

    const module = await import('../routes/http-async-channel.js');
    const handlers = findRouteHandlers(module.default, 'patch', '/subscriptions/:id');
    expect(handlers).toBeTruthy();

    const req = createMockReq({
      params: { id: 'sub-1' },
      body: { regenerate_secret: true },
    });
    const res = createMockRes();

    await callHandlers(handlers!, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.secret).toBe('whsec_new_secret');
  });
});
