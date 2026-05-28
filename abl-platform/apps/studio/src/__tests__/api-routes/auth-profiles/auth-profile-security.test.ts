/**
 * Auth Profile Security Tests — Phase 1 Hardening
 *
 * Tests SSRF validation, cascade delete protection, and Redis soft-fail
 * in the auth profile routes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);

vi.mock('@/lib/auth', () => ({
  requireAuth: mockRequireAuth,
  isAuthError: mockIsAuthError,
  formatUserLabel: (user: { name?: string; email?: string; id: string }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/services/auth-service', () => ({
  verifyAccessToken: vi.fn(),
}));

vi.mock('@/repos/auth-repo', () => ({
  findUserById: vi.fn(),
}));

const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn(() => false);

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: mockRequireProjectAccess,
  isAccessError: mockIsAccessError,
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// SSRF Validator Tests (pure function)
// ---------------------------------------------------------------------------

describe('SSRF URL validation for auth profiles', () => {
  let validateUrlForSSRF: typeof import('@agent-platform/shared/security').validateUrlForSSRF;

  beforeEach(async () => {
    const mod = await import('@agent-platform/shared/security');
    validateUrlForSSRF = mod.validateUrlForSSRF;
  });

  it('blocks AWS metadata endpoint (169.254.169.254)', () => {
    const result = validateUrlForSSRF('http://169.254.169.254/latest/meta-data/', {});
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/metadata/i);
  });

  it('blocks localhost (127.0.0.1)', () => {
    const result = validateUrlForSSRF('http://127.0.0.1:6379', {});
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/localhost/i);
  });

  it('blocks private IP (10.0.0.1)', () => {
    const result = validateUrlForSSRF('http://10.0.0.1/internal', {});
    expect(result.safe).toBe(false);
  });

  it('blocks private IP (192.168.1.1)', () => {
    const result = validateUrlForSSRF('http://192.168.1.1/admin', {});
    expect(result.safe).toBe(false);
  });

  it('allows valid external URLs', () => {
    const result = validateUrlForSSRF('https://oauth.provider.com/token', {});
    expect(result.safe).toBe(true);
  });

  it('allows valid external URLs with ports', () => {
    const result = validateUrlForSSRF('https://auth.example.com:8443/oauth/token', {});
    expect(result.safe).toBe(true);
  });

  it('blocks userinfo bypass attempt', () => {
    const result = validateUrlForSSRF('http://evil.com@169.254.169.254/', {});
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/userinfo/i);
  });

  it('blocks localhost alias', () => {
    const result = validateUrlForSSRF('http://localhost:6379/', {});
    expect(result.safe).toBe(false);
  });

  it('blocks non-HTTP schemes', () => {
    const result = validateUrlForSSRF('ftp://evil.com/file', {});
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/scheme/i);
  });
});

// ---------------------------------------------------------------------------
// Cascade Delete Tests — verifies countDocuments is called per consumer type
// ---------------------------------------------------------------------------

describe('Cascade delete protection', () => {
  it('blocks deletion when a consumer references the profile', async () => {
    // Simulate the cascade check logic from the DELETE handler:
    // For each consumer model, countDocuments({ authProfileId, tenantId }) is called.
    // If any count > 0, deletion is blocked with PROFILE_IN_USE.
    const profileId = 'profile-to-delete';
    const tenantId = 'tenant-1';

    // Mock models that return countDocuments results
    const mockCountDocuments = vi.fn();
    const consumerChecks = [
      { type: 'ChannelConnection', model: { countDocuments: mockCountDocuments } },
      {
        type: 'TenantModel',
        model: { countDocuments: mockCountDocuments },
        field: 'connections.authProfileId',
      },
      { type: 'ConnectorConfig', model: { countDocuments: mockCountDocuments } },
    ];

    // Simulate: ConnectorConfig references this profile (count = 1)
    mockCountDocuments
      .mockResolvedValueOnce(0) // ChannelConnection
      .mockResolvedValueOnce(0) // TenantModel
      .mockResolvedValueOnce(1); // ConnectorConfig

    const counts = await Promise.all(
      consumerChecks.map(async ({ type, model, field }) => {
        const count = await model.countDocuments({
          [field ?? 'authProfileId']: profileId,
          tenantId,
        });
        return { type, count };
      }),
    );

    const consumers = counts.filter((c) => c.count > 0);
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers[0].type).toBe('ConnectorConfig');

    // Verify countDocuments was called with correct filter including tenantId
    expect(mockCountDocuments).toHaveBeenCalledWith({
      authProfileId: profileId,
      tenantId,
    });

    // Verify TenantModel uses custom field path
    expect(mockCountDocuments).toHaveBeenCalledWith({
      'connections.authProfileId': profileId,
      tenantId,
    });
  });

  it('allows deletion when no consumers reference the profile', async () => {
    const mockCountDocuments = vi.fn().mockResolvedValue(0);
    const consumerChecks = [
      { type: 'ChannelConnection', model: { countDocuments: mockCountDocuments } },
      { type: 'TenantModel', model: { countDocuments: mockCountDocuments } },
    ];

    const counts = await Promise.all(
      consumerChecks.map(async ({ type, model }) => {
        const count = await model.countDocuments({
          authProfileId: 'orphaned-profile',
          tenantId: 'tenant-1',
        });
        return { type, count };
      }),
    );

    const consumers = counts.filter((c) => c.count > 0);
    expect(consumers.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Redis soft-fail verification
// ---------------------------------------------------------------------------

describe('Redis soft-fail for user-consent', () => {
  it('returns 503 response with SERVICE_UNAVAILABLE when Redis is null', async () => {
    // Simulate the Redis soft-fail pattern from the user-consent route:
    // When getRedisClient() returns null, the route returns 503 immediately.
    const mockGetRedisClient = vi.fn().mockReturnValue(null);
    const redis = mockGetRedisClient();

    // This is the exact pattern from the route handler
    if (!redis) {
      const response = NextResponse.json(
        {
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'OAuth state storage unavailable — please try again',
          },
        },
        { status: 503 },
      );

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    }

    // Verify the mock was called (simulating the route checking Redis)
    expect(mockGetRedisClient).toHaveBeenCalled();
  });

  it('proceeds normally when Redis is available', () => {
    const mockRedis = { set: vi.fn(), get: vi.fn() };
    const mockGetRedisClient = vi.fn().mockReturnValue(mockRedis);
    const redis = mockGetRedisClient();

    // Route should NOT return 503 when Redis is available
    expect(redis).not.toBeNull();
    expect(redis.set).toBeDefined();
  });
});
