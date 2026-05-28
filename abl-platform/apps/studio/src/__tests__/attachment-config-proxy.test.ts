/**
 * Attachment Config Proxy Route Tests (INT-1 through INT-4)
 *
 * Verifies that the Studio proxy route correctly:
 * - Forwards GET requests to runtime with auth headers
 * - Forwards PUT requests with body to runtime
 * - Returns auth error when requireTenantAuth fails
 * - Returns access error when requireProjectPermission fails
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// =============================================================================
// MOCKS
// =============================================================================

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectPermission = vi.fn();
const mockIsAccessError = vi.fn();
vi.mock('@/lib/project-permission', () => ({
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
  isProjectPermissionError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://localhost:3112',
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/api-response', () => ({
  handleApiError: vi.fn((_error: unknown, label: string) =>
    NextResponse.json(
      { success: false, error: { code: 'INTERNAL', message: label } },
      { status: 500 },
    ),
  ),
}));

const mockFetch = vi.fn();

// =============================================================================
// SETUP
// =============================================================================

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

beforeEach(() => {
  vi.clearAllMocks();

  // Default: auth succeeds
  mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
  mockIsAuthError.mockReturnValue(false);

  // Default: project access succeeds
  mockRequireProjectPermission.mockResolvedValue(projectAccess);
  mockIsAccessError.mockReturnValue(false);

  // Default fetch response
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        resolved: {
          enabled: true,
          maxFileSizeBytes: 20971520,
          maxFilesPerSession: 100,
          allowedMimeTypes: ['image/png'],
          piiPolicy: 'redact',
          defaultProcessingMode: 'full',
        },
        projectOverrides: null,
      },
    }),
  });
  vi.stubGlobal('fetch', mockFetch);
});

// =============================================================================
// HELPERS
// =============================================================================

function makeRequest(url: string, opts: Record<string, unknown> = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    ...opts,
    headers: {
      Authorization: 'Bearer test-jwt-token',
      'X-Tenant-Id': 'tenant-1',
      'Content-Type': 'application/json',
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
}

// =============================================================================
// TESTS
// =============================================================================

// Import the route handlers
import { GET, PUT } from '@/app/api/projects/[id]/attachment-config/route';

describe('Attachment Config Proxy Route', () => {
  const routeParams = { params: Promise.resolve({ id: 'project-1' }) };

  // INT-1: GET forwarding
  describe('GET /api/projects/:id/attachment-config', () => {
    test('forwards GET to runtime with auth headers and returns response', async () => {
      const request = makeRequest('/api/projects/project-1/attachment-config');

      const response = await GET(request, routeParams);
      const body = await response.json();

      // Verify fetch was called with correct URL and headers
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3112/api/projects/project-1/attachment-config');
      expect(init.method).toBe('GET');
      expect(init.headers['Authorization']).toBe('Bearer test-jwt-token');
      expect(init.headers['X-Tenant-Id']).toBe('tenant-1');
      expect(init.headers['Content-Type']).toBe('application/json');

      // Verify response is forwarded
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.resolved.defaultProcessingMode).toBe('full');
    });
  });

  // INT-2: PUT forwarding with body
  describe('PUT /api/projects/:id/attachment-config', () => {
    test('forwards PUT with body to runtime and returns response', async () => {
      const updateBody = { enabled: false, maxFileSizeBytes: 10485760 };
      const request = makeRequest('/api/projects/project-1/attachment-config', {
        method: 'PUT',
        body: JSON.stringify(updateBody),
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            resolved: {
              enabled: false,
              maxFileSizeBytes: 10485760,
              maxFilesPerSession: 100,
              allowedMimeTypes: ['image/png'],
              piiPolicy: 'redact',
              defaultProcessingMode: 'full',
            },
            projectOverrides: { enabled: false, maxFileSizeBytes: 10485760 },
          },
        }),
      });

      const response = await PUT(request, routeParams);
      const body = await response.json();

      // Verify fetch was called with body
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3112/api/projects/project-1/attachment-config');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify(updateBody));

      // Verify response
      expect(response.status).toBe(200);
      expect(body.data.resolved.enabled).toBe(false);
    });
  });

  // INT-3: Auth required — requireTenantAuth returns 401 NextResponse
  describe('Auth required', () => {
    test('returns 401 when requireTenantAuth fails — fetch is NOT called', async () => {
      const authError = NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } },
        { status: 401 },
      );
      mockRequireTenantAuth.mockResolvedValue(authError);
      mockIsAuthError.mockReturnValue(true);

      const request = makeRequest('/api/projects/project-1/attachment-config');
      const response = await GET(request, routeParams);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // INT-4: Project access required — requireProjectPermission returns 404 NextResponse
  describe('Project access required', () => {
    test('returns 404 when requireProjectAccess fails — fetch is NOT called', async () => {
      const accessError = NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } },
        { status: 404 },
      );
      mockRequireProjectPermission.mockResolvedValue(accessError);
      mockIsAccessError.mockReturnValue(true);

      const request = makeRequest('/api/projects/project-1/attachment-config');
      const response = await GET(request, routeParams);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
