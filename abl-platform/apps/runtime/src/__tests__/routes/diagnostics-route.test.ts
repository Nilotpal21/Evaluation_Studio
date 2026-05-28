/**
 * Diagnostics Route Tests
 *
 * Tests the diagnostic API endpoints for agent and session health checks.
 * Covers:
 * - GET /agents/:agentName (quick diagnostic for an agent)
 * - GET /sessions/:sessionId (configurable-depth diagnostic for a session)
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { makeTenantContext, injectTenantContext } from '../helpers/auth-context.js';

// ─── Hoisted Mocks ──────────────────────────────────────────────────────

const mockDiagnose = vi.fn();
const mockResolveProjectSessionAccess = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requireProjectScope: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn(async () => true),
}));

vi.mock('../../middleware/session-access.js', () => ({
  resolveProjectSessionAccess: (...args: any[]) => mockResolveProjectSessionAccess(...args),
}));

vi.mock('../../services/diagnostics/engine.js', () => ({
  getDiagnosticEngine: vi.fn(() => ({ diagnose: mockDiagnose })),
  ensureAnalyzersReady: vi.fn().mockResolvedValue(undefined),
}));

// Mock the dynamic import of runtime-executor used in the session route
vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => null),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────

const MOCK_REPORT = {
  status: 'healthy',
  target: { type: 'agent', id: 'my-agent', agentName: 'my-agent' },
  findings: [],
  summary: { errors: 0, warnings: 0, infos: 0, analyzersRun: ['model-resolution'] },
  config: {},
  timestamp: '2026-03-15T00:00:00.000Z',
};

async function createTestServer() {
  const app = express();
  app.use(express.json());

  const ctx = makeTenantContext('tenant-1', 'user-1', 'OWNER');
  app.use(injectTenantContext(ctx));

  const routerModule = await import('../../routes/diagnostics.js');
  app.use('/api/projects/:projectId/diagnostics', routerModule.default);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function request(baseUrl: string, method: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const BASE = '/api/projects/proj-1/diagnostics';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Diagnostics Route', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProjectSessionAccess.mockResolvedValue({ session: { agentName: 'unknown' } });
  });

  // ── GET /agents/:agentName ──────────────────────────────────────────

  describe('GET /agents/:agentName', () => {
    test('returns 200 with diagnostic report on success', async () => {
      mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

      const { status, body } = await request(baseUrl, 'GET', `${BASE}/agents/my-agent`);

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, data: MOCK_REPORT });
    });

    test('passes correct tenantId, projectId, agentName to engine.diagnose', async () => {
      mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

      await request(baseUrl, 'GET', `${BASE}/agents/my-agent`);

      expect(mockDiagnose).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        agentName: 'my-agent',
        depth: 'quick',
      });
    });

    test('checks project permission before diagnosing an agent', async () => {
      mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

      const { requireProjectPermission } = await import('../../middleware/rbac.js');
      await request(baseUrl, 'GET', `${BASE}/agents/my-agent`);

      expect(requireProjectPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            projectId: 'proj-1',
            agentName: 'my-agent',
          }),
        }),
        expect.anything(),
        'agent:read',
      );
    });

    test('uses depth "quick" for agent endpoint', async () => {
      mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

      await request(baseUrl, 'GET', `${BASE}/agents/my-agent`);

      expect(mockDiagnose).toHaveBeenCalledWith(expect.objectContaining({ depth: 'quick' }));
    });

    test('returns 500 with error response on engine failure', async () => {
      mockDiagnose.mockRejectedValueOnce(new Error('Engine exploded'));

      const { status, body } = await request(baseUrl, 'GET', `${BASE}/agents/my-agent`);

      expect(status).toBe(500);
      expect(body).toEqual({
        success: false,
        error: { code: 'DIAGNOSTIC_FAILED', message: 'Diagnostic analysis failed' },
      });
    });
  });

  // ── GET /sessions/:sessionId ────────────────────────────────────────

  describe('GET /sessions/:sessionId', () => {
    test('returns 200 with diagnostic report on success', async () => {
      const sessionReport = {
        ...MOCK_REPORT,
        target: { type: 'session', id: 'sess-1', agentName: 'unknown' },
      };
      mockDiagnose.mockResolvedValueOnce(sessionReport);

      const { status, body } = await request(baseUrl, 'GET', `${BASE}/sessions/sess-1`);

      expect(status).toBe(200);
      expect(body).toEqual({ success: true, data: sessionReport });
    });

    test('checks exact-session access before running diagnostics', async () => {
      mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

      await request(baseUrl, 'GET', `${BASE}/sessions/sess-1`);

      expect(mockResolveProjectSessionAccess).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            projectId: 'proj-1',
            sessionId: 'sess-1',
          }),
        }),
        {
          sessionId: 'sess-1',
          projectId: 'proj-1',
          requiredPermission: 'session:read',
        },
      );
    });

    test('accepts depth query parameter (standard, deep, quick)', async () => {
      for (const depth of ['standard', 'deep', 'quick'] as const) {
        mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

        await request(baseUrl, 'GET', `${BASE}/sessions/sess-1?depth=${depth}`);

        expect(mockDiagnose).toHaveBeenLastCalledWith(expect.objectContaining({ depth }));
      }
    });

    test('defaults to "standard" depth when no query param', async () => {
      mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

      await request(baseUrl, 'GET', `${BASE}/sessions/sess-1`);

      expect(mockDiagnose).toHaveBeenCalledWith(expect.objectContaining({ depth: 'standard' }));
    });

    test('invalid depth value falls back to "standard"', async () => {
      mockDiagnose.mockResolvedValueOnce(MOCK_REPORT);

      await request(baseUrl, 'GET', `${BASE}/sessions/sess-1?depth=bogus`);

      expect(mockDiagnose).toHaveBeenCalledWith(expect.objectContaining({ depth: 'standard' }));
    });

    test('returns 500 with error response on engine failure', async () => {
      mockDiagnose.mockRejectedValueOnce(new Error('Engine exploded'));

      const { status, body } = await request(baseUrl, 'GET', `${BASE}/sessions/sess-1`);

      expect(status).toBe(500);
      expect(body).toEqual({
        success: false,
        error: { code: 'DIAGNOSTIC_FAILED', message: 'Diagnostic analysis failed' },
      });
    });

    test('returns the concealment envelope when session access is denied', async () => {
      mockResolveProjectSessionAccess.mockResolvedValueOnce({
        denial: {
          statusCode: 404,
          publicError: 'Session not found',
        },
      });

      const { status, body } = await request(baseUrl, 'GET', `${BASE}/sessions/sess-1`);

      expect(status).toBe(404);
      expect(body).toEqual({
        success: false,
        error: { code: 'ACCESS_DENIED', message: 'Session not found' },
      });
      expect(mockDiagnose).not.toHaveBeenCalled();
    });

    test('preserves the public denial message when concealment includes extra guidance', async () => {
      mockResolveProjectSessionAccess.mockResolvedValueOnce({
        denial: {
          statusCode: 404,
          publicError: 'Session not found',
          publicMessage: 'The requested session is outside your current scope.',
        },
      });

      const { status, body } = await request(baseUrl, 'GET', `${BASE}/sessions/sess-1`);

      expect(status).toBe(404);
      expect(body).toEqual({
        success: false,
        error: { code: 'ACCESS_DENIED', message: 'Session not found' },
        message: 'The requested session is outside your current scope.',
      });
      expect(mockDiagnose).not.toHaveBeenCalled();
    });
  });
});
