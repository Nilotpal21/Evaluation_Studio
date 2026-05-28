import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://localhost:3112',
}));

const { logError } = vi.hoisted(() => ({
  logError: vi.fn(),
}));
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
    debug: vi.fn(),
  }),
}));

const mockFetch = vi.fn();

const authenticatedUser = {
  id: 'user-1',
  email: 'test@test.com',
  name: 'Test User',
  tenantId: 'tenant-1',
};

const projectAccess = {
  projectId: 'project-1',
  role: 'admin',
};

const MAX_PROXY_UPLOAD_BYTES = 20 * 1024 * 1024;

function makeRequest(url: string, opts: Record<string, unknown> = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    ...opts,
    headers: {
      Authorization: 'Bearer test-jwt-token',
      'X-Tenant-Id': 'spoofed-tenant',
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
}

function makeAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

import { GET, POST } from '@/app/api/projects/[id]/sessions/[sessionId]/attachments/route';

describe('Project Session Attachments Proxy Route', () => {
  const routeParams = {
    params: Promise.resolve({ id: 'project-1', sessionId: 'session-1' }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue(projectAccess);
    mockIsAccessError.mockReturnValue(false);

    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('forwards GET list requests to runtime with auth headers and query params', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () =>
        JSON.stringify({
          success: true,
          data: {
            attachments: [
              {
                id: 'att-1',
                originalFilename: 'note.txt',
              },
            ],
            total: 1,
          },
        }),
      json: async () => ({
        success: true,
        data: {
          attachments: [
            {
              id: 'att-1',
              originalFilename: 'note.txt',
            },
          ],
          total: 1,
        },
      }),
    });

    const request = makeRequest(
      '/api/projects/project-1/sessions/session-1/attachments?limit=10&offset=20',
    );

    const response = await GET(request, routeParams);
    const body = await response.json();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3112/api/projects/project-1/sessions/session-1/attachments?limit=10&offset=20',
    );
    expect(init.headers).toEqual({
      Authorization: 'Bearer test-jwt-token',
      'X-Tenant-Id': 'tenant-1',
    });

    expect(response.status).toBe(200);
    expect(body.data.total).toBe(1);
    expect(body.data.attachments[0].originalFilename).toBe('note.txt');
  });

  test('normalizes invalid GET pagination values before forwarding to runtime', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () =>
        JSON.stringify({
          success: true,
          data: {
            attachments: [],
            total: 0,
          },
        }),
      json: async () => ({
        success: true,
        data: {
          attachments: [],
          total: 0,
        },
      }),
    });

    const request = makeRequest(
      '/api/projects/project-1/sessions/session-1/attachments?limit=9007199254740992&offset=-7',
    );

    await GET(request, routeParams);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3112/api/projects/project-1/sessions/session-1/attachments?limit=200&offset=0',
    );
  });

  test('forwards POST upload requests to runtime with auth headers, tenant context, and body bytes', async () => {
    mockFetch.mockResolvedValue({
      status: 201,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () =>
        JSON.stringify({
          success: true,
          attachmentId: 'att-123',
          status: 'accepted',
        }),
      json: async () => ({
        success: true,
        attachmentId: 'att-123',
        status: 'accepted',
      }),
    });

    const multipartBody = [
      '--boundary-123',
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      'Content-Type: text/plain',
      '',
      'hello from studio proxy',
      '--boundary-123--',
      '',
    ].join('\r\n');

    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=boundary-123',
      },
      body: multipartBody,
    });

    const response = await POST(request, routeParams);
    const body = await response.json();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3112/api/projects/project-1/sessions/session-1/attachments');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer test-jwt-token',
      'X-Tenant-Id': 'tenant-1',
      'Content-Type': 'multipart/form-data; boundary=boundary-123',
    });

    expect(Buffer.from(init.body as ArrayBuffer).toString('utf8')).toContain(
      'hello from studio proxy',
    );

    expect(response.status).toBe(201);
    expect(body.attachmentId).toBe('att-123');
  });

  test('returns auth error without calling runtime when tenant auth fails', async () => {
    const authError = NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } },
      { status: 401 },
    );
    mockRequireTenantAuth.mockResolvedValue(authError);
    mockIsAuthError.mockReturnValue(true);

    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments');
    const response = await GET(request, routeParams);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns access error without calling runtime when project access fails', async () => {
    const accessError = NextResponse.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } },
      { status: 404 },
    );
    mockRequireProjectAccess.mockResolvedValue(accessError);
    mockIsAccessError.mockReturnValue(true);

    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments');
    const response = await GET(request, routeParams);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns 504 when runtime upload proxy times out', async () => {
    vi.useFakeTimers();

    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          reject(new Error('Missing abort signal'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(makeAbortError());
          },
          { once: true },
        );
      });
    });

    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=boundary-123',
      },
      body: 'timed out body',
    });

    const pendingResponse = POST(request, routeParams);
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pendingResponse;
    const body = await response.json();

    expect(response.status).toBe(504);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'PROXY_TIMEOUT',
        message: 'Runtime did not respond within 30s',
      },
    });
    expect(logError).toHaveBeenCalledWith('Timeout proxying attachment upload', {
      projectId: 'project-1',
      sessionId: 'session-1',
      error: 'aborted',
    });
  });

  test('returns 413 without calling runtime when upload content-length exceeds 20MB', async () => {
    const oversizedBody = 'a'.repeat(MAX_PROXY_UPLOAD_BYTES + 1);
    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=boundary-123',
      },
      body: oversizedBody,
    });

    const response = await POST(request, routeParams);
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body too large (max 20MB)',
      },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('rejects oversized uploads without content-length before waiting for the rest of the stream', async () => {
    vi.useFakeTimers();

    let response: NextResponse | null = null;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROXY_UPLOAD_BYTES + 1));
        setTimeout(() => {
          try {
            controller.close();
          } catch {
            // Route may cancel the stream once it has enough data.
          }
        }, 60_000);
      },
    });

    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=boundary-123',
      },
      body: oversizedStream,
      duplex: 'half',
    });

    const pendingResponse = POST(request, routeParams).then((value) => {
      response = value;
      return value;
    });

    try {
      await vi.advanceTimersByTimeAsync(5);

      expect(response).not.toBeNull();
      if (response) {
        await expect(response.json()).resolves.toEqual({
          success: false,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body too large (max 20MB)',
          },
        });
      }

      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await vi.advanceTimersByTimeAsync(60_000);
      await pendingResponse;
    }
  });

  test('times out a slow inbound upload body before the downstream runtime fetch path', async () => {
    vi.useFakeTimers();

    let response: NextResponse | null = null;
    const slowStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x61]));
        setTimeout(() => {
          try {
            controller.close();
          } catch {
            // Route may cancel the stream once the timeout fires.
          }
        }, 60_000);
      },
    });

    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=boundary-123',
      },
      body: slowStream,
      duplex: 'half',
    });

    const pendingResponse = POST(request, routeParams).then((value) => {
      response = value;
      return value;
    });

    try {
      await vi.advanceTimersByTimeAsync(30_001);

      expect(response).not.toBeNull();
      if (response) {
        const body = await response.json();
        expect(response.status).toBe(408);
        expect(body).toEqual({
          success: false,
          error: {
            code: 'UPLOAD_TIMEOUT',
            message: 'Upload did not complete within 30s',
          },
        });
      }

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith('Timeout reading attachment upload body', {
        projectId: 'project-1',
        sessionId: 'session-1',
        error: 'Upload body did not complete within 30s',
      });
    } finally {
      await vi.advanceTimersByTimeAsync(30_000);
      await pendingResponse;
    }
  });

  test('preserves non-json runtime errors instead of collapsing them into 502s', async () => {
    mockFetch.mockResolvedValue({
      status: 413,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/plain' : null),
      },
      text: async () => 'File exceeds limit',
    });

    const request = makeRequest('/api/projects/project-1/sessions/session-1/attachments');
    const response = await GET(request, routeParams);

    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toContain('text/plain');
    await expect(response.text()).resolves.toBe('File exceeds limit');
  });
});
