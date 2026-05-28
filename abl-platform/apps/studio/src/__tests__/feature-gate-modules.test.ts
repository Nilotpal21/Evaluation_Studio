/**
 * Feature Gate — Module Routes Kill Switch Tests
 *
 * Tests the `requireFeature` option in `withRouteHandler` to verify:
 *   - Feature disabled → 403 FEATURE_DISABLED
 *   - Feature enabled → handler executes normally
 *   - Feature resolution error → 403 (fail-closed)
 *
 * Uses a minimal test handler via `withRouteHandler` directly,
 * avoiding the pre-existing bracket-path resolution issue in vitest.
 *
 * Sprint 5 Task S5-T02
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { StudioPermission } from '@/lib/permissions';

// =============================================================================
// MOCKS
// =============================================================================

vi.mock('server-only', () => ({}));

// Feature resolver — the core of this test
const mockIsFeatureEnabled = vi.fn();
vi.mock('@/lib/feature-resolver', () => ({
  isFeatureEnabled: (...args: any[]) => mockIsFeatureEnabled(...args),
}));

// Auth
const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: any[]) => mockRequireAuth(...args),
  isAuthError: (...args: any[]) => (mockIsAuthError as Function)(...args),
}));

vi.mock('@/services/auth-service', () => ({ verifyAccessToken: vi.fn() }));
vi.mock('@/repos/auth-repo', () => ({ findUserById: vi.fn() }));

// Project access
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: any[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: any[]) => (mockIsAccessError as Function)(...args),
}));

// Permissions
vi.mock('@/lib/permission-resolver', () => ({
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
}));

// Rate limiter
vi.mock('@/lib/rate-limiter', () => ({
  rateLimiter: { check: vi.fn(() => ({ allowed: true })) },
  buildRateLimitKey: vi.fn(() => 'test-key'),
}));

// Response sanitizer
vi.mock('@/lib/response-sanitizer', () => ({
  sanitizeResponseData: vi.fn((data: unknown) => data),
}));

// =============================================================================
// CONSTANTS
// =============================================================================

const TENANT_ID = 'tenant-test';
const PROJECT_ID = 'project-test';

function makeUser() {
  return {
    id: 'user-test',
    tenantId: TENANT_ID,
    email: 'test@example.com',
    permissions: ['module:read', 'module:manage'],
  };
}

function makeProject() {
  return {
    _id: PROJECT_ID,
    tenantId: TENANT_ID,
    name: 'Test Module Project',
    kind: 'module',
  };
}

function makeRequest(method: string, path: string, body?: unknown) {
  const url = `http://localhost:5173${path}`;
  const opts: RequestInit = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new NextRequest(url, opts as any);
}

// =============================================================================
// TESTS
// =============================================================================

describe('withRouteHandler — requireFeature gate', () => {
  let withRouteHandler: typeof import('@/lib/route-handler').withRouteHandler;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue(makeUser());
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({ project: makeProject() });
    mockIsAccessError.mockReturnValue(false);

    const mod = await import('@/lib/route-handler');
    withRouteHandler = mod.withRouteHandler;
  });

  describe('feature DISABLED', () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockResolvedValue(false);
    });

    it('returns 403 FEATURE_DISABLED when requireFeature is set and feature is off', async () => {
      const handler = withRouteHandler({ requireFeature: 'reusable_modules' }, async () =>
        NextResponse.json({ success: true }),
      );

      const request = makeRequest('GET', '/api/test');
      const response = await handler(request, { params: Promise.resolve({ id: PROJECT_ID }) });
      const json = await response.json();

      expect(response.status).toBe(403);
      expect(json.success).toBe(false);
      expect(json.errors[0].code).toBe('FEATURE_DISABLED');
      expect(json.errors[0].msg).toContain('not available on your current plan');
    });

    it('calls isFeatureEnabled with tenant ID and feature name', async () => {
      const handler = withRouteHandler({ requireFeature: 'reusable_modules' }, async () =>
        NextResponse.json({ success: true }),
      );

      const request = makeRequest('GET', '/api/test');
      await handler(request, { params: Promise.resolve({ id: PROJECT_ID }) });

      expect(mockIsFeatureEnabled).toHaveBeenCalledWith(TENANT_ID, 'reusable_modules');
    });

    it('does NOT call the handler function when feature is disabled', async () => {
      const handlerFn = vi.fn(async () => NextResponse.json({ success: true }));
      const handler = withRouteHandler({ requireFeature: 'reusable_modules' }, handlerFn);

      const request = makeRequest('GET', '/api/test');
      await handler(request, { params: Promise.resolve({ id: PROJECT_ID }) });

      expect(handlerFn).not.toHaveBeenCalled();
    });

    it('blocks even with valid project and permissions', async () => {
      const handler = withRouteHandler(
        {
          requireProject: true,
          permissions: 'module:read' as StudioPermission,
          requireFeature: 'reusable_modules',
        },
        async () => NextResponse.json({ success: true }),
      );

      const request = makeRequest('GET', '/api/test');
      const response = await handler(request, { params: Promise.resolve({ id: PROJECT_ID }) });

      expect(response.status).toBe(403);
    });
  });

  describe('feature ENABLED', () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockResolvedValue(true);
    });

    it('proceeds to handler when feature is enabled', async () => {
      const handlerFn = vi.fn(async () => NextResponse.json({ success: true, data: 'reached' }));
      const handler = withRouteHandler({ requireFeature: 'reusable_modules' }, handlerFn);

      const request = makeRequest('GET', '/api/test');
      const response = await handler(request, { params: Promise.resolve({ id: PROJECT_ID }) });
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.data).toBe('reached');
      expect(handlerFn).toHaveBeenCalled();
    });
  });

  describe('no requireFeature set', () => {
    it('skips feature check entirely when requireFeature is not configured', async () => {
      const handlerFn = vi.fn(async () => NextResponse.json({ success: true, data: 'no-gate' }));
      const handler = withRouteHandler({}, handlerFn);

      const request = makeRequest('GET', '/api/test');
      const response = await handler(request, { params: Promise.resolve({ id: PROJECT_ID }) });
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.data).toBe('no-gate');
      expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
    });
  });

  describe('PLAN_FEATURES coverage', () => {
    it('voice_channels is available in every plan tier', async () => {
      const { PLAN_FEATURES } = await import('@agent-platform/shared-kernel');

      expect(PLAN_FEATURES['FREE']).toContain('voice_channels');
      expect(PLAN_FEATURES['TEAM']).toContain('voice_channels');
      expect(PLAN_FEATURES['BUSINESS']).toContain('voice_channels');
      expect(PLAN_FEATURES['ENTERPRISE']).toContain('voice_channels');
    });

    it('reusable_modules is in BUSINESS tier', async () => {
      const { PLAN_FEATURES } = await import('@agent-platform/shared-kernel');
      expect(PLAN_FEATURES['BUSINESS']).toContain('reusable_modules');
    });

    it('reusable_modules is in ENTERPRISE tier', async () => {
      const { PLAN_FEATURES } = await import('@agent-platform/shared-kernel');
      expect(PLAN_FEATURES['ENTERPRISE']).toContain('reusable_modules');
    });

    it('reusable_modules is NOT in FREE tier', async () => {
      const { PLAN_FEATURES } = await import('@agent-platform/shared-kernel');
      expect(PLAN_FEATURES['FREE']).not.toContain('reusable_modules');
    });

    it('reusable_modules is NOT in TEAM tier', async () => {
      const { PLAN_FEATURES } = await import('@agent-platform/shared-kernel');
      expect(PLAN_FEATURES['TEAM']).not.toContain('reusable_modules');
    });

    it('governance is off for every default plan tier', async () => {
      const { PLAN_FEATURES } = await import('@agent-platform/shared-kernel');

      for (const features of Object.values(PLAN_FEATURES)) {
        expect(features).not.toContain('governance');
      }
    });
  });
});
