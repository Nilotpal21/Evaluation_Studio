/**
 * Attachment Routes -- Session Ownership Authorization Tests
 *
 * Verifies that `createRequireSessionOwnership` middleware enforces
 * session ownership for SDK auth on attachment routes.
 *
 * SDK session users can only access attachments in sessions they own.
 * Platform members (User JWT) bypass ownership checks and use RBAC only.
 *
 * Route mount: /api/projects/:projectId/sessions/:sessionId/attachments
 *
 * Endpoints tested:
 *   POST   /                    -> attachment:write (upload)
 *   GET    /                    -> attachment:read  (list)
 *   GET    /:attachmentId       -> attachment:read  (detail)
 *   GET    /:attachmentId/url   -> attachment:read  (download URL)
 *   GET    /:attachmentId/status -> attachment:read  (processing status)
 *   DELETE /:attachmentId       -> attachment:delete (delete)
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

// Stub requireProjectScope on the correct module (@agent-platform/shared-auth)
// The attachments route imports { requireProjectScope, createRequireSessionOwnership } from '@agent-platform/shared-auth'
vi.mock('@agent-platform/shared-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

// Stub getCurrentTenantId on the correct module (@agent-platform/shared-auth/middleware)
// The attachments route imports { getCurrentTenantId } from '@agent-platform/shared-auth/middleware'
vi.mock('@agent-platform/shared-auth/middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared-auth/middleware')>();
  return {
    ...actual,
    getCurrentTenantId: vi.fn(() => 'tenant-A'),
  };
});

// --- Project repo: returns project with ownerId + membership lookup ---
vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockResolvedValue({
    _id: 'proj-1',
    tenantId: 'tenant-A',
    ownerId: 'project-owner',
  }),
  findProjectMember: vi.fn().mockImplementation((_projectId: string, userId: string) => {
    const memberships: Record<string, { role: string }> = {
      'proj-admin-user': { role: 'admin' },
      'proj-dev-user': { role: 'developer' },
      'proj-viewer-user': { role: 'viewer' },
    };
    return Promise.resolve(memberships[userId] ?? null);
  }),
}));

vi.mock('../../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('../../openapi/registry.js', () => ({
  runtimeRegistry: {},
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

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => false),
  requirePrisma: vi.fn(),
}));

// --- Session repo mock: key mock for ownership tests ---
const mockFindSessionById = vi.fn();
vi.mock('../../repos/session-repo.js', () => ({
  findSessionById: mockFindSessionById,
  listSessions: vi.fn().mockResolvedValue([]),
  countSessions: vi.fn().mockResolvedValue(0),
  findSessionByRuntimeId: vi.fn().mockResolvedValue(null),
  findMessagesForSession: vi.fn().mockResolvedValue([]),
  updateSession: vi.fn(),
}));

// --- Multimodal service client mock ---
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
  originalFilename: 'test.pdf',
  filename: 'test.pdf',
  mimeType: 'application/pdf',
  detectedMimeType: null,
  category: 'document',
  sizeBytes: 1024,
  messageId: null,
  scanStatus: 'clean',
  processingStatus: 'completed',
  embeddingStatus: 'completed',
  createdAt: new Date('2026-03-01T00:00:00Z'),
  updatedAt: new Date('2026-03-01T00:00:00Z'),
  expiresAt: null,
  projectId: 'proj-1',
  sessionId: 'sess-owner',
  tenantId: 'tenant-A',
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
// CONSTANTS
// =============================================================================

const TENANT_ID = 'tenant-A';
const BASE_PATH = '/api/projects/proj-1/sessions/sess-owner/attachments';

/**
 * Session owned by SDK user "user-alpha" via customerId (Tier 2 identity).
 * Uses flat fields matching the actual DB model (ISession) — NOT a nested callerContext object.
 */
const OWNED_SESSION = {
  _id: 'sess-owner',
  id: 'sess-owner',
  tenantId: TENANT_ID,
  projectId: 'proj-1',
  channel: 'web',
  channelId: 'web-channel',
  customerId: 'user-alpha',
  identityTier: 2 as const,
  verificationMethod: 'hmac' as const,
};

// =============================================================================
// HELPERS
// =============================================================================

async function request(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { body?: any; contentType?: string },
) {
  const headers: Record<string, string> = {};
  if (opts?.contentType) {
    headers['Content-Type'] = opts.contentType;
  } else {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body:
      opts?.body !== undefined
        ? typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body)
        : undefined,
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
 * Create a test server with SDK session auth context.
 * The SDK session carries a customerId identity.
 */
async function createSdkServer(customerId: string) {
  const app = express();
  app.use(express.json());

  // Inject SDK session tenant context
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId: TENANT_ID,
      userId: `sdk:web-channel`,
      role: 'sdk_session',
      permissions: ['session:execute', 'attachment:read', 'attachment:write', 'attachment:delete'],
      authType: 'sdk_session',
      isSuperAdmin: false,
      projectId: 'proj-1',
      channelId: 'web-channel',
      identityTier: 2,
      verificationMethod: 'hmac',
      verifiedUserId: customerId,
      userContext: { userId: customerId },
    };
    (req as any).user = { id: `sdk:${customerId}`, email: 'sdk@test.com' };
    next();
  });

  const attachmentsRouter = (await import('../../routes/attachments.js')).default;
  app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

/**
 * Create a test server with platform member (User JWT) auth context.
 */
async function createPlatformMemberServer(userId: string, role: string, permissions: string[]) {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).tenantContext = {
      tenantId: TENANT_ID,
      userId,
      role,
      permissions,
      authType: 'user',
      isSuperAdmin: false,
    };
    (req as any).user = { id: userId, email: `${userId}@test.com` };
    next();
  });

  const attachmentsRouter = (await import('../../routes/attachments.js')).default;
  app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);

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

describe('Attachment routes -- session ownership enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // SDK user accessing own session -- should pass through to route handlers
  // ---------------------------------------------------------------------------
  describe('SDK user accessing own session', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // SDK user "user-alpha" matches session owner
      ({ baseUrl, server } = await createSdkServer('user-alpha'));
    });
    afterAll(() => server?.close());

    beforeEach(() => {
      // Session lookup returns session owned by user-alpha
      mockFindSessionById.mockResolvedValue(OWNED_SESSION);
    });

    test('GET / list attachments -> passes (own session)', async () => {
      const { status, body } = await request(baseUrl, 'GET', BASE_PATH);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.attachments).toBeDefined();
    });

    test('GET /:attachmentId detail -> passes (own session)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('GET /:attachmentId/url download URL -> passes (own session)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1/url`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.url).toBeDefined();
    });

    test('GET /:attachmentId/status processing status -> passes (own session)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1/status`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.scanStatus).toBeDefined();
    });

    test('DELETE /:attachmentId -> passes (own session)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${BASE_PATH}/att-1`);
      expect(status).toBe(204);
    });
  });

  // ---------------------------------------------------------------------------
  // SDK user accessing ANOTHER user's session -- should get 404
  // ---------------------------------------------------------------------------
  describe("SDK user accessing another user's session", () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // SDK user "user-beta" does NOT match session owner "user-alpha"
      ({ baseUrl, server } = await createSdkServer('user-beta'));
    });
    afterAll(() => server?.close());

    beforeEach(() => {
      // Session lookup returns session owned by user-alpha (not user-beta)
      mockFindSessionById.mockResolvedValue(OWNED_SESSION);
    });

    test('GET / list attachments -> 404 (not session owner)', async () => {
      const { status, body } = await request(baseUrl, 'GET', BASE_PATH);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:attachmentId detail -> 404 (not session owner)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:attachmentId/url download URL -> 404 (not session owner)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1/url`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:attachmentId/status processing status -> 404 (not session owner)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1/status`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('DELETE /:attachmentId -> 404 (not session owner)', async () => {
      const { status, body } = await request(baseUrl, 'DELETE', `${BASE_PATH}/att-1`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // SDK user accessing non-existent session -- should get 404
  // ---------------------------------------------------------------------------
  describe('SDK user accessing non-existent session', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createSdkServer('user-alpha'));
    });
    afterAll(() => server?.close());

    beforeEach(() => {
      // Session not found
      mockFindSessionById.mockResolvedValue(null);
    });

    test('GET / list attachments -> 404 (session not found)', async () => {
      const { status, body } = await request(baseUrl, 'GET', BASE_PATH);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:attachmentId detail -> 404 (session not found)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  // ---------------------------------------------------------------------------
  // Platform member (User JWT) with attachment:read -- bypasses ownership
  // ---------------------------------------------------------------------------
  describe('Platform member with attachment:read (any session)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      // Platform member with OWNER role (which has *:* permissions)
      ({ baseUrl, server } = await createPlatformMemberServer('proj-admin-user', 'OWNER', ['*:*']));
    });
    afterAll(() => server?.close());

    beforeEach(() => {
      // Session is owned by someone else -- platform member should still access
      mockFindSessionById.mockResolvedValue(OWNED_SESSION);
    });

    test('GET / list attachments -> 200 (platform member bypasses ownership)', async () => {
      const { status, body } = await request(baseUrl, 'GET', BASE_PATH);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('GET /:attachmentId detail -> 200 (platform member bypasses ownership)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('GET /:attachmentId/url download URL -> 200 (platform member bypasses ownership)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1/url`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('GET /:attachmentId/status -> 200 (platform member bypasses ownership)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1/status`);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('DELETE /:attachmentId -> 204 (platform member bypasses ownership)', async () => {
      const { status } = await request(baseUrl, 'DELETE', `${BASE_PATH}/att-1`);
      expect(status).toBe(204);
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated request -- 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      // No tenant context injected
      const attachmentsRouter = (await import('../../routes/attachments.js')).default;
      app.use('/api/projects/:projectId/sessions/:sessionId/attachments', attachmentsRouter);

      await new Promise<void>((resolve) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });
    afterAll(() => server?.close());

    test('GET / returns 401 (no auth)', async () => {
      const { status, body } = await request(baseUrl, 'GET', BASE_PATH);
      // The session ownership middleware returns 401 when no tenantContext
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });

    test('GET /:attachmentId returns 401 (no auth)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1`);
      expect(status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });
  });

  // ---------------------------------------------------------------------------
  // SDK session with no callerContext on session -- defensive deny
  // ---------------------------------------------------------------------------
  describe('SDK user accessing session without callerContext', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createSdkServer('user-alpha'));
    });
    afterAll(() => server?.close());

    beforeEach(() => {
      // Session exists but has no callerContext -- ownership middleware denies
      mockFindSessionById.mockResolvedValue({
        _id: 'sess-no-ctx',
        id: 'sess-no-ctx',
        tenantId: TENANT_ID,
        projectId: 'proj-1',
        // callerContext intentionally missing
      });
    });

    test('GET / returns 404 (session has no callerContext)', async () => {
      const { status, body } = await request(baseUrl, 'GET', BASE_PATH);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    test('GET /:attachmentId returns 404 (session has no callerContext)', async () => {
      const { status, body } = await request(baseUrl, 'GET', `${BASE_PATH}/att-1`);
      expect(status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });
});
