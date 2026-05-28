import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockGetActiveSessions = vi.fn();
const mockGetTransferSession = vi.fn();
const mockUpdateTransferSession = vi.fn();
const mockEndTransferSession = vi.fn();
const mockTerminateConversationSession = vi.fn();
const mockFindConversationSession = vi.fn();
const mockUpdateConversationSession = vi.fn();
const mockCleanupClosedSessionArtifacts = vi.fn();

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectMember: vi.fn().mockResolvedValue(null),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  resolveTenantMembership: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../repos/session-repo.js', () => ({
  findSessionById: (...args: any[]) => mockFindConversationSession(...args),
  updateSession: (...args: any[]) => mockUpdateConversationSession(...args),
}));

vi.mock('../services/agent-transfer/index.js', () => ({
  isAgentTransferInitialized: vi.fn(() => true),
  getTransferSessionStore: vi.fn(() => ({
    getActiveSessions: (...args: any[]) => mockGetActiveSessions(...args),
    get: (...args: any[]) => mockGetTransferSession(...args),
    update: (...args: any[]) => mockUpdateTransferSession(...args),
    getMany: vi.fn(async (keys: string[]) => {
      const results = [];
      for (const key of keys) {
        results.push(await mockGetTransferSession(key));
      }
      return results;
    }),
    end: (...args: any[]) => mockEndTransferSession(...args),
  })),
  getTransferTraceEmitter: vi.fn(() => null),
}));

vi.mock('../services/session-lifecycle/terminalization-service.js', () => ({
  SessionTerminalizationService: class MockSessionTerminalizationService {
    terminateConversationSession = (...args: any[]) => mockTerminateConversationSession(...args);
  },
  buildTransferEndMetadata: (...args: any[]) => ({
    source: args[0]?.source,
    disposition: args[0]?.disposition,
    endedAt: args[0]?.endedAt?.toISOString?.() ?? args[0]?.endedAt,
    ...(args[0]?.transferMetadata?.reason !== undefined
      ? { reason: args[0].transferMetadata.reason }
      : {}),
    ...(args[0]?.transferMetadata?.dispositionCode !== undefined
      ? { dispositionCode: args[0].transferMetadata.dispositionCode }
      : {}),
    ...(args[0]?.transferMetadata?.wrapUpNotes !== undefined
      ? { wrapUpNotes: args[0].transferMetadata.wrapUpNotes }
      : {}),
    ...(args[0]?.transferMetadata?.metadata !== undefined
      ? { details: args[0].transferMetadata.metadata }
      : {}),
  }),
}));

vi.mock('../services/session-lifecycle/artifact-cleanup.js', () => ({
  cleanupClosedSessionArtifacts: (...args: any[]) => mockCleanupClosedSessionArtifacts(...args),
}));

const TENANT_ID = 'tenant-A';
const PROJECT_ID = 'proj-1';
const OTHER_PROJECT_ID = 'proj-2';
const BASE = '/api/v1/agent-transfer/sessions';

function makeSdkContext() {
  return {
    tenantId: TENANT_ID,
    userId: 'sdk:webchat',
    authType: 'sdk_session',
    projectId: PROJECT_ID,
    permissions: ['connection:read', 'connection:write'],
    role: 'sdk_session',
    isSuperAdmin: false,
  };
}

function makeSession(
  projectId?: string,
  overrides: Partial<{
    agentId: string;
    metadata: Record<string, unknown>;
    postAgentConfig: { action: 'return' | 'end' };
  }> = {},
) {
  return {
    tenantId: TENANT_ID,
    projectId,
    contactId: 'contact-1',
    agentId: 'agent-1',
    provider: 'twilio',
    state: 'active',
    channel: 'sms',
    queue: 'default',
    skills: [],
    priority: 1,
    metadata: {},
    providerSessionId: 'provider-1',
    providerData: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: unknown },
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: options?.body
      ? {
          'Content-Type': 'application/json',
          ...(options?.headers ?? {}),
        }
      : options?.headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

describe('Agent transfer SDK project scope', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantContext = makeSdkContext() as any;
      req.user = { id: 'sdk:webchat', email: 'sdk@test.local' } as any;
      next();
    });

    const router = (await import('../routes/agent-transfer-sessions.js')).default;
    app.use(BASE, router);

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminateConversationSession.mockResolvedValue({
      sessionId: 'conversation-session-1',
      disposition: 'completed',
      status: 'completed',
      endedAt: new Date().toISOString(),
      eventEmitted: true,
      hook: { attempted: false },
      runtimeEnded: false,
      dbUpdated: true,
      artifactSessionIds: ['conversation-session-1'],
    });
    mockFindConversationSession.mockResolvedValue({
      id: 'conversation-session-1',
      projectId: PROJECT_ID,
    });
    mockUpdateConversationSession.mockResolvedValue({
      id: 'conversation-session-1',
    });
    mockCleanupClosedSessionArtifacts.mockResolvedValue(undefined);
  });

  test('lists only the SDK token project sessions when X-Project-Id is omitted', async () => {
    mockGetActiveSessions.mockResolvedValue(['session-own', 'session-other']);
    mockGetTransferSession.mockImplementation(async (sessionKey: string) => {
      if (sessionKey === 'session-own') {
        return makeSession(PROJECT_ID);
      }
      if (sessionKey === 'session-other') {
        return makeSession(OTHER_PROJECT_ID);
      }
      return null;
    });

    const { status, body } = await request(baseUrl, 'GET', BASE);

    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('session-own');
    expect(mockGetActiveSessions).toHaveBeenCalledWith(TENANT_ID);
  });

  test('cannot end another project session when X-Project-Id is omitted', async () => {
    mockGetTransferSession.mockResolvedValue(makeSession(OTHER_PROJECT_ID));
    mockUpdateTransferSession.mockResolvedValue(true);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-other/end`);

    expect(status).toBe(404);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
    expect(mockEndTransferSession).not.toHaveBeenCalled();
  });

  test('cannot end a projectless session when SDK project scope is implicit', async () => {
    mockGetTransferSession.mockResolvedValue(makeSession());
    mockUpdateTransferSession.mockResolvedValue(true);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-legacy/end`);

    expect(status).toBe(404);
    expect(body.error.code).toBe('SESSION_NOT_FOUND');
    expect(mockEndTransferSession).not.toHaveBeenCalled();
  });

  test('persists structured end metadata before ending an in-scope session', async () => {
    mockGetTransferSession.mockResolvedValue(makeSession(PROJECT_ID));
    mockUpdateTransferSession.mockResolvedValue(true);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-own/end`, {
      body: {
        reason: 'agent_completed',
        dispositionCode: 'resolved',
        wrapUpNotes: 'Customer confirmed the fix.',
        metadata: {
          surveyCompleted: true,
        },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockUpdateTransferSession).toHaveBeenCalledWith(
      'session-own',
      expect.objectContaining({
        dispositionCode: 'resolved',
        wrapUpNotes: 'Customer confirmed the fix.',
        metadata: expect.objectContaining({
          endSource: 'api',
          endReason: 'agent_completed',
          endMetadata: {
            surveyCompleted: true,
          },
        }),
      }),
    );
    expect(mockUpdateTransferSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockEndTransferSession.mock.invocationCallOrder[0],
    );
    expect(mockEndTransferSession).toHaveBeenCalledWith('session-own');
  });

  test('returns 500 and preserves the session when structured metadata persistence fails', async () => {
    mockGetTransferSession.mockResolvedValue(makeSession(PROJECT_ID));
    mockUpdateTransferSession.mockResolvedValue(false);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-own/end`, {
      body: {
        dispositionCode: 'resolved',
      },
    });

    expect(status).toBe(500);
    expect(body.error.code).toBe('UPDATE_FAILED');
    expect(mockEndTransferSession).not.toHaveBeenCalled();
  });

  test('terminalizes the parent conversation before ending when post-agent action is end', async () => {
    mockGetTransferSession.mockResolvedValue(
      makeSession(PROJECT_ID, {
        metadata: {
          postAgentAction: 'end',
          conversationSessionId: 'conversation-session-1',
        },
      }),
    );
    mockUpdateTransferSession.mockResolvedValue(true);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-own/end`, {
      body: {
        reason: 'completed',
        dispositionCode: 'resolved',
        wrapUpNotes: 'Customer confirmed the fix.',
        metadata: {
          surveyCompleted: true,
        },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockTerminateConversationSession).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sessionId: 'conversation-session-1',
      agentName: 'agent-1',
      disposition: 'completed',
      source: 'transfer_end',
      transferMetadata: {
        reason: 'completed',
        dispositionCode: 'resolved',
        wrapUpNotes: 'Customer confirmed the fix.',
        metadata: {
          surveyCompleted: true,
        },
      },
    });
    expect(mockUpdateTransferSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockTerminateConversationSession.mock.invocationCallOrder[0],
    );
    expect(mockTerminateConversationSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockEndTransferSession.mock.invocationCallOrder[0],
    );
    expect(mockCleanupClosedSessionArtifacts).toHaveBeenCalledWith(['conversation-session-1']);
  });

  test('persists structured metadata to the parent conversation when post-agent action returns control to the bot', async () => {
    mockGetTransferSession.mockResolvedValue(
      makeSession(PROJECT_ID, {
        postAgentConfig: { action: 'return' },
        metadata: {
          conversationSessionId: 'conversation-session-1',
        },
      }),
    );
    mockUpdateTransferSession.mockResolvedValue(true);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-own/end`, {
      body: {
        dispositionCode: 'resolved',
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockTerminateConversationSession).not.toHaveBeenCalled();
    expect(mockFindConversationSession).toHaveBeenCalledWith('conversation-session-1', TENANT_ID);
    expect(mockUpdateConversationSession).toHaveBeenCalledWith(
      'conversation-session-1',
      expect.objectContaining({
        dispositionCode: 'resolved',
        'metadata.transferEnd': expect.objectContaining({
          source: 'transfer_end',
          disposition: 'completed',
          dispositionCode: 'resolved',
        }),
      }),
      TENANT_ID,
    );
    expect(mockUpdateTransferSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateConversationSession.mock.invocationCallOrder[0],
    );
    expect(mockUpdateConversationSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockEndTransferSession.mock.invocationCallOrder[0],
    );
    expect(mockEndTransferSession).toHaveBeenCalledWith('session-own');
  });

  test('returns 500 and preserves the transfer session when parent metadata persistence fails', async () => {
    mockGetTransferSession.mockResolvedValue(
      makeSession(PROJECT_ID, {
        postAgentConfig: { action: 'return' },
        metadata: {
          conversationSessionId: 'conversation-session-1',
        },
      }),
    );
    mockUpdateTransferSession.mockResolvedValue(true);
    mockFindConversationSession.mockResolvedValue(null);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-own/end`, {
      body: {
        dispositionCode: 'resolved',
      },
    });

    expect(status).toBe(500);
    expect(body.error.code).toBe('PARENT_METADATA_PERSIST_FAILED');
    expect(mockEndTransferSession).not.toHaveBeenCalled();
  });

  test('returns 500 and preserves the transfer session when parent terminalization fails', async () => {
    mockGetTransferSession.mockResolvedValue(
      makeSession(PROJECT_ID, {
        metadata: {
          postAgentAction: 'end',
          conversationSessionId: 'conversation-session-1',
        },
      }),
    );
    mockUpdateTransferSession.mockResolvedValue(true);
    mockTerminateConversationSession.mockResolvedValue(null);
    mockEndTransferSession.mockResolvedValue(true);

    const { status, body } = await request(baseUrl, 'POST', `${BASE}/session-own/end`);

    expect(status).toBe(500);
    expect(body.error.code).toBe('PARENT_TERMINALIZATION_FAILED');
    expect(mockEndTransferSession).not.toHaveBeenCalled();
  });
});
