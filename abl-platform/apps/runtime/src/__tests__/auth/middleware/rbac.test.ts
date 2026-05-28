/**
 * RBAC Middleware Tests
 *
 * Covers requireWriteAccess: tenant context missing (401),
 * insufficient role (403), and valid write roles.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockResolveProjectCustomRolePermissions = vi.fn();

// Mock the project-repo module before importing rbac
vi.mock('../../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn(),
  findProjectMember: vi.fn(),
}));

vi.mock('../../../services/permission-resolution.js', () => ({
  clearPermissionCache: vi.fn(),
  resolveProjectCustomRolePermissions: (...args: any[]) =>
    mockResolveProjectCustomRolePermissions(...args),
}));

import {
  evaluateProjectPermission,
  requireWriteAccess,
  requireProjectPermission,
  requireSensitiveProjectPermission,
  requireProjectWideAnalyticsAccess,
  WRITE_ROLES,
  READ_ROLES,
} from '../../../middleware/rbac.js';
import { findProjectByIdAndTenant, findProjectMember } from '../../../repos/project-repo.js';

// =============================================================================
// HELPERS
// =============================================================================

function createMockReq(tenantContext?: { tenantId: string; userId: string; role?: string }): any {
  return {
    tenantContext,
    params: {},
    reportAccessDenied: vi.fn(),
  };
}

function createMockRes(): any {
  const res: any = {
    statusCode: 0,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// =============================================================================
// TESTS
// =============================================================================

describe('RBAC Middleware', () => {
  beforeEach(() => {
    vi.mocked(findProjectByIdAndTenant).mockReset();
    vi.mocked(findProjectMember).mockReset();
    mockResolveProjectCustomRolePermissions.mockReset();
    mockResolveProjectCustomRolePermissions.mockResolvedValue([]);
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  describe('role constants', () => {
    test('WRITE_ROLES includes OWNER, ADMIN, OPERATOR', () => {
      expect(WRITE_ROLES).toContain('OWNER');
      expect(WRITE_ROLES).toContain('ADMIN');
      expect(WRITE_ROLES).toContain('OPERATOR');
      expect(WRITE_ROLES).not.toContain('VIEWER');
    });

    test('READ_ROLES includes all write roles plus VIEWER', () => {
      for (const role of WRITE_ROLES) {
        expect(READ_ROLES).toContain(role);
      }
      expect(READ_ROLES).toContain('VIEWER');
    });
  });

  // ---------------------------------------------------------------------------
  // requireWriteAccess
  // ---------------------------------------------------------------------------

  describe('requireWriteAccess', () => {
    test('returns false and sends 401 when tenantContext is missing', async () => {
      const req = createMockReq(undefined);
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' },
        required: 'tenant:write',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: 'runtime_rbac',
          scope: 'auth',
          reasonCode: 'AUTHENTICATION_REQUIRED',
          requiredPermission: 'tenant:write',
        }),
      );
    });

    test('returns false and sends 403 when role is missing', async () => {
      const req = createMockReq({ tenantId: 't1', userId: 'u1' });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'TENANT_WRITE_ROLE_REQUIRED', message: 'Insufficient permissions' },
        required: 'tenant:write',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: 'runtime_rbac',
          scope: 'rbac',
          reasonCode: 'TENANT_WRITE_ROLE_REQUIRED',
          requiredPermission: 'tenant:write',
        }),
      );
    });

    test('returns false and sends 403 for VIEWER role', async () => {
      const req = createMockReq({ tenantId: 't1', userId: 'u1', role: 'VIEWER' });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
    });

    test('returns true for OWNER role', async () => {
      const req = createMockReq({ tenantId: 't1', userId: 'u1', role: 'OWNER' });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(true);
    });

    test('returns true for ADMIN role', async () => {
      const req = createMockReq({ tenantId: 't1', userId: 'u1', role: 'ADMIN' });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(true);
    });

    test('returns true for OPERATOR role', async () => {
      const req = createMockReq({ tenantId: 't1', userId: 'u1', role: 'OPERATOR' });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(true);
    });

    test('returns false for unknown role', async () => {
      const req = createMockReq({ tenantId: 't1', userId: 'u1', role: 'GUEST' });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
    });

    test('uses the role on tenantContext directly', async () => {
      const req = createMockReq({ tenantId: 'tenant_42', userId: 'user_99', role: 'ADMIN' });
      const res = createMockRes();

      const result = await requireWriteAccess(req, res);

      expect(result).toBe(true);
      expect(req.tenantContext).toEqual({
        tenantId: 'tenant_42',
        userId: 'user_99',
        role: 'ADMIN',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // requireProjectPermission — SDK projectId mismatch guard
  // ---------------------------------------------------------------------------

  describe('requireProjectPermission', () => {
    function createSdkReq(
      ctxProjectId: string | undefined,
      routeProjectId: string | undefined,
      permissions: string[] = ['session:create', 'session:read'],
    ): any {
      return {
        tenantContext: {
          tenantId: 't1',
          userId: 'sdk:webchat',
          authType: 'sdk_session',
          projectId: ctxProjectId,
          permissions,
        },
        params: { projectId: routeProjectId },
        reportAccessDenied: vi.fn(),
      };
    }

    test('SDK auth with matching projectId returns true (bypasses RBAC)', async () => {
      const req = createSdkReq('proj-A', 'proj-A');
      const res = createMockRes();

      const result = await requireProjectPermission(req, res, 'session:create');

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0); // no status set
    });

    test('SDK auth with mismatched projectId returns false with 404', async () => {
      const req = createSdkReq('proj-A', 'proj-B');
      const res = createMockRes();

      const result = await requireProjectPermission(req, res, 'session:create');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'SDK_PROJECT_SCOPE_MISMATCH', message: 'Project not found' },
        required: 'session:create',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: 'runtime_rbac',
          scope: 'project',
          reasonCode: 'SDK_PROJECT_SCOPE_MISMATCH',
          requiredPermission: 'session:create',
        }),
      );
    });

    test('SDK auth with no routeProjectId returns true (no check needed)', async () => {
      const req = createSdkReq('proj-A', undefined);
      const res = createMockRes();

      const result = await requireProjectPermission(req, res, 'session:create');

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
    });

    test('SDK auth with no ctx.projectId is rejected (fail-closed)', async () => {
      const req = createSdkReq(undefined, 'proj-A');
      const res = createMockRes();

      const result = await requireProjectPermission(req, res, 'session:create');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
    });

    test('SDK auth with empty permissions returns 403', async () => {
      const req = createSdkReq('proj-A', 'proj-A', []);
      const res = createMockRes();

      const result = await requireProjectPermission(req, res, 'session:create');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: 'session:create',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: 'runtime_rbac',
          scope: 'rbac',
          reasonCode: 'PERMISSION_REQUIRED',
          requiredPermission: 'session:create',
        }),
      );
    });

    test('SDK auth with insufficient permissions returns 403', async () => {
      const req = createSdkReq('proj-A', 'proj-A', ['agent:read']);
      const res = createMockRes();

      const result = await requireProjectPermission(req, res, 'session:create');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
    });

    test('API key project scope mismatch is concealed as 404 before project lookup', async () => {
      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          authType: 'api_key',
          permissions: ['session:read'],
          projectScope: ['proj-A'],
        },
        params: { projectId: 'proj-B' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireProjectPermission(req as any, res, 'session:read');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'PROJECT_SCOPE_MISMATCH', message: 'Project not found' },
        required: 'session:read',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: 'runtime_rbac',
          scope: 'project',
          reasonCode: 'PROJECT_SCOPE_MISMATCH',
          concealAsNotFound: true,
          resourceType: 'project',
          resourceId: 'proj-B',
          requiredPermission: 'session:read',
        }),
      );
    });

    test('API keys are authorized by scoped permissions without membership fallback', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'creator-1',
          authType: 'api_key',
          permissions: ['agent:read'],
          projectScope: ['proj-A'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };

      const result = await evaluateProjectPermission(req as any, 'agent:read');

      expect(result).toEqual({
        allowed: true,
        accessLevel: 'api_key',
        projectId: 'proj-A',
      });
      expect(findProjectMember).not.toHaveBeenCalled();
    });

    test('API keys do not inherit project owner privileges from their creator', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({
        _id: 'proj-A',
        ownerId: 'creator-1',
      });

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'creator-1',
          authType: 'api_key',
          permissions: ['agent:read'],
          projectScope: ['proj-A'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireProjectPermission(req as any, res, 'agent:update');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: 'agent:update',
      });
      expect(findProjectMember).not.toHaveBeenCalled();
    });

    test('non-members are concealed as 404 without a membership leak', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue(null);

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          authType: 'user',
          permissions: ['session:read'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireProjectPermission(req as any, res, 'session:read');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'PROJECT_MEMBERSHIP_REQUIRED', message: 'Project not found' },
        required: 'session:read',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: 'runtime_rbac',
          scope: 'project',
          reasonCode: 'PROJECT_MEMBERSHIP_REQUIRED',
          concealAsNotFound: true,
          resourceType: 'project',
          resourceId: 'proj-A',
          requiredPermission: 'session:read',
        }),
      );
    });

    test('custom project roles resolve permission grants through the shared evaluator path', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue({
        role: 'custom',
        customRoleId: 'custom-role-1',
      });
      mockResolveProjectCustomRolePermissions.mockResolvedValue(['session:create']);

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          authType: 'user',
          permissions: ['session:read'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireProjectPermission(req as any, res, 'session:create');

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
      expect(mockResolveProjectCustomRolePermissions).toHaveBeenCalledWith('t1', 'custom-role-1');
    });
  });

  describe('requireSensitiveProjectPermission', () => {
    test('denies project admins when reveal is available only through wildcard role grants', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue({ role: 'admin' });

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          authType: 'user',
          permissions: ['session:read'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireSensitiveProjectPermission(req as any, res, 'pii:reveal');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'SENSITIVE_PERMISSION_REQUIRED', message: 'Forbidden' },
        message: "Project admin role does not have exact 'pii:reveal' permission",
        required: 'pii:reveal',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          layer: 'runtime_rbac',
          scope: 'rbac',
          reasonCode: 'SENSITIVE_PERMISSION_REQUIRED',
          requiredPermission: 'pii:reveal',
        }),
      );
    });

    test('denies tenant project admins without an exact pii reveal grant', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'tenant-admin-1',
          authType: 'user',
          permissions: ['project:*'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireSensitiveProjectPermission(req as any, res, 'pii:reveal');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(findProjectMember).not.toHaveBeenCalled();
      expect(res.body).toEqual({
        success: false,
        error: { code: 'SENSITIVE_PERMISSION_REQUIRED', message: 'Forbidden' },
        required: 'pii:reveal',
      });
    });

    test('allows tenant project admins only when pii reveal is explicitly granted', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'tenant-admin-1',
          authType: 'user',
          permissions: ['project:*', 'pii:reveal'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireSensitiveProjectPermission(req as any, res, 'pii:reveal');

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
      expect(findProjectMember).not.toHaveBeenCalled();
    });

    test('allows custom privacy roles with exact pii reveal within the project', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue({
        role: 'custom',
        customRoleId: 'custom-privacy-role',
      });
      mockResolveProjectCustomRolePermissions.mockResolvedValue(['pii:reveal']);

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          authType: 'user',
          permissions: ['session:read'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireSensitiveProjectPermission(req as any, res, 'pii:reveal');

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
      expect(mockResolveProjectCustomRolePermissions).toHaveBeenCalledWith(
        't1',
        'custom-privacy-role',
      );
    });

    test('allows API keys with project scope and exact pii reveal only', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'key-creator-1',
          authType: 'api_key',
          permissions: ['pii:reveal'],
          projectScope: ['proj-A'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireSensitiveProjectPermission(req as any, res, 'pii:reveal');

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
      expect(findProjectMember).not.toHaveBeenCalled();
    });

    test('denies API keys with exact pii reveal but no project scope', async () => {
      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'key-creator-1',
          authType: 'api_key',
          permissions: ['pii:reveal'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireSensitiveProjectPermission(req as any, res, 'pii:reveal');

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: 'API_KEY_PROJECT_SCOPE_REQUIRED',
          message: 'API key missing project scope',
        },
        required: 'pii:reveal',
      });
      expect(findProjectByIdAndTenant).not.toHaveBeenCalled();
      expect(findProjectMember).not.toHaveBeenCalled();
    });
  });

  describe('evaluateProjectPermission', () => {
    test('conceals non-members by default when options are omitted', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue(null);

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          authType: 'user',
          permissions: ['session:read'],
        },
        params: {},
      };

      const result = await evaluateProjectPermission(req as any, 'session:read', 'proj-A');

      expect(result.allowed).toBe(false);
      if (result.allowed) {
        throw new Error('Expected evaluateProjectPermission to deny non-members');
      }
      expect(result.statusCode).toBe(404);
      expect(result.publicError).toBe('Project not found');
      expect(result.publicMessage).toBeUndefined();
      expect(result.reasonCode).toBe('PROJECT_MEMBERSHIP_REQUIRED');
      expect(result.concealAsNotFound).toBe(true);
    });

    // Regression guard: keeps the runtime tenant-admin bypass aligned with
    // Studio's `isTenantAdmin` (apps/studio/src/lib/project-access.ts), which
    // also passes on role OR `project:*`. A previous version of runtime only
    // accepted the permissions signal — tenant admins whose JWT lacked the
    // expanded `project:*` claim were 404'd on every project-scoped runtime
    // route. See packages/shared-auth/src/rbac/tenant-admin-roles.ts.
    test.each(['OWNER', 'ADMIN'])(
      'tenant-admin bypass passes on role=%s alone (no project:* in permissions, no membership)',
      async (role) => {
        vi.mocked(findProjectByIdAndTenant).mockResolvedValue({
          _id: 'proj-A',
          ownerId: 'owner-2',
        });
        vi.mocked(findProjectMember).mockResolvedValue(null);

        const req = {
          tenantContext: {
            tenantId: 't1',
            userId: 'user-1',
            role,
            authType: 'user',
            // Intentionally lacks project:* — exercises the role-only bypass.
            permissions: ['session:read'],
          },
          params: {},
        };

        const result = await evaluateProjectPermission(req as any, 'session:read', 'proj-A');

        expect(result.allowed).toBe(true);
        if (!result.allowed) {
          throw new Error('Expected role-based tenant-admin bypass to allow');
        }
        expect(result.accessLevel).toBe('tenant_admin');
      },
    );

    test('non-admin tenant role with no permissions and no membership is still denied (404)', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue(null);

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          role: 'MEMBER',
          authType: 'user',
          permissions: [],
        },
        params: {},
      };

      const result = await evaluateProjectPermission(req as any, 'session:read', 'proj-A');

      expect(result.allowed).toBe(false);
      if (result.allowed) {
        throw new Error('Expected non-admin role to be denied');
      }
      expect(result.statusCode).toBe(404);
      expect(result.reasonCode).toBe('PROJECT_MEMBERSHIP_REQUIRED');
    });
  });

  describe('requireProjectWideAnalyticsAccess', () => {
    function createProjectReq(
      role: 'admin' | 'developer' | 'tester' | 'viewer',
      overrides: Record<string, unknown> = {},
    ): any {
      return {
        tenantContext: {
          tenantId: 't1',
          userId: 'user-1',
          authType: 'user',
          permissions: ['session:read'],
          ...overrides,
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
        _projectRole: role,
      };
    }

    test('returns true for project admin members', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue({ role: 'admin' });

      const req = createProjectReq('admin');
      const res = createMockRes();

      const result = await requireProjectWideAnalyticsAccess(req, res);

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
    });

    test('returns true for tester members with analytics permission', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue({ role: 'tester' });

      const req = createProjectReq('tester');
      const res = createMockRes();

      const result = await requireProjectWideAnalyticsAccess(req, res);

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
    });

    test('returns true for tenant-wide project admins', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });

      const req = createProjectReq('viewer', {
        permissions: ['project:*', 'session:read'],
      });
      const res = createMockRes();

      const result = await requireProjectWideAnalyticsAccess(req, res);

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
      expect(findProjectByIdAndTenant).toHaveBeenCalledWith('proj-A', 't1');
    });

    test('returns true for developer members with analytics permission', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });
      vi.mocked(findProjectMember).mockResolvedValue({ role: 'developer' });

      const req = createProjectReq('developer');
      const res = createMockRes();

      const result = await requireProjectWideAnalyticsAccess(req, res);

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
      expect(req.reportAccessDenied).not.toHaveBeenCalled();
    });

    test('returns true for API keys with analytics.read in scope', async () => {
      vi.mocked(findProjectByIdAndTenant).mockResolvedValue({ _id: 'proj-A', ownerId: 'owner-2' });

      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'creator-1',
          authType: 'api_key',
          permissions: ['analytics:read'],
          projectScope: ['proj-A'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireProjectWideAnalyticsAccess(req as any, res);

      expect(result).toBe(true);
      expect(res.statusCode).toBe(0);
      expect(findProjectMember).not.toHaveBeenCalled();
    });

    test('returns false with 403 for sdk session callers', async () => {
      const req = {
        tenantContext: {
          tenantId: 't1',
          userId: 'sdk:web',
          authType: 'sdk_session',
          projectId: 'proj-A',
          permissions: ['session:read'],
        },
        params: { projectId: 'proj-A' },
        reportAccessDenied: vi.fn(),
      };
      const res = createMockRes();

      const result = await requireProjectWideAnalyticsAccess(req, res);

      expect(result).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'PERMISSION_REQUIRED', message: 'Forbidden' },
        required: 'analytics:read',
      });
      expect(req.reportAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: 'PERMISSION_REQUIRED',
          requiredPermission: 'analytics:read',
        }),
      );
    });
  });
});
