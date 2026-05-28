/**
 * Integration tests for POST /api/v1/agent-transfer/csat/submit
 *
 * Covers: Zod validation, agent-transfer initialization guards,
 * adapter registry lookup, CSAT capability check, success/failure envelopes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

// =============================================================================
// MOCKS — declared before any import that transitively loads them
// =============================================================================

const mockIsInitialized = vi.fn<[], boolean>();
const mockGetAdapterRegistry = vi.fn<[], Map<string, unknown> | null>();
const mockGetTransferTraceEmitter = vi.fn<[], { emit: ReturnType<typeof vi.fn> } | null>(
  () => null,
);

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
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

vi.mock('../../services/agent-transfer/index.js', () => ({
  isAgentTransferInitialized: (...args: any[]) => mockIsInitialized(...args),
  getAdapterRegistry: (...args: any[]) => mockGetAdapterRegistry(...args),
  getTransferTraceEmitter: (...args: any[]) => mockGetTransferTraceEmitter(...args),
}));

// =============================================================================
// SERVER SETUP
// =============================================================================

const CSAT_BASE = '/api/v1/agent-transfer/csat';
const TENANT_ID = 'tenant-csat-test';

async function createTestServer() {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext(TENANT_ID, 'user-1', 'OWNER');
  app.use(injectTenantContext(ctx));

  const csatRouter = (await import('../../routes/agent-transfer-csat.js')).default;
  app.use(CSAT_BASE, csatRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const VALID_BODY = {
  provider: 'smartassist',
  userId: 'user-123',
  channel: 'chat',
  botId: 'bot-456',
  score: 5,
  surveyType: 'csat',
};

// =============================================================================
// TESTS
// =============================================================================

describe('POST /api/v1/agent-transfer/csat/submit', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createTestServer());
  });
  afterAll(() => server?.close());
  beforeEach(() => {
    mockGetTransferTraceEmitter.mockReturnValue(null);
  });

  // ---------------------------------------------------------------------------
  // Initialization guards
  // ---------------------------------------------------------------------------
  describe('initialization guards', () => {
    beforeEach(() => {
      mockIsInitialized.mockReturnValue(false);
      mockGetAdapterRegistry.mockReturnValue(null);
    });

    test('returns 503 when agent transfer not initialized', async () => {
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, VALID_BODY);
      expect(status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_INITIALIZED');
    });

    test('returns 503 when adapter registry is unavailable', async () => {
      mockIsInitialized.mockReturnValue(true);
      mockGetAdapterRegistry.mockReturnValue(null);
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, VALID_BODY);
      expect(status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_INITIALIZED');
    });
  });

  // ---------------------------------------------------------------------------
  // Zod validation
  // ---------------------------------------------------------------------------
  describe('Zod validation', () => {
    beforeEach(() => {
      mockIsInitialized.mockReturnValue(true);
      mockGetAdapterRegistry.mockReturnValue(new Map());
    });

    test('returns 400 when provider is missing', async () => {
      const { provider: _omit, ...rest } = VALID_BODY;
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, rest);
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 when userId is missing', async () => {
      const { userId: _omit, ...rest } = VALID_BODY;
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, rest);
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 when score is below 0', async () => {
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, {
        ...VALID_BODY,
        score: -1,
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns 400 when score exceeds 10', async () => {
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, {
        ...VALID_BODY,
        score: 11,
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('accepts score at boundary 0', async () => {
      // registry has no matching provider → 404, but passes validation
      const { status } = await post(baseUrl, `${CSAT_BASE}/submit`, {
        ...VALID_BODY,
        score: 0,
      });
      expect(status).not.toBe(400);
    });

    test('accepts score at boundary 10', async () => {
      const { status } = await post(baseUrl, `${CSAT_BASE}/submit`, {
        ...VALID_BODY,
        score: 10,
      });
      expect(status).not.toBe(400);
    });

    test('returns 400 when surveyType is invalid', async () => {
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, {
        ...VALID_BODY,
        surveyType: 'invalid-type',
      });
      expect(status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('defaults surveyType to csat when omitted', async () => {
      const { surveyType: _omit, ...rest } = VALID_BODY;
      // registry has no provider → 404, but validation passes
      const { status } = await post(baseUrl, `${CSAT_BASE}/submit`, rest);
      expect(status).not.toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Provider resolution
  // ---------------------------------------------------------------------------
  describe('provider resolution', () => {
    beforeEach(() => {
      mockIsInitialized.mockReturnValue(true);
    });

    test('returns 404 when provider is not in registry', async () => {
      mockGetAdapterRegistry.mockReturnValue(new Map([['other-provider', {}]]));
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, VALID_BODY);
      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PROVIDER_NOT_FOUND');
    });

    test('returns 501 when provider exists but has no submitCsatRating method', async () => {
      const adapterWithoutCsat = { name: 'smartassist' };
      mockGetAdapterRegistry.mockReturnValue(new Map([['smartassist', adapterWithoutCsat]]));
      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, VALID_BODY);
      expect(status).toBe(501);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('NOT_SUPPORTED');
    });
  });

  // ---------------------------------------------------------------------------
  // Adapter delegation — success and failure paths
  // ---------------------------------------------------------------------------
  describe('adapter delegation', () => {
    beforeEach(() => {
      mockIsInitialized.mockReturnValue(true);
    });

    test('returns 200 with data envelope on adapter success', async () => {
      const csatAdapter = {
        submitCsatRating: vi.fn().mockResolvedValue({
          success: true,
          data: { message: 'Thank you for your rating!' },
        }),
      };
      mockGetAdapterRegistry.mockReturnValue(new Map([['smartassist', csatAdapter]]));

      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, VALID_BODY);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Thank you for your rating!');
      expect(csatAdapter.submitCsatRating).toHaveBeenCalledWith({
        userId: VALID_BODY.userId,
        channel: VALID_BODY.channel,
        botId: VALID_BODY.botId,
        score: VALID_BODY.score,
        surveyType: VALID_BODY.surveyType,
        comments: undefined,
      });
    });

    test('forwards optional comments field to adapter', async () => {
      const csatAdapter = {
        submitCsatRating: vi.fn().mockResolvedValue({
          success: true,
          data: { message: 'Thanks!' },
        }),
      };
      mockGetAdapterRegistry.mockReturnValue(new Map([['smartassist', csatAdapter]]));

      await post(baseUrl, `${CSAT_BASE}/submit`, { ...VALID_BODY, comments: 'Great service!' });

      expect(csatAdapter.submitCsatRating).toHaveBeenCalledWith(
        expect.objectContaining({ comments: 'Great service!' }),
      );
    });

    test('emits csat_completed trace after successful API submission', async () => {
      const traceEmitter = { emit: vi.fn() };
      const csatAdapter = {
        submitCsatRating: vi.fn().mockResolvedValue({
          success: true,
          data: { message: 'Thanks!' },
        }),
      };
      mockGetTransferTraceEmitter.mockReturnValue(traceEmitter);
      mockGetAdapterRegistry.mockReturnValue(new Map([['smartassist', csatAdapter]]));

      const { status } = await post(baseUrl, `${CSAT_BASE}/submit`, {
        ...VALID_BODY,
        comments: 'Great service!',
      });

      expect(status).toBe(200);
      expect(traceEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent_transfer.csat_completed',
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            projectId: '',
            contactId: VALID_BODY.userId,
            provider: VALID_BODY.provider,
            channel: VALID_BODY.channel,
            score: VALID_BODY.score,
            feedback: 'Great service!',
          }),
        }),
      );
    });

    test('returns 502 when adapter returns failure', async () => {
      const csatAdapter = {
        submitCsatRating: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'CSAT_SUBMISSION_FAILED', message: 'Provider rejected the request' },
        }),
      };
      mockGetAdapterRegistry.mockReturnValue(new Map([['smartassist', csatAdapter]]));

      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, VALID_BODY);

      expect(status).toBe(502);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('CSAT_SUBMISSION_FAILED');
    });

    test('returns 500 when adapter throws unexpectedly', async () => {
      const csatAdapter = {
        submitCsatRating: vi.fn().mockRejectedValue(new Error('Unexpected crash')),
      };
      mockGetAdapterRegistry.mockReturnValue(new Map([['smartassist', csatAdapter]]));

      const { status, body } = await post(baseUrl, `${CSAT_BASE}/submit`, VALID_BODY);

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      // Error details must not leak to user
      expect(body.error.message).not.toContain('Unexpected crash');
    });

    test('all survey types pass validation and are forwarded correctly', async () => {
      for (const surveyType of ['csat', 'nps', 'likeDislike'] as const) {
        const csatAdapter = {
          submitCsatRating: vi.fn().mockResolvedValue({ success: true, data: {} }),
        };
        mockGetAdapterRegistry.mockReturnValue(new Map([['smartassist', csatAdapter]]));

        const { status } = await post(baseUrl, `${CSAT_BASE}/submit`, {
          ...VALID_BODY,
          surveyType,
        });

        expect(status).toBe(200);
        expect(csatAdapter.submitCsatRating).toHaveBeenCalledWith(
          expect.objectContaining({ surveyType }),
        );
      }
    });
  });
});
