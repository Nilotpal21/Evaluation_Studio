/**
 * Chat Routes Integration Tests
 *
 * Mounts the chat router on a real Express app and exercises the endpoints
 * via Node's built-in fetch against an http.createServer listener.
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — declared before any import that transitively pulls them in
// =============================================================================

const mockProjectFindFirst = vi.fn();
const mockFindProjectRuntimeConfig = vi.fn();
const mockLoadConfigVariablesMap = vi.fn();
const mockStreamChatWithToolUse = vi.fn();
const mockChatWithToolUse = vi.fn();
const mockMetricsRecord = vi.fn().mockResolvedValue(undefined);
const mockMetricsGetUsage = vi.fn();
const mockMetricsGetCostBreakdown = vi.fn();
const mockEvaluateAuthPreflightFromIR = vi.fn().mockResolvedValue(null);
const mockCreateTokenLookups = vi.fn(() => ({}));
const mockPersistMessage = vi.fn().mockResolvedValue(undefined);
const mockPersistMessageRecord = vi.fn().mockResolvedValue(undefined);
const mockPersistTurnMetrics = vi.fn().mockResolvedValue(undefined);
const mockPersistScopedMessage = vi.fn().mockResolvedValue(undefined);
const mockPersistScopedTurnMetrics = vi.fn().mockResolvedValue(undefined);
const mockGetContactLinkingDeps = vi.fn();
const mockResolveCanonicalContactForProductionScope = vi.fn();
const mockRequireProjectPermission = vi.fn().mockResolvedValue(true);
const mockEvaluateProjectExecutionReadiness = vi.fn();
const mockResolveAttachmentConfig = vi.fn();
const mockAttachmentUpload = vi.fn();
const mockAttachmentDelete = vi.fn();

const mockConvStoreCreateSession = vi.fn().mockResolvedValue({ id: 'db-sess-1' });
const mockConvStoreLinkContact = vi.fn().mockResolvedValue(undefined);

const mockExecutor = {
  isConfigured: vi.fn().mockReturnValue(true),
  createSessionFromResolved: vi.fn(),
  executeMessage: vi.fn(),
  getSession: vi.fn(),
  checkSessionQuota: vi.fn(),
  releaseSessionSlot: vi.fn(),
};

const mockResolve = vi.fn();
const mockCompileToResolvedAgent = vi.fn(
  (_dsls: string[], entryAgent: string, _configVariables?: Record<string, string>) => ({
    agents: {},
    entryAgent,
    compilationOutput: { agents: {} },
    sourceHash: 'working-copy',
    versionInfo: { versions: {} },
  }),
);
const mockCompileProjectWorkingCopy = vi.fn(({ entryAgentName }: { entryAgentName: string }) => ({
  resolved: {
    agents: {},
    entryAgent: entryAgentName,
    compilationOutput: { agents: {} },
    sourceHash: 'working-copy',
    versionInfo: { versions: {} },
  },
  configVariables: {},
  warnings: [],
  documents: [],
  profileDocuments: [],
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
  isDatabaseReady: vi.fn(() => true),
}));

// Mock session-repo to control DB-backed session ownership checks in chat routes
const mockFindSessionById = vi.fn().mockResolvedValue(null);
const mockFindSessionByRuntimeId = vi.fn().mockResolvedValue(null);
vi.mock('../../repos/session-repo.js', () => ({
  findSessionById: (...args: any[]) => mockFindSessionById(...args),
  findSessionByRuntimeId: (...args: any[]) => mockFindSessionByRuntimeId(...args),
}));

// isResolutionDatabaseAvailable() always returns true in production code;
// mock explicitly so new-session creation paths are deterministic in tests.
vi.mock('../../repos/llm-resolution-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../repos/llm-resolution-repo.js')>();
  return { ...actual, isResolutionDatabaseAvailable: vi.fn().mockReturnValue(true) };
});

vi.mock('../../repos/project-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repos/project-repo.js')>();
  return {
    ...actual,
    findProjectByIdAndTenant: mockProjectFindFirst,
    findProjectWithAgents: mockProjectFindFirst,
    findProjectRuntimeConfig: (...args: any[]) => mockFindProjectRuntimeConfig(...args),
    loadConfigVariablesMap: (...args: any[]) => mockLoadConfigVariablesMap(...args),
  };
});

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => next()),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => mockExecutor),
  compileToResolvedAgent: (...args: any[]) => mockCompileToResolvedAgent(...args),
}));

vi.mock('../../services/project-working-copy-compiler.js', () => ({
  buildProjectWorkingCopyAgentSources: (agents: Array<Record<string, unknown>>) =>
    agents
      .filter(
        (agent): agent is { name: string; dslContent: string; systemPromptLibraryRef?: unknown } =>
          typeof agent.name === 'string' && typeof agent.dslContent === 'string',
      )
      .map((agent) => ({
        name: agent.name,
        dslContent: agent.dslContent,
        systemPromptLibraryRef:
          agent.systemPromptLibraryRef &&
          typeof agent.systemPromptLibraryRef === 'object' &&
          typeof (agent.systemPromptLibraryRef as { promptId?: unknown }).promptId === 'string' &&
          typeof (agent.systemPromptLibraryRef as { versionId?: unknown }).versionId === 'string'
            ? {
                promptId: (agent.systemPromptLibraryRef as { promptId: string }).promptId,
                versionId: (agent.systemPromptLibraryRef as { versionId: string }).versionId,
              }
            : null,
      })),
  compileProjectWorkingCopy: (...args: any[]) => mockCompileProjectWorkingCopy(...args),
  extractSearchInstructionsFromDsl: () => new Map(),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: vi.fn(() => true),
  isTenantEncryptionReady: vi.fn(() => true),
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
    conversation: {
      createSession: mockConvStoreCreateSession,
      linkContact: mockConvStoreLinkContact,
    },
    message: { addMessage: vi.fn() },
    contact: {},
    fact: {},
    workflowDefinition: {},
    createAgentRegistry: vi.fn(() => ({})),
  })),
}));

// Force ClickHouse unavailable so getMetricsStoreAsync() always falls back to InMemoryMetricsStore.
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => {
    throw new Error('No ClickHouse in tests');
  },
}));

// Mock the metrics store module used by chat.ts internally
vi.mock('@abl/compiler/platform/stores/metrics-store.js', () => ({
  InMemoryMetricsStore: class MockInMemoryMetricsStore {
    record = mockMetricsRecord;
    getUsage = mockMetricsGetUsage;
    getCostBreakdown = mockMetricsGetCostBreakdown;
  },
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve = mockResolve;
  },
}));

vi.mock('../../services/auth-profile/auth-preflight.js', () => ({
  evaluateAuthPreflightFromIR: (...args: any[]) => mockEvaluateAuthPreflightFromIR(...args),
  createTokenLookups: (...args: any[]) => mockCreateTokenLookups(...args),
}));

const mockGetSessionService = vi.fn(() => ({
  isDistributed: () => false,
  store: {},
}));
vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: (...args: any[]) => mockGetSessionService(...args),
}));

vi.mock('../../services/session/project-agent-dsl-readiness.js', () => ({
  buildProjectDslReadinessError: vi.fn(
    () =>
      'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
  ),
  evaluateProjectExecutionReadiness: (...args: any[]) =>
    mockEvaluateProjectExecutionReadiness(...args),
}));

vi.mock('../../attachments/attachment-config-resolver.js', () => ({
  resolveAttachmentConfig: (...args: any[]) => mockResolveAttachmentConfig(...args),
}));

vi.mock('../../attachments/multimodal-service-client.js', () => ({
  MultimodalServiceClient: class MockMultimodalServiceClient {
    upload = (...args: any[]) => mockAttachmentUpload(...args);
    deleteAttachment = (...args: any[]) => mockAttachmentDelete(...args);
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@abl/compiler/platform')>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: any[]) => mockRequireProjectPermission(...args),
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

vi.mock('../../services/execution/coordinator-singleton.js', () => ({
  isCoordinatorAvailable: vi.fn().mockReturnValue(false),
  getExecutionCoordinator: vi.fn(),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: (...args: any[]) => mockPersistMessage(...args),
  persistMessageRecord: (...args: any[]) => mockPersistMessageRecord(...args),
  persistTurnMetrics: (...args: any[]) => mockPersistTurnMetrics(...args),
  persistScopedMessage: (...args: any[]) => mockPersistScopedMessage(...args),
  persistScopedTurnMetrics: (...args: any[]) => mockPersistScopedTurnMetrics(...args),
}));

vi.mock('../../services/identity/artifact-hasher.js', () => ({
  buildCallerContext: vi.fn((input: Record<string, unknown>) => ({
    tenantId: input.tenantId ?? 'test-tenant',
    channel: input.channel ?? 'api',
    channelId: input.channelId,
    contactId: input.contactId,
    customerId: input.customerId,
    anonymousId: input.anonymousId,
    initiatedById: input.initiatedById,
    identityTier: input.identityTier ?? 0,
    verificationMethod: input.verificationMethod ?? 'none',
    channelArtifact: input.rawArtifact ? 'hashed-artifact' : undefined,
    channelArtifactType: input.channelArtifactType,
  })),
  buildCallerContextFromTenantContext: vi.fn(() => ({
    tenantId: 'test-tenant',
    channel: 'api',
    identityTier: 0,
    verificationMethod: 'none',
  })),
}));

vi.mock('../../services/identity/contact-linking-deps.js', () => ({
  getContactLinkingDeps: (...args: any[]) => mockGetContactLinkingDeps(...args),
}));

vi.mock('../../services/identity/production-contact-resolution.js', () => ({
  resolveCanonicalContactForProductionScope: (...args: any[]) =>
    mockResolveCanonicalContactForProductionScope(...args),
}));

// =============================================================================
// APP SETUP
// =============================================================================

import express from 'express';
import { isEncryptionAvailable, isTenantEncryptionReady } from '@agent-platform/shared/encryption';

let baseUrl: string;
let server: http.Server;
let injectedTenantContext: any;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Inject tenantContext for every request
  app.use((req: any, _res: any, next: any) => {
    req.tenantContext = { ...injectedTenantContext };
    req.user = {
      id: injectedTenantContext.userId,
      email: 'test@test.com',
    };
    next();
  });

  const chatRouter = (await import('../../routes/chat.js')).default;
  app.use('/api/v1/chat', chatRouter);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCompileProjectWorkingCopy.mockImplementation(
    ({ entryAgentName }: { entryAgentName: string }) => ({
      resolved: {
        agents: {},
        entryAgent: entryAgentName,
        compilationOutput: { agents: {} },
        sourceHash: 'working-copy',
        versionInfo: { versions: {} },
      },
      configVariables: {},
      warnings: [],
      documents: [],
      profileDocuments: [],
    }),
  );
  injectedTenantContext = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    role: 'ADMIN',
    permissions: ['project:*', 'session:*'],
    authType: 'user',
    isSuperAdmin: false,
  };

  // Restore common defaults after clearAllMocks
  vi.mocked(isEncryptionAvailable).mockReturnValue(true);
  vi.mocked(isTenantEncryptionReady).mockReturnValue(true);
  mockExecutor.isConfigured.mockReturnValue(true);
  mockFindSessionById.mockResolvedValue(null);
  mockFindSessionByRuntimeId.mockResolvedValue(null);
  mockEvaluateAuthPreflightFromIR.mockResolvedValue(null);
  mockCreateTokenLookups.mockReturnValue({});
  mockPersistMessage.mockResolvedValue(undefined);
  mockPersistTurnMetrics.mockResolvedValue(undefined);
  mockConvStoreLinkContact.mockResolvedValue(undefined);
  mockLoadConfigVariablesMap.mockResolvedValue({});
  mockFindProjectRuntimeConfig.mockResolvedValue(null);
  mockEvaluateProjectExecutionReadiness.mockImplementation(async ({ agents }) => ({
    executableAgents: agents,
    blockedAgents: [],
    hasBlockingErrors: false,
    issues: [],
  }));
  mockResolveAttachmentConfig.mockResolvedValue({
    enabled: true,
    maxFileSizeBytes: 1024 * 1024,
    maxFilesPerSession: 100,
    allowedMimeTypes: [],
  });
  mockAttachmentUpload.mockResolvedValue({
    success: true,
    attachmentId: 'uploaded-attachment-1',
    status: 'processing',
  });
  mockAttachmentDelete.mockResolvedValue(undefined);
  mockGetContactLinkingDeps.mockReturnValue({} as any);
  mockResolveCanonicalContactForProductionScope.mockResolvedValue(null);
  mockRequireProjectPermission.mockResolvedValue(true);
  mockGetSessionService.mockReturnValue({
    isDistributed: () => false,
    store: {},
  });
});

// =============================================================================
// HELPERS
// =============================================================================

async function request(method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
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

async function requestMultipart(path: string, form: FormData) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: form,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json, text };
}

const VALID_CHAT_BODY = {
  projectId: 'cm1abc2def3gh4ij5kl6mn7op', // cuid format
  messages: [{ role: 'user', content: 'Hello' }],
};

describe('chat OpenAPI contract', () => {
  test('documents localization on REST chat agent responses', async () => {
    const { runtimeRegistry } = await import('../../openapi/registry.js');
    const spec = runtimeRegistry.generateSpec({
      title: 'Runtime API',
      version: 'test',
    }) as {
      paths?: Record<string, unknown>;
    };

    const serializedAgentRoute = JSON.stringify(spec.paths?.['/api/v1/chat/agent']);
    expect(serializedAgentRoute).toContain('"localization"');
  });
});

// =============================================================================
// POST /api/v1/chat/stream
// =============================================================================

describe('POST /api/v1/chat/stream', () => {
  test('returns 400 on invalid request body', async () => {
    const { status, body } = await request('POST', '/api/v1/chat/stream', {
      body: { messages: [] },
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid request');
  });

  test('returns 400 when projectId is empty string', async () => {
    const { status, body } = await request('POST', '/api/v1/chat/stream', {
      body: { projectId: '', messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid request');
  });

  test('returns 503 when encryption is not available', async () => {
    vi.mocked(isTenantEncryptionReady).mockReturnValue(false);

    const { status, body } = await request('POST', '/api/v1/chat/stream', {
      body: VALID_CHAT_BODY,
    });

    expect(status).toBe(503);
    expect(body.error).toContain('Tenant DEK encryption is not initialized');
  });

  test('returns 404 when project not found', async () => {
    mockProjectFindFirst.mockResolvedValue(null);

    const { status, body } = await request('POST', '/api/v1/chat/stream', {
      body: VALID_CHAT_BODY,
    });

    expect(status).toBe(404);
    expect(body.error).toEqual(
      expect.objectContaining({
        code: 'PROJECT_NOT_FOUND',
        message: expect.stringContaining('Project not found'),
      }),
    );
  });
});

// =============================================================================
// POST /api/v1/chat/complete
// =============================================================================

describe('POST /api/v1/chat/complete', () => {
  test('returns 400 on invalid request body', async () => {
    const { status, body } = await request('POST', '/api/v1/chat/complete', {
      body: {},
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid request');
  });

  test('returns 503 when encryption is not available', async () => {
    vi.mocked(isTenantEncryptionReady).mockReturnValue(false);

    const { status, body } = await request('POST', '/api/v1/chat/complete', {
      body: VALID_CHAT_BODY,
    });

    expect(status).toBe(503);
    expect(body.error).toContain('Tenant DEK encryption is not initialized');
  });

  test('returns 404 when project not found', async () => {
    mockProjectFindFirst.mockResolvedValue(null);

    const { status, body } = await request('POST', '/api/v1/chat/complete', {
      body: VALID_CHAT_BODY,
    });

    expect(status).toBe(404);
    expect(body.error).toEqual(
      expect.objectContaining({
        code: 'PROJECT_NOT_FOUND',
        message: expect.stringContaining('Project not found'),
      }),
    );
  });

  test('accepts voice tier overrides at the request boundary', async () => {
    mockProjectFindFirst.mockResolvedValue(null);

    const { status, body } = await request('POST', '/api/v1/chat/complete', {
      body: { ...VALID_CHAT_BODY, tier: 'voice' },
    });

    expect(status).toBe(404);
    expect(body.error).toEqual(
      expect.objectContaining({
        code: 'PROJECT_NOT_FOUND',
        message: expect.stringContaining('Project not found'),
      }),
    );
  });

  test('returns 200 with completion result on success', async () => {
    mockProjectFindFirst.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
    mockChatWithToolUse.mockResolvedValue({
      text: 'Hello! How can I help?',
      toolCalls: [],
      stopReason: 'end_turn',
      resolvedModel: { modelId: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    const { status, body } = await request('POST', '/api/v1/chat/complete', {
      body: VALID_CHAT_BODY,
    });

    expect(status).toBe(200);
    expect(body.content).toBe('Hello! How can I help?');
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
    expect(body.usage.inputTokens).toBe(10);
    expect(body.usage.outputTokens).toBe(20);
    expect(body.usage.totalTokens).toBe(30);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('records usage metrics on successful completion', async () => {
    mockProjectFindFirst.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
    mockChatWithToolUse.mockResolvedValue({
      text: 'Response',
      toolCalls: [],
      stopReason: 'end_turn',
      resolvedModel: { modelId: 'test-model', provider: 'test-provider' },
      usage: { inputTokens: 5, outputTokens: 15 },
    });

    await request('POST', '/api/v1/chat/complete', { body: VALID_CHAT_BODY });

    expect(mockMetricsRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: VALID_CHAT_BODY.projectId,
        inputTokens: 5,
        outputTokens: 15,
        totalTokens: 20,
        streamingUsed: false,
      }),
    );
  });
});

// =============================================================================
// GET /api/v1/chat/usage
// =============================================================================

describe('GET /api/v1/chat/usage', () => {
  test('returns 400 when projectId is missing', async () => {
    const { status, body } = await request('GET', '/api/v1/chat/usage');

    expect(status).toBe(400);
    expect(body.error).toContain('projectId required');
  });

  test('returns 404 when project not found', async () => {
    mockProjectFindFirst.mockResolvedValue(null);

    const { status, body } = await request('GET', '/api/v1/chat/usage?projectId=proj-1');

    expect(status).toBe(404);
    expect(body.error).toEqual(
      expect.objectContaining({
        code: 'PROJECT_NOT_FOUND',
        message: expect.stringContaining('Project not found'),
      }),
    );
  });

  test('returns usage summary on success', async () => {
    mockProjectFindFirst.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
    mockMetricsGetUsage.mockResolvedValue({ totalTokens: 1000, totalCost: 0.05 });
    mockMetricsGetCostBreakdown.mockResolvedValue([]);

    const { status, body } = await request('GET', '/api/v1/chat/usage?projectId=proj-1');

    expect(status).toBe(200);
    expect(body.summary).toEqual({ totalTokens: 1000, totalCost: 0.05 });
    expect(body.byModel).toEqual([]);
  });
});

// =============================================================================
// POST /api/v1/chat/session
// =============================================================================

describe('POST /api/v1/chat/session', () => {
  test('prefers project.entryAgentName when creating a pre-initialized legacy session', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      entryAgentName: 'support_agent',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
        {
          name: 'support_agent',
          dslContent: 'AGENT support_agent\n  GOAL: Support',
          createdAt: new Date(),
        },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-session-create-1',
      agentName: 'support_agent',
      currentFlowStep: null,
    });

    const { status, body } = await request('POST', '/api/v1/chat/session', {
      body: { projectId: 'proj-1' },
    });

    expect(status).toBe(201);
    expect(body).toEqual({
      sessionId: 'rt-session-create-1',
      agentName: 'support_agent',
      status: 'ready',
    });
    expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      entryAgentName: 'support_agent',
      agents: [
        {
          name: 'greeting',
          dslContent: 'AGENT greeting\n  GOAL: Help',
          systemPromptLibraryRef: null,
        },
        {
          name: 'support_agent',
          dslContent: 'AGENT support_agent\n  GOAL: Support',
          systemPromptLibraryRef: null,
        },
      ],
    });
    expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelType: 'api',
      }),
    );
  });

  test('releases the pre-claimed quota slot when required production scope validation fails', async () => {
    injectedTenantContext = {
      tenantId: 'tenant-1',
      userId: 'sdk-session-1',
      role: 'sdk_session',
      permissions: ['project:*', 'session:*'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-1',
      projectScope: ['proj-1'],
      channelId: 'channel-1',
      contactId: undefined,
      identityTier: 2,
      verificationMethod: 'hmac',
      authScope: 'user',
      verifiedUserId: 'customer-1',
      channelArtifact: 'artifact-hash-1',
    };

    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    const { status, body } = await request('POST', '/api/v1/chat/session', {
      body: { projectId: 'proj-1' },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'INVALID_SESSION_SCOPE',
        message: 'Invalid production session scope.',
      },
    });
    expect(mockExecutor.checkSessionQuota).toHaveBeenCalledTimes(1);
    expect(mockExecutor.releaseSessionSlot).toHaveBeenCalledWith('tenant-1', expect.any(String));
    expect(mockExecutor.createSessionFromResolved).not.toHaveBeenCalled();
  });

  test('uses DeploymentResolver and persists deployment context for pre-initialized sessions', async () => {
    mockResolve.mockResolvedValue({
      entryAgent: 'support_agent',
      agents: { support_agent: { name: 'support_agent' } },
      compilationOutput: {},
      versionInfo: {
        environment: 'production',
        versions: { support_agent: '2.1.0' },
      },
    });
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'deploy-session-create-1',
      agentName: 'support_agent',
      currentFlowStep: null,
    });

    const { status, body } = await request('POST', '/api/v1/chat/session', {
      body: { projectId: 'proj-1', deploymentId: 'deploy-1' },
    });

    expect(status).toBe(201);
    expect(body).toEqual({
      sessionId: 'deploy-session-create-1',
      agentName: 'support_agent',
      status: 'ready',
    });
    expect(mockResolve).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      deploymentId: 'deploy-1',
      environment: undefined,
    });
    expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelType: 'http',
        deploymentId: 'deploy-1',
      }),
    );
    expect(mockConvStoreCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentVersion: '2.1.0',
        deploymentId: 'deploy-1',
        environment: 'production',
      }),
    );
  });

  test('uses DeploymentResolver when environment is provided for pre-initialized sessions', async () => {
    mockResolve.mockResolvedValue({
      entryAgent: 'support_agent',
      agents: { support_agent: { name: 'support_agent' } },
      compilationOutput: {},
      versionInfo: {
        environment: 'staging',
        versions: { support_agent: '2.1.0' },
      },
    });
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'deploy-session-create-2',
      agentName: 'support_agent',
      currentFlowStep: null,
    });

    const { status } = await request('POST', '/api/v1/chat/session', {
      body: { projectId: 'proj-1', environment: 'staging' },
    });

    expect(status).toBe(201);
    expect(mockResolve).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      deploymentId: undefined,
      environment: 'staging',
    });
    expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelType: 'http',
      }),
    );
  });
});

// =============================================================================
// POST /api/v1/chat/agent — LEGACY PATH
// =============================================================================

describe('POST /api/v1/chat/agent (legacy path)', () => {
  test('returns 400 on invalid request body', async () => {
    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1' }, // missing message
    });

    expect(status).toBe(400);
    expect(body.error).toContain('Invalid request');
  });

  test('returns 503 when runtime is not configured', async () => {
    mockExecutor.isConfigured.mockReturnValue(false);

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(503);
    expect(body.error).toContain('Runtime not configured');
  });

  test('returns 404 when project has no agents (legacy path)', async () => {
    mockProjectFindFirst.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1', agents: [] });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(404);
    expect(body.error).toContain('not found or has no agents');
  });

  test('creates session and executes message (legacy path)', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-1',
      agentName: 'greeting',
      currentFlowStep: null,
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Hello! How can I help?',
      action: { type: 'continue' },
      stateUpdates: { greetingDone: true },
    });

    mockExecutor.getSession.mockReturnValue({ state: {} });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-sess-1');
    expect(body.response).toBe('Hello! How can I help?');
    expect(body.action.type).toBe('continue');
    expect(body).not.toHaveProperty('state');
    expect(body).not.toHaveProperty('traceEvents');
    expect(body).not.toHaveProperty('traceContext');
    expect(body.outcome).toEqual({
      status: 'ok',
      usedFallback: false,
    });
  });

  test('accepts multipart file upload and forwards uploaded attachment IDs to execution', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-upload',
      agentName: 'greeting',
      currentFlowStep: null,
      state: {},
    });
    mockExecutor.getSession.mockReturnValue({ state: {} });
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'I can review that document.',
      action: { type: 'continue' },
      stateUpdates: {},
    });

    const form = new FormData();
    form.append('projectId', 'proj-1');
    form.append('message', 'Analyze this document');
    form.append('metadata', JSON.stringify({ customerId: 'customer-1' }));
    form.append(
      'file',
      new Blob([new Uint8Array(Buffer.from('hello document'))], { type: 'text/plain' }),
      'note.txt',
    );

    const { status, body } = await requestMultipart('/api/v1/chat/agent', form);

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-sess-upload');
    expect(mockAttachmentUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'note.txt',
        mimeType: 'text/plain',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        sessionId: 'rt-sess-upload',
        channel: 'api',
      }),
    );
    expect(mockExecutor.executeMessage).toHaveBeenCalledWith(
      'rt-sess-upload',
      'Analyze this document',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        attachmentIds: ['uploaded-attachment-1'],
        messageMetadata: expect.objectContaining({ customerId: 'customer-1' }),
        channelMetadata: expect.objectContaining({
          hasAttachments: true,
          attachmentCount: 1,
        }),
      }),
    );
  });

  test('rejects multipart upload when project max files per session is exceeded', async () => {
    mockResolveAttachmentConfig.mockResolvedValue({
      enabled: true,
      maxFileSizeBytes: 1024 * 1024,
      maxFilesPerSession: 1,
      allowedMimeTypes: [],
    });
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-upload',
      agentName: 'greeting',
      currentFlowStep: null,
      state: {},
    });
    mockExecutor.getSession.mockReturnValue({ state: {} });

    const form = new FormData();
    form.append('projectId', 'proj-1');
    form.append('message', 'Analyze these documents');
    form.append('file', new Blob(['first'], { type: 'text/plain' }), 'first.txt');
    form.append('file', new Blob(['second'], { type: 'text/plain' }), 'second.txt');

    const { status, body } = await requestMultipart('/api/v1/chat/agent', form);

    expect(status).toBe(413);
    expect(body.details).toEqual(
      expect.objectContaining({
        code: 'TOO_MANY_FILES',
        message: 'At most 1 files can be uploaded per session',
      }),
    );
    expect(mockAttachmentUpload).not.toHaveBeenCalled();
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  test('counts provided attachmentIds against multipart project max files per session', async () => {
    mockResolveAttachmentConfig.mockResolvedValue({
      enabled: true,
      maxFileSizeBytes: 1024 * 1024,
      maxFilesPerSession: 1,
      allowedMimeTypes: [],
    });
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-upload',
      agentName: 'greeting',
      currentFlowStep: null,
      state: {},
    });
    mockExecutor.getSession.mockReturnValue({ state: {} });

    const form = new FormData();
    form.append('projectId', 'proj-1');
    form.append('message', 'Analyze this document');
    form.append('attachmentIds', 'existing-attachment-1');
    form.append('file', new Blob(['new'], { type: 'text/plain' }), 'new.txt');

    const { status, body } = await requestMultipart('/api/v1/chat/agent', form);

    expect(status).toBe(413);
    expect(body.details).toEqual(
      expect.objectContaining({
        code: 'TOO_MANY_FILES',
        message: 'At most 1 files can be uploaded per session',
      }),
    );
    expect(mockAttachmentUpload).not.toHaveBeenCalled();
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  test('cleans up already uploaded multipart files when a later upload fails', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-upload',
      agentName: 'greeting',
      currentFlowStep: null,
      state: {},
    });
    mockExecutor.getSession.mockReturnValue({ state: {} });
    mockAttachmentUpload
      .mockResolvedValueOnce({
        success: true,
        attachmentId: 'uploaded-attachment-1',
        status: 'processing',
      })
      .mockResolvedValueOnce({
        success: false,
        error: {
          code: 'UPLOAD_FAILED',
          message: 'second upload failed',
        },
      });

    const form = new FormData();
    form.append('projectId', 'proj-1');
    form.append('message', 'Analyze these documents');
    form.append('file', new Blob(['first'], { type: 'text/plain' }), 'first.txt');
    form.append('file', new Blob(['second'], { type: 'text/plain' }), 'second.txt');

    const { status, body } = await requestMultipart('/api/v1/chat/agent', form);

    expect(status).toBe(502);
    expect(body.details).toEqual(
      expect.objectContaining({
        code: 'UPLOAD_FAILED',
        message: 'second upload failed',
      }),
    );
    expect(mockAttachmentDelete).toHaveBeenCalledWith('uploaded-attachment-1', 'tenant-1');
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  test('does not upload multipart files when auth preflight short-circuits execution', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-upload',
      agentName: 'greeting',
      currentFlowStep: null,
      state: {},
      compilationOutput: { agents: {} },
    });
    mockExecutor.getSession.mockReturnValue({
      state: {},
      compilationOutput: { agents: {} },
    });
    mockEvaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [
        {
          connector: 'google_drive',
          authProfileRef: 'google_drive_auth',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    const form = new FormData();
    form.append('projectId', 'proj-1');
    form.append('message', 'Analyze this document');
    form.append('file', new Blob(['contents'], { type: 'text/plain' }), 'note.txt');

    const { status, body } = await requestMultipart('/api/v1/chat/agent', form);

    expect(status).toBe(200);
    expect(body.action.type).toBe('auth_required');
    expect(mockAttachmentUpload).not.toHaveBeenCalled();
    expect(mockAttachmentDelete).not.toHaveBeenCalled();
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  test('cleans up uploaded multipart files when execution fails after upload', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-upload',
      agentName: 'greeting',
      currentFlowStep: null,
      state: {},
    });
    mockExecutor.getSession.mockReturnValue({
      state: {},
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
    });
    mockExecutor.executeMessage.mockRejectedValue(new Error('Exploded during execution'));

    const form = new FormData();
    form.append('projectId', 'proj-1');
    form.append('message', 'Analyze this document');
    form.append('file', new Blob(['contents'], { type: 'text/plain' }), 'note.txt');

    const { status } = await requestMultipart('/api/v1/chat/agent', form);

    expect(status).toBe(500);
    expect(mockAttachmentUpload).toHaveBeenCalledOnce();
    expect(mockAttachmentDelete).toHaveBeenCalledWith('uploaded-attachment-1', 'tenant-1');
  });

  test('includes state and inline traces only when HTTP chat debug is requested', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    const runtimeSession = {
      id: 'rt-sess-debug',
      agentName: 'greeting',
      currentFlowStep: null,
      state: { gatherProgress: { step: 'debug' }, context: { _raw_input: 'sensitive-ish' } },
    };
    mockExecutor.createSessionFromResolved.mockReturnValue(runtimeSession);
    mockExecutor.getSession.mockReturnValue(runtimeSession);
    mockExecutor.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _message: string,
        _onChunk: (chunk: string) => void,
        onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onTraceEvent({
          type: 'tool_call',
          data: {
            response: 'Email jane.doe@example.com',
            requestHeaders: { authorization: 'Bearer internal-secret-token' },
          },
        });
        return {
          response: 'Debug response',
          action: { type: 'continue' },
          stateUpdates: runtimeSession.state,
        };
      },
    );

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', debug: true },
    });

    const serializedTraceEvents = JSON.stringify(body.traceEvents);
    expect(status).toBe(200);
    expect(body.state).toEqual(runtimeSession.state);
    expect(body.traceContext).toEqual({
      sessionId: 'rt-sess-debug',
      delivery: 'inline',
    });
    expect(serializedTraceEvents).toContain('[REDACTED_EMAIL]');
    expect(serializedTraceEvents).not.toContain('jane.doe@example.com');
    expect(serializedTraceEvents).not.toContain('internal-secret-token');
  });

  test.each([
    ['debug query flag', '/api/v1/chat/agent?debug=1'],
    ['verbose query flag', '/api/v1/chat/agent?verbose=true'],
  ])('includes state and inline traces when HTTP chat %s is requested', async (_name, path) => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    const runtimeSession = {
      id: 'rt-sess-query-debug',
      agentName: 'greeting',
      currentFlowStep: null,
      state: { queryDebug: true },
    };
    mockExecutor.createSessionFromResolved.mockReturnValue(runtimeSession);
    mockExecutor.getSession.mockReturnValue(runtimeSession);
    mockExecutor.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _message: string,
        _onChunk: (chunk: string) => void,
        onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onTraceEvent({
          type: 'agent_decision',
          data: { reason: 'query debug requested' },
        });
        return {
          response: 'Debug response',
          action: { type: 'continue' },
          stateUpdates: runtimeSession.state,
        };
      },
    );

    const { status, body } = await request('POST', path, {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(body.state).toEqual(runtimeSession.state);
    expect(body.traceEvents).toEqual([
      expect.objectContaining({
        type: 'agent_decision',
        data: { reason: 'query debug requested' },
      }),
    ]);
    expect(body.traceContext).toEqual({
      sessionId: 'rt-sess-query-debug',
      delivery: 'inline',
    });
  });

  test('renders inline trace events through the PII read boundary', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    const runtimeSession = {
      id: 'rt-sess-traces',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentName: 'greeting',
      currentFlowStep: null,
      state: {},
    };
    mockExecutor.createSessionFromResolved.mockReturnValue(runtimeSession);
    mockExecutor.getSession.mockReturnValue(runtimeSession);
    mockExecutor.executeMessage.mockImplementation(
      async (
        _sessionId: string,
        _message: string,
        onChunk: (chunk: string) => void,
        onTraceEvent: (event: { type: string; data: Record<string, unknown> }) => void,
      ) => {
        onChunk('safe response');
        onTraceEvent({
          type: 'tool_call',
          data: {
            response: 'Email jane.doe@example.com',
            requestHeaders: { authorization: 'Bearer internal-secret-token' },
          },
        });
        return { response: '', action: { type: 'continue' } };
      },
    );

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', debug: true },
    });

    const serializedTraceEvents = JSON.stringify(body.traceEvents);
    expect(status).toBe(200);
    expect(serializedTraceEvents).toContain('[REDACTED_EMAIL]');
    expect(serializedTraceEvents).not.toContain('jane.doe@example.com');
    expect(serializedTraceEvents).not.toContain('internal-secret-token');
  });

  test('blocks working-copy chat before compile when execution readiness fails', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        {
          name: 'greeting',
          dslContent: 'AGENT greeting\n  GOAL: Help',
          dslValidationStatus: 'valid',
        },
      ],
    });
    mockFindProjectRuntimeConfig.mockResolvedValue({
      extraction: { nlu_provider: 'advanced' },
    });
    mockEvaluateProjectExecutionReadiness.mockResolvedValue({
      executableAgents: [],
      blockedAgents: [],
      hasBlockingErrors: true,
      issues: [{ kind: 'runtime_config', diagnostics: [] }],
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(422);
    expect(body).toEqual({
      error:
        'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
      issues: [{ kind: 'runtime_config', diagnostics: [] }],
    });
    expect(mockFindProjectRuntimeConfig).toHaveBeenCalledWith('proj-1', 'tenant-1');
    expect(mockCompileProjectWorkingCopy).not.toHaveBeenCalled();
    expect(mockExecutor.createSessionFromResolved).not.toHaveBeenCalled();
  });

  test('applies testContext session variables to new HTTP agent sessions', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    const runtimeSession: any = {
      id: 'rt-sess-session-vars',
      agentName: 'greeting',
      agentIR: null,
      compilationOutput: null,
      conversationHistory: [],
      state: {},
      data: { values: {}, gatheredKeys: new Set<string>() },
      isComplete: false,
      isEscalated: false,
      handoffStack: [],
      delegateStack: [],
      threads: [],
      activeThreadIndex: 0,
      initialized: false,
      currentFlowStep: null,
    };

    mockExecutor.createSessionFromResolved.mockReturnValue(runtimeSession);
    mockExecutor.getSession.mockReturnValue(runtimeSession);
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Variables received',
      action: { type: 'continue' },
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: {
        projectId: 'proj-1',
        message: 'Hello',
        debug: true,
        testContext: {
          sessionVariables: {
            consumer_id: 'consumer-123',
            contract_id: 'contract-456',
          },
        },
      },
    });

    expect(status).toBe(200);
    expect(runtimeSession.data.values).toMatchObject({
      consumer_id: 'consumer-123',
      contract_id: 'contract-456',
    });
    expect(runtimeSession.data.gatheredKeys.size).toBe(0);
    expect(body.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'engine_decision',
          data: expect.objectContaining({
            decision: 'context_injection',
            source: 'http_test_context',
            keys: ['consumer_id', 'contract_id'],
          }),
        }),
      ]),
    );
  });

  test('prefers project.entryAgentName over the first agent in project order', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      entryAgentName: 'support_agent',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
        {
          name: 'support_agent',
          dslContent: 'AGENT support_agent\n  GOAL: Support',
          createdAt: new Date(),
        },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-entry-agent',
      agentName: 'support_agent',
      currentFlowStep: null,
    });
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Support path',
      action: { type: 'continue' },
    });
    mockExecutor.getSession.mockReturnValue({ state: {} });

    const { status } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      entryAgentName: 'support_agent',
      agents: [
        {
          name: 'greeting',
          dslContent: 'AGENT greeting\n  GOAL: Help',
          systemPromptLibraryRef: null,
        },
        {
          name: 'support_agent',
          dslContent: 'AGENT support_agent\n  GOAL: Support',
          systemPromptLibraryRef: null,
        },
      ],
    });
  });

  test('summarizes channel-native rich content for sync chat responses without plain text', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-channel-native',
      agentName: 'greeting',
      currentFlowStep: null,
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: '',
      action: { type: 'continue' },
      richContent: {
        whatsapp:
          '{"type":"interactive","body":{"text":"Choose an option"},"action":{"buttons":[{"reply":{"id":"yes","title":"Yes"}}]}}',
      },
    });

    mockExecutor.getSession.mockReturnValue({ state: {} });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-sess-channel-native');
    expect(body.response).toContain('Choose an option');
    expect(body.richContent).toEqual(
      expect.objectContaining({
        whatsapp: expect.stringContaining('Choose an option'),
      }),
    );
    expect(body.outcome).toEqual({
      status: 'ok',
      usedFallback: true,
    });
  });

  test('uses scoped persistence for sdk_session chat when canonical contact scope is available', async () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'mixed' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };

    injectedTenantContext = {
      tenantId: 'tenant-1',
      userId: 'sdk-session-1',
      role: 'sdk_session',
      permissions: ['project:*', 'session:*'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-1',
      projectScope: ['proj-1'],
      channelId: 'channel-1',
      contactId: 'contact-http-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      authScope: 'user',
      verifiedUserId: 'customer-1',
      channelArtifact: 'artifact-hash-1',
    };

    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-http-scope-1',
      agentName: 'greeting',
      currentFlowStep: null,
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Hello from HTTP scope',
      action: { type: 'continue' },
      responseMetadata,
    });

    mockExecutor.getSession.mockReturnValue({
      state: {},
      versionInfo: { environment: 'dev', versions: {} },
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-http-scope-1');
    expect(body.responseMetadata).toEqual(responseMetadata);
    expect(mockExecutor.createSessionFromResolved).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          subject: { kind: 'contact', contactId: 'contact-http-1' },
        }),
      }),
    );
    expect(mockPersistScopedMessage).toHaveBeenCalledTimes(2);
    expect(mockPersistScopedTurnMetrics).toHaveBeenCalledTimes(1);
    expect(mockPersistMessage).not.toHaveBeenCalled();
    expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        scope: expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channelId: 'channel-1',
          environment: 'dev',
          authType: 'sdk_session',
          subject: { kind: 'contact', contactId: 'contact-http-1' },
        }),
        message: expect.objectContaining({
          dbSessionId: 'db-sess-1',
          role: 'user',
          content: 'Hello',
          channel: 'api',
        }),
      }),
    );
    expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        scope: expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channelId: 'channel-1',
          environment: 'dev',
          authType: 'sdk_session',
          subject: { kind: 'contact', contactId: 'contact-http-1' },
        }),
        message: expect.objectContaining({
          dbSessionId: 'db-sess-1',
          role: 'assistant',
          content: 'Hello from HTTP scope',
          channel: 'api',
          metadata: responseMetadata,
        }),
      }),
    );
    expect(mockPersistScopedTurnMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          subject: { kind: 'contact', contactId: 'contact-http-1' },
        }),
        metrics: expect.objectContaining({
          dbSessionId: 'db-sess-1',
        }),
      }),
    );
  });

  test('persists structured-only HTTP chat assistant replies when scoped contact metadata is available', async () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };
    const localization = {
      domain: 'project' as const,
      locale: 'en-US',
      messageKey: 'assistant.http_choices',
      catalogId: 'catalog-v1',
    };

    injectedTenantContext = {
      tenantId: 'tenant-1',
      userId: 'sdk-session-1',
      role: 'sdk_session',
      permissions: ['project:*', 'session:*'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-1',
      projectScope: ['proj-1'],
      channelId: 'channel-1',
      contactId: 'contact-http-1',
      identityTier: 2,
      verificationMethod: 'hmac',
      authScope: 'user',
      verifiedUserId: 'customer-1',
      channelArtifact: 'artifact-hash-1',
    };

    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-http-structured-1',
      agentName: 'greeting',
      currentFlowStep: null,
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: '',
      action: { type: 'continue' },
      richContent: { markdown: '**HTTP choices**' },
      actions: { elements: [{ id: 'http-next', type: 'button', label: 'Next' }] },
      voiceConfig: { plain_text: 'HTTP choices' },
      localization,
      responseMetadata,
    });

    mockExecutor.getSession.mockReturnValue({
      state: {},
      versionInfo: { environment: 'dev', versions: {} },
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Show choices' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-http-structured-1');
    expect(body.response).toBe('');
    expect(body.richContent).toEqual({ markdown: '**HTTP choices**' });
    expect(body.actions).toEqual({
      elements: [{ id: 'http-next', type: 'button', label: 'Next' }],
    });
    expect(body.voiceConfig).toEqual({ plain_text: 'HTTP choices' });
    expect(body.localization).toEqual(localization);
    expect(body.responseMetadata).toEqual(responseMetadata);

    expect(mockPersistScopedMessage).toHaveBeenCalledTimes(2);
    expect(mockPersistScopedMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        scope: expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          channelId: 'channel-1',
          subject: { kind: 'contact', contactId: 'contact-http-1' },
        }),
        message: {
          dbSessionId: 'db-sess-1',
          role: 'assistant',
          content: '',
          structuredContent: {
            richContent: { markdown: '**HTTP choices**' },
            actions: { elements: [{ id: 'http-next', type: 'button', label: 'Next' }] },
            voiceConfig: { plain_text: 'HTTP choices' },
            localization,
          },
          channel: 'api',
          metadata: responseMetadata,
        },
      }),
    );
  });

  test('backfills canonical contact identity onto existing HTTP chat sessions', async () => {
    injectedTenantContext = {
      tenantId: 'tenant-1',
      userId: 'sdk-session-legacy-1',
      role: 'sdk_session',
      permissions: ['project:*', 'session:*'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-1',
      projectScope: ['proj-1'],
      channelId: 'channel-1',
      contactId: undefined,
      identityTier: 2,
      verificationMethod: 'hmac',
      authScope: 'user',
      verifiedUserId: 'customer-1',
      channelArtifact: 'artifact-hash-1',
    };

    const existingSession = {
      id: 'rt-http-existing-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'sdk-session-legacy-1',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'sdk_http',
        channelId: 'channel-1',
        customerId: 'customer-1',
        anonymousId: 'sdk-session-legacy-1',
        sessionPrincipalId: 'sdk-session-legacy-1',
        authScope: 'user',
        identityTier: 2,
        verificationMethod: 'hmac',
        channelArtifact: 'artifact-hash-1',
      },
      data: {
        values: {
          user_id: 'sdk-session-legacy-1',
          session: {
            channel: 'api',
            sessionId: 'rt-http-existing-1',
            userId: 'sdk-session-legacy-1',
          },
        },
        gatheredKeys: new Set(),
      },
      state: {},
      versionInfo: { environment: 'dev', versions: {} },
    };

    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });
    mockExecutor.getSession.mockImplementation((sessionId: string) =>
      sessionId === 'rt-http-existing-1' ? existingSession : undefined,
    );
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Existing session updated',
      action: { type: 'continue' },
    });
    mockFindSessionById.mockResolvedValue({
      id: 'rt-http-existing-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      contactId: undefined,
      environment: 'dev',
      initiatedById: 'user-1',
    });
    mockResolveCanonicalContactForProductionScope.mockResolvedValue({
      contactId: 'contact-http-42',
      displayName: 'Verified Contact',
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: {
        projectId: 'proj-1',
        sessionId: 'rt-http-existing-1',
        message: 'Resume this chat',
      },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-http-existing-1');
    expect(existingSession.callerContext).toEqual(
      expect.objectContaining({
        contactId: 'contact-http-42',
        contactDisplayName: 'Verified Contact',
      }),
    );
    expect(existingSession.userId).toBe('contact-http-42');
    expect(existingSession.data.values.user_id).toBe('contact-http-42');
    expect(existingSession.data.values.session.userId).toBe('contact-http-42');
    expect(mockConvStoreLinkContact).toHaveBeenCalledWith('rt-http-existing-1', 'contact-http-42');
  });

  test('falls back to legacy persistence for user-auth chat routes without canonical contact scope', async () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };

    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-http-legacy-1',
      agentName: 'greeting',
      currentFlowStep: null,
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Legacy HTTP path',
      action: { type: 'continue' },
      responseMetadata,
    });

    mockExecutor.getSession.mockReturnValue({ state: {} });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-http-legacy-1');
    expect(body.responseMetadata).toEqual(responseMetadata);
    expect(mockPersistMessage).toHaveBeenCalledTimes(2);
    expect(mockPersistTurnMetrics).toHaveBeenCalledTimes(1);
    expect(mockPersistScopedMessage).not.toHaveBeenCalled();
    expect(mockPersistScopedTurnMetrics).not.toHaveBeenCalled();
    expect(mockPersistMessage).toHaveBeenNthCalledWith(
      2,
      'db-sess-1',
      'assistant',
      'Legacy HTTP path',
      'api',
      'tenant-1',
      undefined,
      undefined,
      'proj-1',
      undefined,
      undefined,
      responseMetadata,
    );
  });

  test('returns 413 when follow-up sessionMetadata would overflow merged session metadata', async () => {
    const existingSession = {
      id: 'rt-http-metadata-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'api',
        channelId: 'channel-1',
        contactId: 'contact-http-1',
        customerId: 'customer-1',
        anonymousId: 'sdk-session-1',
        sessionPrincipalId: 'sdk-session-1',
        authScope: 'user',
        identityTier: 2,
        verificationMethod: 'hmac',
        channelArtifact: 'artifact-hash-1',
      },
      data: {
        values: {
          _metadata: {
            existingBlob: 'x'.repeat(262_000),
          },
        },
        gatheredKeys: new Set(),
      },
      state: {},
      versionInfo: { environment: 'dev', versions: {} },
    };

    mockExecutor.getSession.mockImplementation((sessionId: string) =>
      sessionId === 'rt-http-metadata-1' ? existingSession : undefined,
    );
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'should not execute',
      action: { type: 'continue' },
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: {
        projectId: 'proj-1',
        sessionId: 'rt-http-metadata-1',
        debug: true,
        message: 'Resume this chat',
        sessionMetadata: {
          nextBlob: 'y'.repeat(1_000),
        },
      },
    });

    expect(status).toBe(413);
    expect(body).toEqual(
      expect.objectContaining({
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: expect.stringContaining('262144'),
        },
        sessionId: 'rt-http-metadata-1',
        traceContext: {
          sessionId: 'rt-http-metadata-1',
          delivery: 'inline',
        },
        traceEvents: expect.arrayContaining([
          {
            type: 'error',
            data: expect.objectContaining({
              code: 'PAYLOAD_TOO_LARGE',
            }),
          },
        ]),
      }),
    );
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  test('rejects sdk_session chat when canonical contact scope is required but incomplete', async () => {
    injectedTenantContext = {
      tenantId: 'tenant-1',
      userId: 'sdk-session-1',
      role: 'sdk_session',
      permissions: ['project:*', 'session:*'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-1',
      projectScope: ['proj-1'],
      channelId: 'channel-1',
      contactId: undefined,
      identityTier: 2,
      verificationMethod: 'hmac',
      authScope: 'user',
      verifiedUserId: 'customer-1',
      channelArtifact: 'artifact-hash-1',
    };

    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello' },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'INVALID_SESSION_SCOPE',
        message: 'Invalid production session scope.',
      },
    });
    expect(mockExecutor.createSessionFromResolved).not.toHaveBeenCalled();
  });

  test('forwards per-message metadata into runtime execution options', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-meta-1',
      agentName: 'greeting',
      currentFlowStep: null,
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Hello! How can I help?',
      action: { type: 'continue' },
    });

    mockExecutor.getSession.mockReturnValue({ state: {} });

    const metadata = {
      accountId: 'acct-123',
      context: { tier: 'gold' },
    };

    const { status } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', metadata },
    });

    expect(status).toBe(200);
    expect(mockExecutor.executeMessage).toHaveBeenCalledWith(
      'rt-sess-meta-1',
      'Hello',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        messageMetadata: metadata,
        channelMetadata: expect.objectContaining({
          channel: 'api',
          contentLength: 'Hello'.length,
        }),
      }),
    );
  });

  test('rejects invalid per-message metadata', async () => {
    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: {
        projectId: 'proj-1',
        message: 'Hello',
        metadata: {
          summary: 'x'.repeat(513),
        },
      },
    });

    expect(status).toBe(400);
    expect(body.error).toBe('Invalid message metadata');
    expect(body.details).toContain('metadata.summary exceeds max string length (512)');
    expect(mockExecutor.createSessionFromResolved).not.toHaveBeenCalled();
    expect(mockExecutor.executeMessage).not.toHaveBeenCalled();
  });

  test('records an inline trace and sanitized outcome for auth preflight short-circuits', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'greeting', dslContent: 'AGENT greeting\n  GOAL: Help', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-preflight-1',
      agentName: 'greeting',
      currentFlowStep: null,
      state: { stage: 'auth' },
      compilationOutput: { agents: {} },
    });
    mockExecutor.getSession.mockReturnValue({
      state: { stage: 'auth' },
      compilationOutput: { agents: {} },
    });
    mockEvaluateAuthPreflightFromIR.mockResolvedValue({
      pending: [
        {
          connector: 'google_drive',
          authProfileRef: 'google_drive_auth',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'hello', debug: true },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('rt-preflight-1');
    expect(body.action).toEqual({
      type: 'auth_required',
      pending: [
        {
          connector: 'google_drive',
          authProfileRef: 'google_drive_auth',
          connectionMode: 'per_user',
        },
      ],
      satisfied: [],
    });
    expect(body.traceContext).toEqual({
      sessionId: 'rt-preflight-1',
      delivery: 'inline',
    });
    expect(body.traceEvents).toEqual([
      {
        type: 'error',
        data: {
          code: 'AUTH_PREFLIGHT_REQUIRED',
          message: 'Authorization is required before the agent can continue: google_drive.',
          category: 'auth',
          source: 'channel_outcome',
        },
      },
    ]);
    expect(body.outcome).toEqual({
      status: 'auth_required',
      usedFallback: true,
      auth: {
        pending: [
          {
            connector: 'google_drive',
            authProfileRef: 'google_drive_auth',
            connectionMode: 'per_user',
          },
        ],
        satisfied: [],
      },
    });
  });

  test('adds trace context and synthetic trace events for queue-full failures', async () => {
    const queueFullError = new Error('Busy right now') as Error & { code?: string };
    queueFullError.code = 'QUEUE_FULL';

    mockExecutor.getSession.mockReturnValue({
      state: {},
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
    });
    mockExecutor.executeMessage.mockRejectedValue(queueFullError);

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: {
        projectId: 'proj-1',
        sessionId: 'existing-sess',
        message: 'Next message',
        debug: true,
      },
    });

    expect(status).toBe(429);
    expect(body.sessionId).toBe('existing-sess');
    expect(body.traceContext).toEqual({
      sessionId: 'existing-sess',
      delivery: 'inline',
    });
    expect(body.traceEvents).toEqual([
      expect.objectContaining({
        type: 'error',
        data: {
          code: 'QUEUE_FULL',
          message: 'Busy right now',
          category: 'execution',
          source: 'channel_outcome',
        },
      }),
    ]);
  });

  test('adds trace context to generic execution failures when a runtime session exists', async () => {
    mockExecutor.getSession.mockReturnValue({
      state: {},
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
    });
    mockExecutor.executeMessage.mockRejectedValue(new Error('Exploded during execution'));

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: {
        projectId: 'proj-1',
        sessionId: 'existing-sess',
        message: 'Next message',
        debug: true,
      },
    });

    expect(status).toBe(500);
    expect(body.sessionId).toBe('existing-sess');
    expect(body.traceContext).toEqual({
      sessionId: 'existing-sess',
      delivery: 'inline',
    });
    expect(body.traceEvents).toEqual([
      {
        type: 'error',
        data: {
          code: 'INTERNAL_ERROR',
          message: 'Exploded during execution',
          category: 'execution',
          source: 'channel_outcome',
        },
      },
    ]);
  });

  test('creates DB session for audit trail (legacy path)', async () => {
    mockProjectFindFirst.mockResolvedValue({
      id: 'proj-1',
      tenantId: 'tenant-1',
      agents: [
        { name: 'booking', dslContent: 'AGENT booking\n  GOAL: Book', createdAt: new Date() },
      ],
    });

    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'rt-sess-2',
      agentName: 'booking',
      currentFlowStep: null,
    });

    mockExecutor.executeMessage.mockResolvedValue({
      response: 'I can help you book.',
      action: { type: 'continue' },
    });

    mockExecutor.getSession.mockReturnValue({ state: {} });

    await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Book a table' },
    });

    expect(mockConvStoreCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'api',
        agentName: 'booking',
        agentVersion: '1.0',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      }),
    );
  });

  test('reuses existing session on subsequent messages', async () => {
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Continuing conversation.',
      action: { type: 'continue' },
    });

    // Session must satisfy tenant, project, and owner checks to pass resume access guards.
    mockExecutor.getSession.mockReturnValue({
      state: {},
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
    });

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', sessionId: 'existing-sess', message: 'Next message' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('existing-sess');
    // Should NOT create a new session
    expect(mockExecutor.createSessionFromResolved).not.toHaveBeenCalled();
  });

  test('skips async message persistence when an in-memory session has no confirmed Mongo row', async () => {
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'Continuing conversation.',
      action: { type: 'continue' },
    });
    mockExecutor.getSession.mockReturnValue({
      state: {},
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
    });
    mockFindSessionById.mockResolvedValue(null);

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', sessionId: 'existing-sess', message: 'Next message' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('existing-sess');
    expect(mockFindSessionById).toHaveBeenCalledWith('existing-sess', 'tenant-1');
    expect(mockPersistMessage).not.toHaveBeenCalled();
    expect(mockPersistTurnMetrics).not.toHaveBeenCalled();
  });

  test('returns 404 when resuming a session belonging to a different tenant', async () => {
    // In-memory path: getSession returns a session owned by a different tenant
    mockExecutor.getSession.mockReturnValue({ state: {}, tenantId: 'tenant-OTHER' });

    const { status } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', sessionId: 'cross-tenant-sess', message: 'Hello' },
    });

    expect(status).toBe(404);
  });

  test('returns 404 when session is not in memory and DB lookup finds nothing', async () => {
    // Session evicted from runtime memory; DB query returns null (tenant filter applied) → 404
    mockExecutor.getSession.mockReturnValue(null);
    mockFindSessionById.mockResolvedValue(null);

    const { status } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', sessionId: 'evicted-sess', message: 'Hello' },
    });

    expect(status).toBe(404);
  });
});

// =============================================================================
// POST /api/v1/chat/agent — DEPLOYMENT-AWARE PATH
// =============================================================================

describe('POST /api/v1/chat/agent (deployment path)', () => {
  const resolvedDeployment = {
    entryAgent: 'support_agent',
    agents: { support_agent: { name: 'support_agent' } },
    compilationOutput: {},
    versionInfo: {
      environment: 'production',
      versions: { support_agent: '2.1.0' },
    },
  };

  beforeEach(() => {
    mockResolve.mockResolvedValue(resolvedDeployment);
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'deploy-rt-sess',
      agentName: 'support_agent',
      currentFlowStep: null,
    });
    mockExecutor.executeMessage.mockResolvedValue({
      response: 'How can I help?',
      action: { type: 'continue' },
    });
    mockExecutor.getSession.mockReturnValue({ state: {} });
  });

  test('uses DeploymentResolver when deploymentId is provided', async () => {
    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', deploymentId: 'deploy-1' },
    });

    expect(status).toBe(200);
    expect(body.sessionId).toBe('deploy-rt-sess');
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
      }),
    );
  });

  test('uses DeploymentResolver when environment is provided', async () => {
    const { status } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', environment: 'staging' },
    });

    expect(status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        environment: 'staging',
      }),
    );
  });

  test('creates DB session with deployment context', async () => {
    await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', deploymentId: 'deploy-1' },
    });

    expect(mockConvStoreCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'api',
        agentName: 'support_agent',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        agentVersion: '2.1.0',
      }),
    );
  });

  test('returns 410 when deployment is retired', async () => {
    const retiredError = new Error('Deployment retired');
    (retiredError as any).statusCode = 410;
    mockResolve.mockRejectedValue(retiredError);

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', deploymentId: 'deploy-1' },
    });

    expect(status).toBe(410);
    expect(body.error).toContain('retired');
  });

  test('returns 500 when DeploymentResolver fails (non-410)', async () => {
    mockResolve.mockRejectedValue(new Error('Resolver internal error'));

    const { status, body } = await request('POST', '/api/v1/chat/agent', {
      body: { projectId: 'proj-1', message: 'Hello', deploymentId: 'deploy-1' },
    });

    expect(status).toBe(500);
    expect(body.error.message).toContain('Resolver internal error');
  });
});
