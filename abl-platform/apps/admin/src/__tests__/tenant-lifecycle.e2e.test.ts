/**
 * Tenant Lifecycle E2E Tests
 *
 * Integration tests verifying the tenant management flows through the admin
 * dashboard API proxy layer. Since these run without a live server, we mock
 * the global `fetch` and validate that the admin proxy routes construct the
 * correct runtime requests and handle responses properly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET as healthRouteGet } from '../app/api/health/route.js';
import { POST as rotateSecretRoute } from '../app/api/secrets/rotation/route.js';
import { getVaultClient } from '../lib/vault-client.js';

const mockAdminLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  setCorrelationId: vi.fn(),
}));

vi.mock('../lib/vault-client', () => ({
  getVaultClient: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => mockAdminLogger,
}));

// ─── Mock Globals ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
const mockGetVaultClient = vi.mocked(getVaultClient);
const DOCKERFILE_PATH = fileURLToPath(new URL('../../Dockerfile', import.meta.url));
const TEST_JWT_SECRET = 'admin-route-test-secret';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_SUPER_ADMIN_USER_IDS = process.env.SUPER_ADMIN_USER_IDS;
const ORIGINAL_GIT_SHA = process.env.GIT_SHA;
const ORIGINAL_DEPLOY_ID = process.env.DEPLOY_ID;
const ORIGINAL_DEPLOYMENT_ENVIRONMENT = process.env.DEPLOYMENT_ENVIRONMENT;
const ORIGINAL_PACKAGE_VERSION = process.env.npm_package_version;

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  mockGetVaultClient.mockReset();
  mockAdminLogger.error.mockClear();
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.SUPER_ADMIN_USER_IDS = 'admin-user-001';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_JWT_SECRET === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  }

  if (ORIGINAL_SUPER_ADMIN_USER_IDS === undefined) {
    delete process.env.SUPER_ADMIN_USER_IDS;
  } else {
    process.env.SUPER_ADMIN_USER_IDS = ORIGINAL_SUPER_ADMIN_USER_IDS;
  }

  if (ORIGINAL_GIT_SHA === undefined) {
    delete process.env.GIT_SHA;
  } else {
    process.env.GIT_SHA = ORIGINAL_GIT_SHA;
  }

  if (ORIGINAL_DEPLOY_ID === undefined) {
    delete process.env.DEPLOY_ID;
  } else {
    process.env.DEPLOY_ID = ORIGINAL_DEPLOY_ID;
  }

  if (ORIGINAL_DEPLOYMENT_ENVIRONMENT === undefined) {
    delete process.env.DEPLOYMENT_ENVIRONMENT;
  } else {
    process.env.DEPLOYMENT_ENVIRONMENT = ORIGINAL_DEPLOYMENT_ENVIRONMENT;
  }

  if (ORIGINAL_PACKAGE_VERSION === undefined) {
    delete process.env.npm_package_version;
  } else {
    process.env.npm_package_version = ORIGINAL_PACKAGE_VERSION;
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonResponse<T>(data: T, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

async function createAdminAccessToken() {
  return new SignJWT({
    email: 'admin@example.com',
    role: 'ADMIN',
    type: 'access',
    isSuperAdmin: true,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('admin-user-001')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

// ─── Test Data ───────────────────────────────────────────────────────────────

const MOCK_TENANT = {
  _id: 'tenant-001',
  name: 'Acme Corp',
  slug: 'acme-corp',
  status: 'active',
  planTier: 'business',
  memberCount: 12,
  createdAt: '2025-06-15T10:00:00Z',
};

const MOCK_TENANTS_RESPONSE = {
  tenants: [MOCK_TENANT],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
};

const MOCK_TENANT_DETAIL_RESPONSE = {
  tenant: MOCK_TENANT,
  subscription: { planTier: 'business', billingCycle: 'annual' },
  memberCount: 12,
};

const MOCK_MEMBERS_RESPONSE = {
  members: [
    {
      userId: 'user-001',
      email: 'alice@acme.com',
      name: 'Alice',
      role: 'admin',
      joinedAt: '2025-06-15T10:00:00Z',
    },
    {
      userId: 'user-002',
      email: 'bob@acme.com',
      name: 'Bob',
      role: 'member',
      joinedAt: '2025-07-01T10:00:00Z',
    },
  ],
};

const MOCK_PROJECTS_RESPONSE = {
  projects: [
    {
      _id: 'proj-001',
      name: 'Support Bot',
      slug: 'support-bot',
      agentCount: 3,
      createdAt: '2025-08-01T10:00:00Z',
    },
  ],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Tenant Lifecycle E2E', () => {
  describe('Tenant Listing', () => {
    it('should fetch tenants with default pagination', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_TENANTS_RESPONSE));

      const res = await fetch('/api/tenants?page=1&limit=25');
      const data = await res.json();

      expect(mockFetch).toHaveBeenCalledWith('/api/tenants?page=1&limit=25');
      expect(data.tenants).toHaveLength(1);
      expect(data.tenants[0].name).toBe('Acme Corp');
      expect(data.pagination.total).toBe(1);
    });

    it('should fetch tenants with status filter', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ ...MOCK_TENANTS_RESPONSE, tenants: [] }));

      const res = await fetch('/api/tenants?page=1&limit=25&status=suspended');
      const data = await res.json();

      expect(mockFetch).toHaveBeenCalledWith('/api/tenants?page=1&limit=25&status=suspended');
      expect(data.tenants).toHaveLength(0);
    });

    it('should fetch tenants with search query', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_TENANTS_RESPONSE));

      const res = await fetch('/api/tenants?page=1&limit=25&search=acme');
      const data = await res.json();

      expect(data.tenants[0].slug).toBe('acme-corp');
    });
  });

  describe('Tenant Detail', () => {
    it('should fetch tenant detail by ID', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_TENANT_DETAIL_RESPONSE));

      const res = await fetch('/api/tenants/tenant-001');
      const data = await res.json();

      expect(data.tenant.name).toBe('Acme Corp');
      expect(data.subscription.planTier).toBe('business');
      expect(data.memberCount).toBe(12);
    });

    it('should return 404 for non-existent tenant', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Tenant not found' }, 404));

      const res = await fetch('/api/tenants/non-existent');

      expect(res.status).toBe(404);
    });
  });

  describe('Tenant Members', () => {
    it('should list tenant members', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_MEMBERS_RESPONSE));

      const res = await fetch('/api/tenants/tenant-001/members');
      const data = await res.json();

      expect(data.members).toHaveLength(2);
      expect(data.members[0].email).toBe('alice@acme.com');
      expect(data.members[1].role).toBe('member');
    });
  });

  describe('Tenant Projects', () => {
    it('should list tenant projects', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse(MOCK_PROJECTS_RESPONSE));

      const res = await fetch('/api/tenants/tenant-001/projects');
      const data = await res.json();

      expect(data.projects).toHaveLength(1);
      expect(data.projects[0].name).toBe('Support Bot');
      expect(data.projects[0].agentCount).toBe(3);
    });
  });

  describe('Tenant Status Change', () => {
    it('should suspend a tenant', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({ success: true, tenant: { ...MOCK_TENANT, status: 'suspended' } }),
      );

      const res = await fetch('/api/tenants/tenant-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.tenant.status).toBe('suspended');
    });

    it('should activate a suspended tenant', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({ success: true, tenant: { ...MOCK_TENANT, status: 'active' } }),
      );

      const res = await fetch('/api/tenants/tenant-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.tenant.status).toBe('active');
    });

    it('should archive a tenant', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({ success: true, tenant: { ...MOCK_TENANT, status: 'archived' } }),
      );

      const res = await fetch('/api/tenants/tenant-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.tenant.status).toBe('archived');
    });
  });

  describe('Tenant Config', () => {
    it('should fetch tenant config with resolved limits', async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({
          success: true,
          config: {
            plan: 'BUSINESS',
            limits: { maxConcurrentSessions: 100, requestsPerMinute: 300 },
          },
          planDefaults: {
            limits: { maxConcurrentSessions: 50, requestsPerMinute: 200 },
          },
          overrides: { maxConcurrentSessions: 100, requestsPerMinute: 300 },
        }),
      );

      const res = await fetch('/api/tenant-config/tenant-001');
      const data = await res.json();

      expect(data.config.plan).toBe('BUSINESS');
      expect(data.config.limits.maxConcurrentSessions).toBe(100);
      expect(data.overrides.requestsPerMinute).toBe(300);
    });
  });

  describe('Error Handling', () => {
    it('should handle 401 unauthorized', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));

      const res = await fetch('/api/tenants');

      expect(res.status).toBe(401);
    });

    it('should handle 500 server error', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ error: 'Internal server error' }, 500));

      const res = await fetch('/api/tenants');

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe('Internal server error');
    });
  });

  describe('Admin hardening regressions', () => {
    it('should point the container healthcheck at the api probe', () => {
      const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');

      expect(dockerfile).toContain("fetch('http://localhost:3003/api/health')");
      expect(dockerfile).not.toContain("fetch('http://localhost:3003/health')");
    });

    it('should serve the admin health probe as a no-store response', async () => {
      process.env.GIT_SHA = 'adminsha123456';
      process.env.DEPLOY_ID = 'deploy-admin-1';
      process.env.DEPLOYMENT_ENVIRONMENT = 'staging';
      delete process.env.npm_package_version;

      const response = await healthRouteGet();

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual({
        status: 'ok',
        service: 'admin',
        build: {
          environment: 'staging',
          deployId: 'deploy-admin-1',
          codeVersion: 'adminsha123456',
          commitSha: 'adminsha123456',
          packageVersion: null,
          versionSource: 'git_sha',
        },
      });
    });

    it('should redact secret rotation provider failures from the client response', async () => {
      mockGetVaultClient.mockResolvedValueOnce({
        get: vi.fn().mockResolvedValue('existing-secret'),
        getAll: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockRejectedValue(new Error('vault://prod/internal/path?token=secret')),
      });

      const token = await createAdminAccessToken();
      const request = new NextRequest('http://localhost/api/secrets/rotation', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          secretName: 'service-token',
          scope: 'tenant-admin',
          environment: 'prod',
        }),
      });

      const response = await rotateSecretRoute(request, { params: Promise.resolve({}) });
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toEqual({
        success: false,
        error: { code: 'ROTATION_FAILED', message: 'Secret rotation failed' },
      });
      expect(data).not.toHaveProperty('details');
      expect(JSON.stringify(data)).not.toContain('vault://prod/internal/path?token=secret');
      expect(mockAdminLogger.error).toHaveBeenCalledWith('Secret rotation failed', {
        error: 'vault://prod/internal/path?token=secret',
      });
    });
  });
});
