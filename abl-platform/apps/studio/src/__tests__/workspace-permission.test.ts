import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mockFindTenantMember = vi.fn();

vi.mock('@/repos/workspace-repo', () => ({
  findTenantMember: (...args: unknown[]) => mockFindTenantMember(...args),
}));

import {
  WORKSPACE_PERMISSIONS,
  isWorkspacePermissionError,
  requireWorkspacePermission,
  requireWorkspaceRole,
} from '@/lib/workspace-permission';
import type { AuthenticatedUser } from '@/lib/auth';

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'user@test.com',
    name: 'Test User',
    tenantId: 'tenant-1',
    permissions: [],
    ...overrides,
  };
}

describe('workspace-permission helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindTenantMember.mockResolvedValue({
      id: 'tm-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'MEMBER',
      status: 'active',
    });
  });

  it('allows built-in ADMIN roles to manage workspace members', async () => {
    mockFindTenantMember.mockResolvedValue({
      id: 'tm-admin',
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'ADMIN',
      status: 'active',
    });

    const result = await requireWorkspacePermission(
      'tenant-1',
      makeUser(),
      WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
    );

    expect(isWorkspacePermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      tenantId: 'tenant-1',
      membership: { role: 'ADMIN' },
      permissions: expect.arrayContaining(['tenant:manage_members']),
    });
  });

  it('denies MEMBER access to member-management by default', async () => {
    const result = await requireWorkspacePermission(
      'tenant-1',
      makeUser(),
      WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
    );

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
  });

  it('returns a 403 response when the caller opts into forbidden mode', async () => {
    const result = await requireWorkspacePermission(
      'tenant-1',
      makeUser(),
      WORKSPACE_PERMISSIONS.MANAGE_MEMBERS,
      {
        denyBehavior: 'forbidden',
      },
    );

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    await expect((result as NextResponse).json()).resolves.toMatchObject({
      error: 'Insufficient permissions',
    });
  });

  it('allows custom-role memberships to use the resolved auth permission set', async () => {
    mockFindTenantMember.mockResolvedValue({
      id: 'tm-custom',
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'MEMBER',
      customRoleId: 'role-custom-1',
      status: 'active',
    });

    const result = await requireWorkspacePermission(
      'tenant-1',
      makeUser({
        permissions: [WORKSPACE_PERMISSIONS.MANAGE_SETTINGS],
      }),
      WORKSPACE_PERMISSIONS.MANAGE_SETTINGS,
    );

    expect(isWorkspacePermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      membership: { customRoleId: 'role-custom-1' },
      permissions: [WORKSPACE_PERMISSIONS.MANAGE_SETTINGS],
    });
  });

  it('allows owner-only routes through requireWorkspaceRole', async () => {
    mockFindTenantMember.mockResolvedValue({
      id: 'tm-owner',
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'OWNER',
      status: 'active',
    });

    const result = await requireWorkspaceRole('tenant-1', makeUser(), 'OWNER');

    expect(isWorkspacePermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      membership: { role: 'OWNER' },
    });
  });

  it('denies non-owner members on owner-only routes', async () => {
    mockFindTenantMember.mockResolvedValue({
      id: 'tm-admin',
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'ADMIN',
      status: 'active',
    });

    const result = await requireWorkspaceRole('tenant-1', makeUser(), 'OWNER');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
  });

  it('returns 404 for cross-tenant lookups before reading membership rows', async () => {
    const result = await requireWorkspacePermission(
      'tenant-2',
      makeUser({ tenantId: 'tenant-1' }),
      WORKSPACE_PERMISSIONS.MANAGE_SETTINGS,
    );

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
    expect(mockFindTenantMember).not.toHaveBeenCalled();
  });
});
