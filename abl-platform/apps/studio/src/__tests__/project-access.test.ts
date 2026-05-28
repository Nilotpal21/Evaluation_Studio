/**
 * Tests for requireProjectAccess authorization helper.
 *
 * Covers: tenant-scoped lookup, membership-gated fallback, 401/404 error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock dependencies before importing the module under test
const { mockLogError } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
}));
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

const mockFindProjectByIdAndTenant = vi.fn();
vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: (...args: unknown[]) => mockFindProjectByIdAndTenant(...args),
}));

const mockProjectMemberFindOne = vi.fn();
const mockProjectFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findOne: (...args: unknown[]) => mockProjectFindOne(...args),
  },
  ProjectMember: {
    findOne: (...args: unknown[]) => mockProjectMemberFindOne(...args),
  },
}));

import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { requireProjectMemberOrAdmin } from '@/lib/require-project-member-or-admin';
import type { AuthenticatedUser } from '@/lib/auth';

const baseProject = {
  id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
};

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'user@test.com',
    name: 'Test User',
    permissions: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: tenant-scoped lookup returns null (not found by tenant)
  mockFindProjectByIdAndTenant.mockResolvedValue(null);
  // Default: Project.findOne returns null
  mockProjectFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  // Default: membership lookup returns null (not a member)
  mockProjectMemberFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
});

describe('requireProjectAccess', () => {
  it('should allow project owners via tenant-scoped lookup', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'owner-1', tenantId: 'tenant-1' }),
    );

    expect(isAccessError(result)).toBe(false);
    expect(mockFindProjectByIdAndTenant).toHaveBeenCalledWith('proj-1', 'tenant-1');
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('should allow tenant admins without requiring explicit project membership', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'admin-1', tenantId: 'tenant-1', role: 'ADMIN' }),
    );

    expect(isAccessError(result)).toBe(false);
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('should return 404 when a same-tenant user is not an explicit project member', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);
    mockProjectMemberFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'other-user', tenantId: 'tenant-1', role: 'MEMBER' }),
    );

    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
    expect(mockProjectMemberFindOne).toHaveBeenCalledWith(
      { projectId: 'proj-1', userId: 'other-user' },
      { _id: 1 },
    );
  });

  it('should return 404 when tenant-scoped lookup finds nothing and user has no membership', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'user-1', tenantId: 'tenant-1' }),
    );

    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
  });

  it('should deny access when user tenantId differs from the project tenant', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);
    mockProjectMemberFindOne.mockReturnValue({
      lean: () => Promise.resolve({ projectId: 'proj-1', userId: 'member-1' }),
    });

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'member-1', tenantId: 'different-tenant' }),
    );

    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
    expect(mockProjectFindOne).not.toHaveBeenCalled();
  });

  it('should return 404 when user has no membership (does not leak existence)', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);
    mockProjectMemberFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'stranger', tenantId: 'other-tenant' }),
    );

    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
  });

  it('should return 404 when membership found but project record is missing', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);
    mockProjectMemberFindOne.mockReturnValue({
      lean: () => Promise.resolve({ projectId: 'proj-1', userId: 'user-1' }),
    });
    mockProjectFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'user-1', tenantId: undefined }),
    );
    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
  });

  it('should return 401 when user has no id', async () => {
    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: undefined as any, tenantId: undefined }),
    );
    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(401);
  });

  it('should grant access for user with no tenantId but valid membership', async () => {
    // User has no tenantId — tenant-scoped lookup skipped, membership check succeeds
    mockProjectMemberFindOne.mockReturnValue({
      lean: () => Promise.resolve({ projectId: 'proj-1', userId: 'user-1' }),
    });
    mockProjectFindOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'proj-1', ...baseProject }),
    });

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'user-1', tenantId: undefined }),
    );
    expect(isAccessError(result)).toBe(false);
  });

  it('should return 404 (fail-safe) when membership lookup throws', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);
    mockLogError.mockClear();
    mockProjectMemberFindOne.mockReturnValue({
      lean: () => Promise.reject(new Error('DB connection failed')),
    });

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'user-1', tenantId: 'tenant-1', role: 'MEMBER' }),
    );
    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
    expect(mockLogError).toHaveBeenCalledWith(
      'Membership check failed',
      expect.objectContaining({ projectId: 'proj-1', error: 'DB connection failed' }),
    );
  });

  it('should never call Project.findOne without membership proof', async () => {
    // Non-member user: Project.findOne should NOT be called
    mockFindProjectByIdAndTenant.mockResolvedValue(null);
    mockProjectMemberFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    await requireProjectAccess('proj-1', makeUser({ id: 'stranger', tenantId: undefined }));
    expect(mockProjectFindOne).not.toHaveBeenCalled();
  });

  it('should return 401 when tenantId is present but user.id is missing', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(null);
    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: undefined as any, tenantId: 'tenant-1' }),
    );
    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(401);
  });

  it('should return 404 when Project.findOne throws after membership proof', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindProjectByIdAndTenant.mockResolvedValue(null);
    mockProjectMemberFindOne.mockReturnValue({
      lean: () => Promise.resolve({ projectId: 'proj-1', userId: 'user-1' }),
    });
    mockProjectFindOne.mockReturnValue({
      lean: () => Promise.reject(new Error('DB read error')),
    });

    const result = await requireProjectAccess(
      'proj-1',
      makeUser({ id: 'user-1', tenantId: undefined }),
    );
    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
  });
});

describe('requireProjectMemberOrAdmin', () => {
  it('should deny same-tenant non-members with 404', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);
    mockProjectMemberFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });

    const result = await requireProjectMemberOrAdmin(
      'proj-1',
      makeUser({ id: 'tenant-user', tenantId: 'tenant-1', role: 'MEMBER' }),
    );

    expect(isAccessError(result)).toBe(true);
    expect((result as NextResponse).status).toBe(404);
    expect(mockProjectMemberFindOne).toHaveBeenCalledWith(
      { projectId: 'proj-1', userId: 'tenant-user' },
      { _id: 1 },
    );
  });

  it('should allow same-tenant explicit project members', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);
    mockProjectMemberFindOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: 'membership-1', projectId: 'proj-1', userId: 'member-1' }),
    });

    const result = await requireProjectMemberOrAdmin(
      'proj-1',
      makeUser({ id: 'member-1', tenantId: 'tenant-1', role: 'MEMBER' }),
    );

    expect(isAccessError(result)).toBe(false);
  });

  it('should allow project owners even without a membership row', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue({ ...baseProject, ownerId: 'owner-1' });

    const result = await requireProjectMemberOrAdmin(
      'proj-1',
      makeUser({ id: 'owner-1', tenantId: 'tenant-1', role: 'MEMBER' }),
    );

    expect(isAccessError(result)).toBe(false);
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('should allow tenant admins without project membership', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);

    const result = await requireProjectMemberOrAdmin(
      'proj-1',
      makeUser({ id: 'admin-1', tenantId: 'tenant-1', role: 'ADMIN' }),
    );

    expect(isAccessError(result)).toBe(false);
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('should allow tenant-wide project bypass permission without membership', async () => {
    mockFindProjectByIdAndTenant.mockResolvedValue(baseProject);

    const result = await requireProjectMemberOrAdmin(
      'proj-1',
      makeUser({
        id: 'rbac-admin',
        tenantId: 'tenant-1',
        role: 'MEMBER',
        permissions: ['project:*'],
      }),
    );

    expect(isAccessError(result)).toBe(false);
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });
});
