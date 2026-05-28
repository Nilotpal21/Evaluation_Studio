/**
 * Chat Session Ownership Guard Tests
 *
 * Verifies the cross-tenant session rehydration guard in POST /api/v1/chat/agent.
 * When a caller provides an existing sessionId, the handler must verify
 * that the session belongs to the caller's tenant before allowing resume.
 *
 * Scenarios:
 * 1. In-memory session with tenant mismatch -> 404
 * 2. In-memory session with tenant match -> passes through (no 404)
 * 3. No tenant context on resume attempt -> 401
 * 4. DB available but session not found for tenant -> 404
 * 5. DB unavailable and session not in memory -> 404
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';

// =============================================================================
// MOCKS -- declared before any import that transitively pulls them in
// =============================================================================

const mockProjectFindFirst = vi.fn();
const mockStreamChatWithToolUse = vi.fn();
const mockChatWithToolUse = vi.fn();
const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockLogDebug = vi.fn();
const mockMetricsRecord = vi.fn().mockResolvedValue(undefined);
const mockMetricsGetUsage = vi.fn();
const mockMetricsGetCostBreakdown = vi.fn();

const mockConvStoreCreateSession = vi.fn().mockResolvedValue({ id: 'db-sess-1' });

const mockGetSession = vi.fn();
const mockRehydrateSession = vi.fn().mockResolvedValue(null);
const mockExecutor = {
  isConfigured: vi.fn().mockReturnValue(true),
  createSessionFromResolved: vi.fn(),
  executeMessage: vi.fn(),
  getSession: mockGetSession,
  rehydrateSession: mockRehydrateSession,
  checkSessionQuota: vi.fn(),
  releaseSessionSlot: vi.fn(),
};

const mockResolve = vi.fn();
const mockCompileToResolvedAgent = vi.fn(() => ({
  agents: {},
  entryAgent: 'greeting',
  compilationOutput: { agents: {} },
  sourceHash: 'working-copy',
  versionInfo: { versions: {} },
}));
const mockIsCoordinatorAvailable = vi.fn(() => false);

const mockIsResolutionDatabaseAvailable = vi.fn();
const mockFindSessionById = vi.fn();

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: mockProjectFindFirst,
  findProjectWithAgents: mockProjectFindFirst,
  findProjectAgentForProject: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => next()),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => mockExecutor),
  compileToResolvedAgent: (...args: any[]) => mockCompileToResolvedAgent(...args),
}));

vi.mock('../../services/execution/coordinator-singleton.js', () => ({
  getExecutionCoordinator: vi.fn(() => ({
    submit: vi.fn(),
  })),
  isCoordinatorAvailable: (...args: any[]) => mockIsCoordinatorAvailable(...args),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: vi.fn(() => true),
  getEncryptionService: vi.fn(() => ({})),
}));

vi.mock('../../services/llm/index.js', () => ({
  ModelResolutionService: class MockModelResolutionService {},
  SessionLLMClient: class MockSessionLLMClient {
    streamChatWithToolUse = mockStreamChatWithToolUse;
    chatWithToolUse = mockChatWithToolUse;
  },
}));

vi.mock('../../services/llm/model-router.js', () => ({
  getModelCapabilities: vi.fn(() => ({
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
  })),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    metrics: {
      record: mockMetricsRecord,
      getUsage: mockMetricsGetUsage,
      getCostBreakdown: mockMetricsGetCostBreakdown,
    },
    conversation: {
      createSession: mockConvStoreCreateSession,
    },
    message: { addMessage: vi.fn() },
    contact: {},
    fact: {},
    workflowDefinition: {},
    createAgentRegistry: vi.fn(() => ({})),
  })),
}));

vi.mock('../../services/stores/clickhouse-metrics-store.js', () => ({
  ClickHouseMetricsStore: class MockClickHouseMetricsStore {
    async record(...args: unknown[]) {
      return mockMetricsRecord(...args);
    }
  },
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve = mockResolve;
  },
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => ({})),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  })),
}));

vi.mock('../../repos/llm-resolution-repo.js', () => ({
  isResolutionDatabaseAvailable: (...args: any[]) => mockIsResolutionDatabaseAvailable(...args),
  findAgentModelConfig: vi.fn().mockResolvedValue(null),
  findModelConfigForTier: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../repos/session-repo.js', () => ({
  findSessionById: (...args: any[]) => mockFindSessionById(...args),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: vi.fn().mockResolvedValue(undefined),
  persistMessageRecord: vi.fn().mockResolvedValue(undefined),
  persistTurnMetrics: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/channel/constants.js', () => ({
  MAX_CLICKHOUSE_STORE_CACHE: 100,
  WS_MESSAGE_TIMEOUT_MS: 30_000,
}));

vi.mock('../../services/identity/artifact-hasher.js', () => ({
  buildCallerContext: vi.fn(() => ({
    customerId: null,
    anonymousId: null,
    channelArtifact: null,
    channel: 'api',
  })),
  buildCallerContextFromTenantContext: vi.fn(() => ({
    customerId: null,
    anonymousId: null,
    channelArtifact: null,
    channel: 'api',
  })),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  canStartSession: vi.fn().mockResolvedValue(true),
  recordTokenUsage: vi.fn().mockResolvedValue(undefined),
  claimSessionSlot: vi.fn().mockResolvedValue(1),
  releaseSessionSlot: vi.fn().mockResolvedValue(0),
  incrementSessionCount: vi.fn().mockResolvedValue(1),
  decrementSessionCount: vi.fn().mockResolvedValue(0),
  checkSessionMessageRate: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
    getProjectConfig: vi.fn().mockRejectedValue(new Error('No MongoDB in test')),
  }),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: () => null,
  getRedisHandle: () => null,
  isRedisAvailable: () => false,
}));

// =============================================================================
// APP SETUP — TWO SERVERS
// =============================================================================

import express from 'express';

let baseUrl: string;
let server: http.Server | undefined;

// Server with tenant-A context (standard caller)
let noTenantBaseUrl: string;
let noTenantServer: http.Server | undefined;

const SERVER_SETUP_TIMEOUT_MS = 120_000;

async function closeServer(nextServer: http.Server | undefined): Promise<void> {
  if (!nextServer?.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    nextServer.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function listenOnLoopback(app: ReturnType<typeof express>): Promise<{
  baseUrl: string;
  server: http.Server;
}> {
  const nextServer = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    nextServer.once('error', reject);
    nextServer.listen(0, '127.0.0.1', () => {
      nextServer.off('error', reject);
      resolve();
    });
  });

  const addr = nextServer.address();
  if (!addr || typeof addr === 'string') {
    await closeServer(nextServer);
    throw new Error('Expected loopback TCP address for chat session ownership test server');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    server: nextServer,
  };
}

beforeAll(async () => {
  const chatRouter = (await import('../../routes/chat.js')).default;

  // Server 1: Requests carry tenantId 'tenant-A'
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantContext = {
      tenantId: 'tenant-A',
      userId: 'user-1',
      permissions: ['*:*'],
      authType: 'jwt',
    };
    req.user = { id: 'user-1', email: 'test@test.com' };
    next();
  });
  app.use('/api/v1/chat', chatRouter);

  ({ baseUrl, server } = await listenOnLoopback(app));

  // Server 2: Requests carry NO tenantContext (simulates missing auth)
  const appNoTenant = express();
  appNoTenant.use(express.json());
  appNoTenant.use((req: any, _res: any, next: any) => {
    // Deliberately do NOT set req.tenantContext
    req.user = { id: 'anon-user', email: 'anon@test.com' };
    next();
  });
  appNoTenant.use('/api/v1/chat', chatRouter);

  ({ baseUrl: noTenantBaseUrl, server: noTenantServer } = await listenOnLoopback(appNoTenant));
}, SERVER_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([closeServer(server), closeServer(noTenantServer)]);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockExecutor.isConfigured.mockReturnValue(true);
  mockIsResolutionDatabaseAvailable.mockReturnValue(true);
  // RBAC (requireProjectPermission) verifies project exists before checking permissions.
  // Return a valid project so RBAC passes through to the session ownership guard.
  mockProjectFindFirst.mockResolvedValue({ _id: 'proj-1', tenantId: 'tenant-A' });
});

// =============================================================================
// HELPERS
// =============================================================================

async function request(url: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE or non-JSON */
  }
  return { status: res.status, body: json, text };
}

const CHAT_AGENT_PATH = '/api/v1/chat/agent';

// =============================================================================
// TESTS: Cross-Tenant Session Ownership Guard
// =============================================================================

describe('POST /api/v1/chat/agent — cross-tenant session ownership guard', () => {
  // -------------------------------------------------------------------------
  // Scenario A: In-memory session with tenant MISMATCH -> 404
  // -------------------------------------------------------------------------
  test('returns 404 when in-memory session belongs to a different tenant', async () => {
    // Session belongs to tenant-B, caller is tenant-A
    mockGetSession.mockReturnValue({
      tenantId: 'tenant-B',
      id: 'existing-sess-1',
      agentName: 'test-agent',
    });

    const { status, body } = await request(baseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'existing-sess-1', message: 'Hello' },
    });

    expect(status).toBe(404);
    expect(body.error).toBe('Session not found');
    // Must not proceed to executeMessage
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario B: In-memory session with tenant MATCH -> passes through
  // -------------------------------------------------------------------------
  test('passes through when in-memory session belongs to the same tenant', async () => {
    // Session belongs to tenant-A and proj-1, caller is tenant-A -> should proceed
    mockGetSession.mockReturnValue({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      id: 'existing-sess-2',
      agentName: 'test-agent',
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Continuing conversation.',
      action: { type: 'continue' },
    });

    const { status, body } = await request(baseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'existing-sess-2', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      sessionId: 'existing-sess-2',
    });
    expect(body.error).toBeUndefined();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario C: No tenant context on resume -> 401 (RBAC rejects before session check)
  // -------------------------------------------------------------------------
  test('returns 401 when no tenant context is available for session resume', async () => {
    // Session not in memory (getSession returns null/undefined)
    mockGetSession.mockReturnValue(null);

    const { status, body } = await request(noTenantBaseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'sess-needs-auth', message: 'Hello' },
    });

    // RBAC middleware (requireProjectPermission) rejects before the session ownership
    // guard is reached — no tenantContext means 401 "Authentication required".
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario D: DB available, session not found for caller's tenant -> 404
  // -------------------------------------------------------------------------
  test('returns 404 when DB is available but session is not found for tenant', async () => {
    // Session not in memory
    mockGetSession.mockReturnValue(null);
    // DB is available
    mockIsResolutionDatabaseAvailable.mockReturnValue(true);
    // DB lookup returns no session for this tenant
    mockFindSessionById.mockResolvedValue(null);

    const { status, body } = await request(baseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'sess-other-tenant', message: 'Hello' },
    });

    expect(status).toBe(404);
    expect(body.error).toBe('Session not found');
    // Verify the DB lookup was scoped to the caller's tenant
    expect(mockFindSessionById).toHaveBeenCalledWith('sess-other-tenant', 'tenant-A');
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario E: DB unavailable and session not in memory -> 404
  // -------------------------------------------------------------------------
  test('returns 404 when DB is unavailable and session is not in memory', async () => {
    // Session not in memory
    mockGetSession.mockReturnValue(null);
    // DB is NOT available
    mockIsResolutionDatabaseAvailable.mockReturnValue(false);

    const { status, body } = await request(baseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'sess-no-db', message: 'Hello' },
    });

    expect(status).toBe(404);
    expect(body.error).toBe('Session not found');
    // DB lookup should NOT have been attempted
    expect(mockFindSessionById).not.toHaveBeenCalled();
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario F: DB available and session found for tenant -> passes through
  // -------------------------------------------------------------------------
  test('passes through when DB session is found for the caller tenant', async () => {
    // Session not in memory
    mockGetSession.mockReturnValue(null);
    // DB is available
    mockIsResolutionDatabaseAvailable.mockReturnValue(true);
    // DB lookup finds the session for this tenant and project
    mockFindSessionById.mockResolvedValue({
      _id: 'db-sess-id',
      runtimeSessionId: 'sess-found-in-db',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });

    // Rehydrate returns a valid runtime session so executeMessage can proceed
    mockRehydrateSession.mockResolvedValue({
      id: 'sess-found-in-db',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      agentName: 'test-agent',
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Resuming from DB.',
      action: { type: 'continue' },
    });

    const { status, body } = await request(baseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'sess-found-in-db', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      sessionId: 'sess-found-in-db',
    });
    expect(body.error).toBeUndefined();
    expect(mockFindSessionById).toHaveBeenCalledWith('sess-found-in-db', 'tenant-A');
    expect(mockLogError).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario G: No tenant context -> 401 from RBAC (can't reach session guard)
  // -------------------------------------------------------------------------
  test('returns 401 when caller has no tenant context even if session has null tenantId', async () => {
    // Previously tested null-tenant matching, but RBAC (requireProjectPermission)
    // now rejects requests with no tenantContext before the session guard runs.
    mockGetSession.mockReturnValue({
      tenantId: null,
      id: 'sess-no-tenant',
      agentName: 'test-agent',
    });

    const { status, body } = await request(noTenantBaseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'sess-no-tenant', message: 'Hello' },
    });

    // RBAC rejects before session ownership guard
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Scenario H: No tenant context -> 401 from RBAC (can't reach session guard)
  // -------------------------------------------------------------------------
  test('returns 401 when caller has no tenant context even if session has tenantId', async () => {
    // Previously tested tenant mismatch (session=B, caller=null → 404),
    // but RBAC (requireProjectPermission) now rejects before session guard.
    mockGetSession.mockReturnValue({
      tenantId: 'tenant-B',
      id: 'sess-tenant-b',
      agentName: 'test-agent',
    });

    const { status, body } = await request(noTenantBaseUrl, 'POST', CHAT_AGENT_PATH, {
      body: { projectId: 'proj-1', sessionId: 'sess-tenant-b', message: 'Hello' },
    });

    // RBAC rejects before session ownership guard
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ message: 'Authentication required' });
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });
});
