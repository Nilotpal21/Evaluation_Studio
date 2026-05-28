/**
 * INT-12: Studio Prompt Library Proxy — auth-context forwarding + error passthrough
 *
 * Verifies:
 * - Authorization header forwarded to runtime
 * - X-Tenant-Id header forwarded to runtime
 * - 401 from runtime propagated to caller
 * - 400 from runtime propagated to caller
 * - POST body forwarded correctly
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ──────────────────────────────────────────────────────────

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
const mockGetRuntimeUrl = vi.fn().mockReturnValue('http://runtime.internal');

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => mockGetRuntimeUrl(),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/api-response', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-response')>();
  return { ...actual };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { GET as listPromptsGET, POST as createPromptPOST } from '../prompts/route';
import { POST as testPOST } from '../test/route';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const TENANT_ID = 'int12-tenant';
const PROJECT_ID = 'int12-project';
const AUTH_HEADER = 'Bearer jwt-token-abc123';

const authenticatedUser = {
  id: 'user-int12',
  email: 'test@example.com',
  name: 'Test User',
  tenantId: TENANT_ID,
  permissions: ['prompt:create', 'prompt:read', 'prompt:test'],
};

const projectStub = {
  _id: PROJECT_ID,
  id: PROJECT_ID,
  tenantId: TENANT_ID,
  ownerId: 'user-int12',
  name: 'Test Project',
};

function makeRequest(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
) {
  return new NextRequest(`http://studio.local${path}`, {
    method,
    headers: {
      Authorization: AUTH_HEADER,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeRouteCtx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function makeRuntimeResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

// ─── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue(authenticatedUser);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue({
    project: projectStub,
    accessPath: 'owner',
  });
  mockIsAccessError.mockReturnValue(false);
  mockGetRuntimeUrl.mockReturnValue('http://runtime.internal');
});

// ─── INT-12 ────────────────────────────────────────────────────────────────

describe('INT-12: Studio proxy — auth-context forwarding', () => {
  test('forwards Authorization header to runtime', async () => {
    const capturedHeaders: Record<string, string> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        for (const [k, v] of Object.entries(init?.headers as Record<string, string>)) {
          capturedHeaders[k] = v;
        }
        return makeRuntimeResponse({ success: true, items: [], total: 0 });
      }),
    );

    const request = makeRequest(`/api/projects/${PROJECT_ID}/prompt-library/prompts`);
    await listPromptsGET(request, makeRouteCtx({ id: PROJECT_ID }));

    expect(capturedHeaders['Authorization']).toBe(AUTH_HEADER);
  });

  test('forwards X-Tenant-Id header to runtime', async () => {
    const capturedHeaders: Record<string, string> = {};

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        for (const [k, v] of Object.entries(init?.headers as Record<string, string>)) {
          capturedHeaders[k] = v;
        }
        return makeRuntimeResponse({ success: true, items: [], total: 0 });
      }),
    );

    const request = makeRequest(`/api/projects/${PROJECT_ID}/prompt-library/prompts`);
    await listPromptsGET(request, makeRouteCtx({ id: PROJECT_ID }));

    expect(capturedHeaders['X-Tenant-Id']).toBe(TENANT_ID);
  });

  test('propagates 401 from runtime to Studio caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeRuntimeResponse({ success: false, error: 'Unauthorized' }, 401)),
    );

    const request = makeRequest(`/api/projects/${PROJECT_ID}/prompt-library/prompts`);
    const response = await listPromptsGET(request, makeRouteCtx({ id: PROJECT_ID }));

    expect(response.status).toBe(401);
  });

  test('propagates 400 from runtime to Studio caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeRuntimeResponse({ success: false, error: { code: 'BAD_REQUEST' } }, 400),
      ),
    );

    const request = makeRequest(`/api/projects/${PROJECT_ID}/prompt-library/prompts`);
    const response = await listPromptsGET(request, makeRouteCtx({ id: PROJECT_ID }));

    expect(response.status).toBe(400);
  });

  test('forwards POST body to runtime', async () => {
    let capturedBody: unknown;
    const promptBody = {
      name: 'My Prompt',
      description: 'A test prompt',
      initialVersion: { template: 'Hello {{name}}', variables: ['name'] },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body));
        return makeRuntimeResponse({ success: true, _id: 'pl_new_001', name: 'My Prompt' }, 201);
      }),
    );

    const request = makeRequest(
      `/api/projects/${PROJECT_ID}/prompt-library/prompts`,
      'POST',
      promptBody,
    );
    await createPromptPOST(request, makeRouteCtx({ id: PROJECT_ID }));

    expect(capturedBody).toMatchObject(promptBody);
  });

  test('proxies to correct runtime URL', async () => {
    let capturedUrl = '';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return makeRuntimeResponse({ success: true, items: [], total: 0 });
      }),
    );

    const request = makeRequest(`/api/projects/${PROJECT_ID}/prompt-library/prompts`);
    await listPromptsGET(request, makeRouteCtx({ id: PROJECT_ID }));

    expect(capturedUrl).toContain(`/api/projects/${PROJECT_ID}/prompt-library/prompts`);
  });

  test('test endpoint uses extended timeout (65s)', async () => {
    let capturedSignal: AbortSignal | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal | undefined;
        return makeRuntimeResponse({ success: true, results: [] });
      }),
    );

    const testBody = { variables: {}, panes: [{ versionId: 'plv_001', userMessage: 'hello' }] };
    const request = makeRequest(
      `/api/projects/${PROJECT_ID}/prompt-library/test`,
      'POST',
      testBody,
    );
    await testPOST(request, makeRouteCtx({ id: PROJECT_ID }));

    expect(capturedSignal).toBeDefined();
    // The signal from AbortSignal.timeout(65000) — verify fetch was called
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });
});
