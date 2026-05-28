/**
 * End-to-End User Isolation Integration Test
 *
 * Verifies complete user isolation for SDK-authenticated users across all
 * resource types: sessions, messages, and attachments.
 *
 * Two SDK users (User A: customerId='cust-A', User B: customerId='cust-B')
 * in the same project and tenant. Tests verify:
 *
 *   1. Session isolation: User A's session is accessible by A, 404 for B
 *   2. Session listing: Each user only sees their own sessions
 *   3. Message isolation: Messages are only accessible via owned sessions
 *   4. Attachment isolation: Attachments are only accessible via owned sessions
 *   5. Platform member access: Admin JWT user can access both sessions
 *   6. Cross-tenant isolation: SDK user from tenant-B cannot access tenant-A sessions
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS -- must be declared before any import that transitively pulls them in
// =============================================================================

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
    getCurrentRequestId: vi.fn(() => 'req-test-e2e'),
    getCurrentTenantId: vi.fn(() => 'tenant-A'),
  };
});

vi.mock('@agent-platform/shared-auth/middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth/middleware')>();
  return {
    ...actual,
    getCurrentTenantId: vi.fn(() => 'tenant-A'),
  };
});

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// --- Project repo: returns project with ownerId + membership lookup ---
vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectMember: vi.fn().mockImplementation((_projectId: string, userId: string) => {
    const memberships: Record<string, { role: string }> = {
      'admin-user': { role: 'admin' },
    };
    return Promise.resolve(memberships[userId] ?? null);
  }),
  findProjectAgentsForProject: vi.fn().mockResolvedValue([]),
  findProjectAgentByPath: vi.fn().mockResolvedValue(null),
  findProjectAgentByName: vi.fn().mockResolvedValue(null),
  findProjectAgentForProject: vi.fn().mockResolvedValue(null),
  findLatestAgentVersion: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSession: vi.fn().mockReturnValue(null),
    getSessionDetail: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockReturnValue([]),
    endSession: vi.fn(),
  })),
}));

vi.mock('../../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    getEvents: vi.fn().mockReturnValue([]),
    removeSession: vi.fn(),
    clearSession: vi.fn(),
    getSessionInfo: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../services/test-session.js', () => ({
  TestSessionService: { createSession: vi.fn() },
}));

vi.mock('../../services/dsl-utils.js', () => ({
  buildAgentDetails: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
  requirePrisma: vi.fn(),
}));

// --- Session repo: configurable mock for ownership tests ---
const mockFindSessionById = vi.fn();
const mockFindStoredSessionByAnyId = vi.fn();
const mockListSessions = vi.fn().mockResolvedValue([]);
const mockCountSessions = vi.fn().mockResolvedValue(0);
const mockFindMessagesForSession = vi.fn().mockResolvedValue([]);
const mockResolveStoredSessionCompatibilityId = vi.fn(
  (session: Record<string, unknown>, fallbackId: string) =>
    (typeof session.id === 'string' && session.id) ||
    (typeof session._id === 'string' && session._id) ||
    (typeof session.runtimeSessionId === 'string' && session.runtimeSessionId) ||
    fallbackId,
);
vi.mock('../../repos/session-repo.js', () => ({
  listSessions: (...args: any[]) => mockListSessions(...args),
  countSessions: (...args: any[]) => mockCountSessions(...args),
  findSessionById: (...args: any[]) => mockFindSessionById(...args),
  findSessionByRuntimeId: vi.fn().mockResolvedValue(null),
  findStoredSessionByAnyId: (...args: any[]) => mockFindStoredSessionByAnyId(...args),
  findMessagesForSession: (...args: any[]) => mockFindMessagesForSession(...args),
  resolveStoredSessionCompatibilityId: (...args: any[]) =>
    mockResolveStoredSessionCompatibilityId(...args),
  updateSession: vi.fn(),
}));

vi.mock('../../services/audit-helpers.js', () => ({
  auditSessionModified: vi.fn().mockResolvedValue(undefined),
}));

// --- Multimodal service client mock for attachment tests ---
const mockUpload = vi.fn().mockResolvedValue({
  success: true,
  attachmentId: 'att-1',
  status: 'processing',
});
const mockListBySession = vi
  .fn()
  .mockResolvedValue([{ id: 'att-1', filename: 'test.pdf', mimeType: 'application/pdf' }]);
const mockGetAttachment = vi.fn().mockResolvedValue({
  _id: 'att-1',
  id: 'att-1',
  projectId: 'proj-1',
  sessionId: 'sess-user-a',
  filename: 'test.pdf',
  originalFilename: 'test.pdf',
  mimeType: 'application/pdf',
  detectedMimeType: 'application/pdf',
  category: 'file',
  sizeBytes: 1024,
  messageId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  expiresAt: null,
});
const mockGetDownloadUrl = vi.fn().mockResolvedValue('https://storage.example.com/att-1');
const mockGetStatus = vi.fn().mockResolvedValue({
  scanStatus: 'clean',
  processingStatus: 'completed',
  embeddingStatus: 'completed',
});
const mockDeleteAttachment = vi.fn().mockResolvedValue(undefined);

vi.mock('../../attachments/multimodal-service-client.js', () => {
  return {
    MultimodalServiceClient: class MockMultimodalServiceClient {
      upload = mockUpload;
      listBySession = mockListBySession;
      getAttachment = mockGetAttachment;
      getDownloadUrl = mockGetDownloadUrl;
      getStatus = mockGetStatus;
      deleteAttachment = mockDeleteAttachment;
    },
  };
});

// =============================================================================
// IMPORTS -- after mocks
// =============================================================================

import express from 'express';
import type { Request, Response, NextFunction } from 'express';

// =============================================================================
// CONSTANTS & FIXTURES
// =============================================================================

const TENANT_A = 'tenant-A';
const TENANT_B = 'tenant-B';
const PROJECT_ID = 'proj-1';
const SESSIONS_BASE = `/api/projects/${PROJECT_ID}/sessions`;

function extractSessionListScopeClause(
  filterArg: Record<string, unknown>,
): Record<string, unknown> {
  const andClauses = Array.isArray(filterArg.$and) ? filterArg.$and : [];
  const scopedClause = andClauses.find(
    (clause): clause is Record<string, unknown> =>
      !!clause &&
      typeof clause === 'object' &&
      !Array.isArray(clause) &&
      ('tenantId' in clause ||
        'projectId' in clause ||
        'customerId' in clause ||
        'anonymousId' in clause ||
        'channelArtifact' in clause ||
        'initiatedById' in clause),
  );

  return scopedClause ?? filterArg;
}

/**
 * Session owned by User A (customerId='cust-A').
 */
const USER_A_SESSION = {
  _id: 'sess-user-a',
  id: 'sess-user-a',
  tenantId: TENANT_A,
  projectId: PROJECT_ID,
  customerId: 'cust-A',
  anonymousId: null,
  channelArtifact: null,
  channel: 'webchat',
  channelId: 'webchat',
  identityTier: 2,
  verificationMethod: 'hmac',
  currentAgent: 'test-agent',
  status: 'active',
  messageCount: 3,
  startedAt: new Date(),
  lastActivityAt: new Date(),
  // callerContext variant (used by attachment routes)
  callerContext: {
    tenantId: TENANT_A,
    customerId: 'cust-A',
    channel: 'webchat',
    channelId: 'webchat',
    identityTier: 2 as const,
    verificationMethod: 'hmac' as const,
  },
};

/**
 * Session owned by User B (customerId='cust-B').
 */
const USER_B_SESSION = {
  _id: 'sess-user-b',
  id: 'sess-user-b',
  tenantId: TENANT_A,
  projectId: PROJECT_ID,
  customerId: 'cust-B',
  anonymousId: null,
  channelArtifact: null,
  channel: 'webchat',
  channelId: 'webchat',
  identityTier: 2,
  verificationMethod: 'hmac',
  currentAgent: 'test-agent',
  status: 'active',
  messageCount: 2,
  startedAt: new Date(),
  lastActivityAt: new Date(),
  callerContext: {
    tenantId: TENANT_A,
    customerId: 'cust-B',
    channel: 'webchat',
    channelId: 'webchat',
    identityTier: 2 as const,
    verificationMethod: 'hmac' as const,
  },
};

/**
 * Messages belonging to User A's session.
 */
const USER_A_MESSAGES = [
  { id: 'msg-1', role: 'user', content: 'Hello from user A', timestamp: new Date() },
  {
    id: 'msg-2',
    role: 'assistant',
    content: 'Hi user A!',
    timestamp: new Date(),
  },
  { id: 'msg-3', role: 'user', content: 'How are you?', timestamp: new Date() },
];

// =============================================================================
// HELPERS
// =============================================================================

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty response (e.g., 204)
  }
  return { status: res.status, body: json };
}

/**
 * Create an Express server with SDK session auth context injected.
 * Simulates an SDK end-user with the given customerId in the specified tenant.
 */
async function createSDKServer(opts: {
  customerId: string;
  tenantId?: string;
  includeAttachments?: boolean;
}) {
  const tenantId = opts.tenantId ?? TENANT_A;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId,
      userId: 'sdk:webchat',
      role: 'sdk_session',
      permissions: [
        'session:read',
        'session:execute',
        'attachment:read',
        'attachment:write',
        'attachment:delete',
      ],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: PROJECT_ID,
      channelId: 'webchat',
      identityTier: 2,
      verificationMethod: 'hmac',
      verifiedUserId: opts.customerId,
      userContext: { userId: opts.customerId },
      channelArtifact: undefined,
      anonymousId: undefined,
    };
    (req as any).user = { id: 'sdk:webchat', email: 'sdk@test.com' };
    next();
  });

  const sessionsRouter = (await import('../../routes/sessions.js')).default;
  app.use('/api/projects/:projectId/sessions', sessionsRouter);

  if (opts.includeAttachments) {
    const attachmentsRouter = (await import('../../routes/attachments.js')).default;
    app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);
  }

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

/**
 * Create an Express server with platform member (User JWT) auth context.
 * Platform members bypass session ownership checks.
 */
async function createPlatformMemberServer() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId: TENANT_A,
      userId: 'admin-user',
      role: 'OWNER',
      permissions: ['*:*'],
      authType: 'user',
      isSuperAdmin: false,
    };
    (req as any).user = { id: 'admin-user', email: 'admin@test.com' };
    next();
  });

  const sessionsRouter = (await import('../../routes/sessions.js')).default;
  app.use('/api/projects/:projectId/sessions', sessionsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('End-to-end user isolation for SDK-authenticated users', () => {
  beforeEach(() => {
    mockFindSessionById.mockReset();
    mockFindStoredSessionByAnyId
      .mockReset()
      .mockImplementation((...args: any[]) => mockFindSessionById(...args));
    mockListSessions.mockReset().mockResolvedValue([]);
    mockCountSessions.mockReset().mockResolvedValue(0);
    mockFindMessagesForSession.mockReset().mockResolvedValue([]);
  });

  // ---------------------------------------------------------------------------
  // 1. Session isolation: User A creates session, A can access, B gets 404
  // ---------------------------------------------------------------------------
  describe('Session isolation: User A owns session, User B is denied', () => {
    let userAUrl: string;
    let userAServer: http.Server;
    let userBUrl: string;
    let userBServer: http.Server;

    beforeAll(async () => {
      ({ baseUrl: userAUrl, server: userAServer } = await createSDKServer({
        customerId: 'cust-A',
      }));
      ({ baseUrl: userBUrl, server: userBServer } = await createSDKServer({
        customerId: 'cust-B',
      }));
    });
    afterAll(() => {
      userAServer?.close();
      userBServer?.close();
    });

    test('User A can access their own session (not blocked by ownership)', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status } = await request(userAUrl, 'GET', `${SESSIONS_BASE}/sess-user-a`);
      // Should pass ownership check -- not 403 or 401
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      // Should reach the route handler (200 with session data)
      expect(status).toBe(200);
    });

    test('User B gets 404 when trying to access User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userBUrl, 'GET', `${SESSIONS_BASE}/sess-user-a`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('User B gets 404 when trying to delete User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userBUrl, 'DELETE', `${SESSIONS_BASE}/sess-user-a`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('User B gets 404 when trying to view User A session traces', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(
        userBUrl,
        'GET',
        `${SESSIONS_BASE}/sess-user-a/traces`,
      );
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('User B gets 404 when trying to close User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(
        userBUrl,
        'POST',
        `${SESSIONS_BASE}/sess-user-a/close`,
        { body: { disposition: 'completed' } },
      );
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('User B gets 404 when trying to reset User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(
        userBUrl,
        'POST',
        `${SESSIONS_BASE}/sess-user-a/reset`,
      );
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Session listing: User A only sees their own sessions
  // ---------------------------------------------------------------------------
  describe('Session listing: each user only sees their own sessions', () => {
    let userAUrl: string;
    let userAServer: http.Server;
    let userBUrl: string;
    let userBServer: http.Server;

    beforeAll(async () => {
      ({ baseUrl: userAUrl, server: userAServer } = await createSDKServer({
        customerId: 'cust-A',
      }));
      ({ baseUrl: userBUrl, server: userBServer } = await createSDKServer({
        customerId: 'cust-B',
      }));
    });
    afterAll(() => {
      userAServer?.close();
      userBServer?.close();
    });

    test('User A listing sessions includes customerId=cust-A filter', async () => {
      mockListSessions.mockResolvedValue([USER_A_SESSION]);
      mockCountSessions.mockResolvedValue(1);

      const { status, body } = await request(userAUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(200);

      // Verify the filter passed to listSessions scopes by User A's customerId
      expect(mockListSessions).toHaveBeenCalled();
      const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
      const scopedFilter = extractSessionListScopeClause(filterArg);
      expect(scopedFilter).toHaveProperty('tenantId', TENANT_A);
      expect(scopedFilter).toHaveProperty('projectId', PROJECT_ID);
      expect(scopedFilter).toHaveProperty('customerId', 'cust-A');
    });

    test('User B listing sessions includes customerId=cust-B filter', async () => {
      mockListSessions.mockResolvedValue([USER_B_SESSION]);
      mockCountSessions.mockResolvedValue(1);

      const { status, body } = await request(userBUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(200);

      // Verify the filter scopes by User B's customerId -- not User A's
      expect(mockListSessions).toHaveBeenCalled();
      const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
      const scopedFilter = extractSessionListScopeClause(filterArg);
      expect(scopedFilter).toHaveProperty('tenantId', TENANT_A);
      expect(scopedFilter).toHaveProperty('projectId', PROJECT_ID);
      expect(scopedFilter).toHaveProperty('customerId', 'cust-B');
    });

    test('User A listing never includes User B customerId in filter', async () => {
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);

      await request(userAUrl, 'GET', SESSIONS_BASE);

      const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
      const scopedFilter = extractSessionListScopeClause(filterArg);
      expect(scopedFilter.customerId).not.toBe('cust-B');
      expect(scopedFilter.customerId).toBe('cust-A');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Message isolation: messages only accessible via owned session
  // ---------------------------------------------------------------------------
  describe('Message isolation: messages protected by session ownership', () => {
    let userAUrl: string;
    let userAServer: http.Server;
    let userBUrl: string;
    let userBServer: http.Server;

    beforeAll(async () => {
      ({ baseUrl: userAUrl, server: userAServer } = await createSDKServer({
        customerId: 'cust-A',
      }));
      ({ baseUrl: userBUrl, server: userBServer } = await createSDKServer({
        customerId: 'cust-B',
      }));
    });
    afterAll(() => {
      userAServer?.close();
      userBServer?.close();
    });

    test('User A can view messages in own session (200 with messages)', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      mockFindMessagesForSession.mockResolvedValue(USER_A_MESSAGES);

      const { status, body } = await request(userAUrl, 'GET', `${SESSIONS_BASE}/sess-user-a`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session).toBeDefined();
      expect(body.session.messages).toBeDefined();
      expect(body.session.messages).toHaveLength(3);
      expect(body.session.messages[0].content).toBe('Hello from user A');
    });

    test('User B gets 404 on session -- cannot reach messages', async () => {
      // Session belongs to User A (cust-A), but request comes from User B (cust-B)
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      mockFindMessagesForSession.mockResolvedValue(USER_A_MESSAGES);

      const { status, body } = await request(userBUrl, 'GET', `${SESSIONS_BASE}/sess-user-a`);
      // Blocked by ownership middleware before reaching the route handler
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
      // Must not contain any message data
      expect(body.session).toBeUndefined();
      expect(body.messages).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Attachment isolation: attachments protected by session ownership
  // ---------------------------------------------------------------------------
  describe('Attachment isolation: attachments protected by session ownership', () => {
    let userAUrl: string;
    let userAServer: http.Server;
    let userBUrl: string;
    let userBServer: http.Server;

    const ATTACHMENTS_PATH = `/api/projects/${PROJECT_ID}/sessions/sess-user-a/attachments`;

    beforeAll(async () => {
      ({ baseUrl: userAUrl, server: userAServer } = await createSDKServer({
        customerId: 'cust-A',
        includeAttachments: true,
      }));
      ({ baseUrl: userBUrl, server: userBServer } = await createSDKServer({
        customerId: 'cust-B',
        includeAttachments: true,
      }));
    });
    afterAll(() => {
      userAServer?.close();
      userBServer?.close();
    });

    test('User A can list attachments in own session (200)', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userAUrl, 'GET', ATTACHMENTS_PATH);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.attachments).toBeDefined();
    });

    test('User A can get attachment download URL in own session (200)', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userAUrl, 'GET', `${ATTACHMENTS_PATH}/att-1/url`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.url).toBeDefined();
    });

    test('User B gets 404 listing attachments in User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userBUrl, 'GET', ATTACHMENTS_PATH);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('User B gets 404 getting attachment detail in User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userBUrl, 'GET', `${ATTACHMENTS_PATH}/att-1`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('User B gets 404 getting download URL in User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userBUrl, 'GET', `${ATTACHMENTS_PATH}/att-1/url`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('User B gets 404 deleting attachment in User A session', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      const { status, body } = await request(userBUrl, 'DELETE', `${ATTACHMENTS_PATH}/att-1`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Platform member access: Admin JWT user can access both sessions
  // ---------------------------------------------------------------------------
  describe('Platform member access: admin JWT bypasses ownership for both users', () => {
    let adminUrl: string;
    let adminServer: http.Server;

    beforeAll(async () => {
      ({ baseUrl: adminUrl, server: adminServer } = await createPlatformMemberServer());
    });
    afterAll(() => {
      adminServer?.close();
    });

    test('Admin can access User A session (bypasses ownership)', async () => {
      mockFindSessionById.mockResolvedValue(USER_A_SESSION);
      mockFindMessagesForSession.mockResolvedValue(USER_A_MESSAGES);

      const { status, body } = await request(adminUrl, 'GET', `${SESSIONS_BASE}/sess-user-a`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session).toBeDefined();
      expect(body.session.messages).toHaveLength(3);
    });

    test('Admin can access User B session (bypasses ownership)', async () => {
      mockFindSessionById.mockResolvedValue(USER_B_SESSION);
      mockFindMessagesForSession.mockResolvedValue([
        {
          id: 'msg-b1',
          role: 'user',
          content: 'Hello from user B',
          timestamp: new Date(),
        },
      ]);

      const { status, body } = await request(adminUrl, 'GET', `${SESSIONS_BASE}/sess-user-b`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.session).toBeDefined();
      expect(body.session.messages).toHaveLength(1);
      expect(body.session.messages[0].content).toBe('Hello from user B');
    });

    test('Admin listing sessions has no customerId filter (sees all)', async () => {
      mockListSessions.mockResolvedValue([USER_A_SESSION, USER_B_SESSION]);
      mockCountSessions.mockResolvedValue(2);

      const { status, body } = await request(adminUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(200);

      // Filter should NOT include customerId (platform members see all sessions)
      expect(mockListSessions).toHaveBeenCalled();
      const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
      const scopedFilter = extractSessionListScopeClause(filterArg);
      expect(scopedFilter).not.toHaveProperty('customerId');
      expect(scopedFilter).not.toHaveProperty('anonymousId');
      expect(scopedFilter).not.toHaveProperty('channelArtifact');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Cross-tenant isolation: SDK user from tenant-B cannot access tenant-A sessions
  // ---------------------------------------------------------------------------
  describe('Cross-tenant isolation: tenant-B SDK user denied tenant-A sessions', () => {
    let tenantBUrl: string;
    let tenantBServer: http.Server;

    beforeAll(async () => {
      // SDK user in tenant-B with customerId='cust-A' (same customerId, different tenant)
      ({ baseUrl: tenantBUrl, server: tenantBServer } = await createSDKServer({
        customerId: 'cust-A',
        tenantId: TENANT_B,
      }));
    });
    afterAll(() => {
      tenantBServer?.close();
    });

    test('Tenant-B SDK user gets 404 when accessing tenant-A session (session not found at query level)', async () => {
      // findSessionById is called with tenantId from the tenant context.
      // When the tenantId is 'tenant-B' but the session belongs to 'tenant-A',
      // the DB-level tenant filter ensures the session is not found.
      mockFindSessionById.mockImplementation((id: string, tenantId?: string) => {
        // Only return the session if tenant matches
        if (id === 'sess-user-a' && tenantId === TENANT_A) {
          return Promise.resolve(USER_A_SESSION);
        }
        // tenant-B asking for tenant-A session -> null (tenant filter at DB level)
        return Promise.resolve(null);
      });

      const { status, body } = await request(tenantBUrl, 'GET', `${SESSIONS_BASE}/sess-user-a`);
      // 404, not 403 -- do not leak existence of cross-tenant resources
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('Tenant-B SDK user gets 404 when deleting tenant-A session', async () => {
      mockFindSessionById.mockImplementation((id: string, tenantId?: string) => {
        if (id === 'sess-user-a' && tenantId === TENANT_A) {
          return Promise.resolve(USER_A_SESSION);
        }
        return Promise.resolve(null);
      });

      const { status, body } = await request(tenantBUrl, 'DELETE', `${SESSIONS_BASE}/sess-user-a`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('Tenant-B SDK user listing shows zero sessions from tenant-A', async () => {
      // The buildSessionListFilter will scope by tenant-B + customerId=cust-A.
      // No tenant-A sessions should appear.
      mockListSessions.mockResolvedValue([]);
      mockCountSessions.mockResolvedValue(0);

      const { status, body } = await request(tenantBUrl, 'GET', SESSIONS_BASE);
      expect(status).toBe(200);

      // Filter should include tenant-B (not tenant-A)
      expect(mockListSessions).toHaveBeenCalled();
      const filterArg = mockListSessions.mock.calls[0][0] as Record<string, unknown>;
      const scopedFilter = extractSessionListScopeClause(filterArg);
      expect(scopedFilter).toHaveProperty('tenantId', TENANT_B);
      expect(scopedFilter).toHaveProperty('customerId', 'cust-A');
      // Verify we never see tenant-A in the filter
      expect(scopedFilter.tenantId).not.toBe(TENANT_A);
    });
  });
});
