import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Mock heavy external packages to avoid slow module loading
vi.mock('@agent-platform/shared', () => ({
  createUnifiedAuthMiddleware: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  requireAuth: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  requirePermission: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  requestIdMiddleware: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  EncryptionService: vi.fn().mockImplementation(() => ({
    encryptForTenant: vi.fn(),
    decryptForTenant: vi.fn(),
  })),
}));

vi.mock('@agent-platform/database/models', () => ({
  Workflow: {},
  WorkflowExecution: {},
  ConnectorConnection: {},
}));

vi.mock('@agent-platform/connectors', () => ({
  ConnectorRegistry: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock local services
vi.mock('../services/database.js', () => ({
  initDatabase: vi.fn().mockResolvedValue(undefined),
  disconnectDatabase: vi.fn().mockResolvedValue(undefined),
  isDatabaseAvailable: vi.fn().mockReturnValue(true),
}));
vi.mock('../services/redis.js', () => ({
  initRedis: vi.fn().mockResolvedValue(undefined),
  getRedisClient: vi.fn().mockReturnValue(null),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../observability/otel-setup.js', () => ({}));

vi.mock('../services/restate-client.js', () => ({
  RestateWorkflowClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../persistence/execution-store.js', () => ({
  ExecutionStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../services/restate-endpoint.js', () => ({
  buildRestateEndpoint: vi.fn().mockReturnValue({
    listen: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../notifications/notification-dispatcher.js', () => ({
  NotificationDispatcher: vi.fn().mockImplementation(() => ({
    dispatch: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../context/expression-resolver.js', () => ({}));

// Mock route factories to return lightweight express routers
const dummyRouter = () => express.Router();
vi.mock('../routes/index.js', () => ({
  createWorkflowExecutionRouter: vi.fn().mockReturnValue(dummyRouter()),
  createCallbackRouter: vi.fn().mockReturnValue(dummyRouter()),
  createApprovalRouter: vi.fn().mockReturnValue(dummyRouter()),
  createConnectionRouter: vi.fn().mockReturnValue(dummyRouter()),
  createConnectorRouter: vi.fn().mockReturnValue(dummyRouter()),
  createNotificationRuleRouter: vi.fn().mockReturnValue(dummyRouter()),
}));

// Mock global fetch to avoid real HTTP calls to Restate admin
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '{}',
  }) as any;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Graceful Shutdown', () => {
  let originalExit: typeof process.exit;
  let exitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalExit = process.exit;
    exitMock = vi.fn() as any;
    process.exit = exitMock as any;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it('index.ts exports the Express app', async () => {
    const mod = await import('../index.js');
    expect(mod.app).toBeDefined();
    expect(typeof mod.app.get).toBe('function');
    expect(typeof mod.app.listen).toBe('function');
  });

  it('health endpoint returns ok', async () => {
    const { app } = await import('../index.js');
    const { default: supertest } = await import('supertest');

    const res = await supertest(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'workflow-engine' });
    expect(res.body.build).toEqual(
      expect.objectContaining({
        environment: expect.any(String),
        deployId: expect.any(String),
        codeVersion: expect.any(String),
        commitSha: null,
        packageVersion: expect.any(String),
        versionSource: expect.any(String),
      }),
    );
  });

  it('readiness endpoint is 503 until Restate is healthy', async () => {
    // The readiness probe gates on three conditions: !isShuttingDown,
    // isDatabaseAvailable, and isRestateHealthy. In unit tests there is no
    // Restate admin to reach, so the probe returns 503 with the
    // `restate_not_healthy` reason. Integration tests cover the 200 path.
    const { app } = await import('../index.js');
    const { default: supertest } = await import('supertest');

    const res = await supertest(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, reason: 'restate_not_healthy' });
  });

  it('SHUTDOWN_TIMEOUT_MS is imported from constants', async () => {
    const { SHUTDOWN_TIMEOUT_MS } = await import('../constants.js');
    expect(SHUTDOWN_TIMEOUT_MS).toBe(15_000);
  });
});
