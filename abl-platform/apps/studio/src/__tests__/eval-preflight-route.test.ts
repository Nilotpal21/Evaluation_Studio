import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
const mockHandleApiError = vi.fn();
const mockGetRestateIngressUrl = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/lib/api-response', () => ({
  handleApiError: (...args: unknown[]) => mockHandleApiError(...args),
}));

vi.mock('@/lib/restate-url', () => ({
  getRestateIngressUrl: (...args: unknown[]) => mockGetRestateIngressUrl(...args),
}));

vi.mock('@abl/compiler/platform/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { POST } from '@/app/api/projects/[id]/evals/preflight/route';

const authenticatedUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: 'tenant-1',
};

function makeRequest() {
  return new NextRequest('http://localhost:3000/api/projects/proj-1/evals/preflight', {
    method: 'POST',
  });
}

function routeParams() {
  return { params: Promise.resolve({ id: 'proj-1' }) };
}

describe('POST /api/projects/:id/evals/preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({
      project: {
        id: 'proj-1',
        tenantId: 'tenant-1',
      },
    });
    mockIsAccessError.mockReturnValue(false);
    mockHandleApiError.mockImplementation((error: unknown) =>
      NextResponse.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
    );
    mockGetRestateIngressUrl.mockReturnValue('http://localhost:9080');
    vi.stubGlobal('fetch', mockFetch);
  });

  test('sanitizes internal preflight check names and messages before returning API response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        overall: 'warn',
        timestamp: '2026-05-21T00:00:00.000Z',
        checks: [
          {
            name: 'runtime_reachable',
            status: 'pass',
            message: 'Runtime at http://runtime:3112 is healthy',
            durationMs: 10.2,
          },
          {
            name: 'clickhouse',
            status: 'pass',
            message: 'ClickHouse eval_conversations table accessible',
            durationMs: 11,
          },
          {
            name: 'llm_credentials',
            status: 'fail',
            code: 'MISSING_PROVIDER_KEY',
            message: 'No OpenAI credential found for tenant tenant-1',
            durationMs: 12,
          },
          {
            name: 'runtime_auth',
            status: 'warn',
            message: 'Could not verify Runtime auth: JWT_SECRET mismatch',
            durationMs: 13,
          },
          {
            name: 'encryption_master_key',
            status: 'fail',
            message: 'ENCRYPTION_MASTER_KEY must be 32 bytes for AES-256-GCM',
            durationMs: 14,
          },
          {
            name: 'required_env_vars',
            status: 'warn',
            message: 'Missing required env vars: JWT_SECRET, RUNTIME_URL',
            durationMs: 15,
          },
          {
            name: 'evaluator_model_1',
            status: 'fail',
            code: 'LLM_RESOLUTION_FAILED',
            message: 'Evaluator model resolution failed: model gpt-internal unavailable',
            durationMs: 16,
          },
        ],
      })),
    });

    const response = await POST(makeRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.result.checks).toEqual([
      {
        name: 'agent_service_connectivity',
        status: 'pass',
        message: 'Agent service is reachable.',
        durationMs: 10,
      },
      {
        name: 'results_storage',
        status: 'pass',
        message: 'Eval results storage is ready.',
        durationMs: 11,
      },
      {
        name: 'model_credentials',
        status: 'fail',
        message: 'Model credentials need attention before evals can run.',
        durationMs: 12,
      },
      {
        name: 'agent_service_authorization',
        status: 'warn',
        message: 'Agent service authorization should be reviewed before evals run.',
        durationMs: 13,
      },
      {
        name: 'data_protection',
        status: 'fail',
        message: 'Data protection settings need attention before evals can run.',
        durationMs: 14,
      },
      {
        name: 'service_configuration',
        status: 'warn',
        message: 'Required service configuration should be reviewed before evals run.',
        durationMs: 15,
      },
      {
        name: 'evaluator_model_configuration_1',
        status: 'fail',
        message: 'Evaluator model configuration needs attention before evals can run.',
        durationMs: 16,
      },
    ]);

    const serializedBody = JSON.stringify(body).toLowerCase();
    for (const leakedToken of [
      'clickhouse',
      'eval_conversations',
      'runtime_reachable',
      'runtime_auth',
      'llm_credentials',
      'encryption_master_key',
      'required_env_vars',
      'jwt_secret',
      'runtime_url',
      'aes-256-gcm',
      'tenant-1',
      'gpt-internal',
      'openai',
    ]) {
      expect(serializedBody).not.toContain(leakedToken);
    }
  });

  test('returns sanitized service error when preflight service fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: vi.fn(async () => 'ClickHouse eval_conversations unavailable'),
    });

    const response = await POST(makeRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'PREFLIGHT_SERVICE_ERROR',
        message: 'Preflight service returned an error. Please try again or contact support.',
      },
    });
    expect(JSON.stringify(body).toLowerCase()).not.toContain('clickhouse');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('eval_conversations');
  });
});
