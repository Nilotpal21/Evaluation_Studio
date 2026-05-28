import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { mockLogWarn, mockResolveProjectCustomRolePermissions } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockResolveProjectCustomRolePermissions: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/permission-resolver', () => ({
  resolveProjectCustomRolePermissions: (...args: unknown[]) =>
    mockResolveProjectCustomRolePermissions(...args),
}));

const mockFindProjectByIdAndTenant = vi.fn();
vi.mock('@/repos/project-repo', () => ({
  findProjectByIdAndTenant: (...args: unknown[]) => mockFindProjectByIdAndTenant(...args),
}));

const mockProjectMemberFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  ProjectMember: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectMemberFindOne(...args) }),
  },
}));

import { isSdkProjectAccessError, requireSdkProjectAccess } from '@/lib/sdk-project-access';
import type { AuthenticatedUser } from '@/lib/auth';

const PROJECT_ID = 'proj-1';
const PROJECT = {
  id: PROJECT_ID,
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
} as const;

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

describe('requireSdkProjectAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProjectByIdAndTenant.mockResolvedValue(PROJECT);
    mockProjectMemberFindOne.mockResolvedValue(null);
    mockResolveProjectCustomRolePermissions.mockResolvedValue([]);
  });

  it('allows tester read access via the canonical project-role permissions', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'tester' });

    const result = await requireSdkProjectAccess(PROJECT_ID, makeUser(), 'read');

    expect(isSdkProjectAccessError(result)).toBe(false);
    expect(result).toEqual({
      project: PROJECT,
      accessLevel: 'project_member',
    });
  });

  it('conceals tester write denial as project not found', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'tester' });

    const result = await requireSdkProjectAccess(PROJECT_ID, makeUser(), 'write');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
    await expect((result as NextResponse).json()).resolves.toEqual({ error: 'Project not found' });
  });

  it('allows custom project roles when the resolved custom permissions satisfy the request', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'custom', customRoleId: 'custom-role-1' });
    mockResolveProjectCustomRolePermissions.mockResolvedValue(['agent:read']);

    const result = await requireSdkProjectAccess(PROJECT_ID, makeUser(), 'read');

    expect(isSdkProjectAccessError(result)).toBe(false);
    expect(result).toEqual({
      project: PROJECT,
      accessLevel: 'project_member',
    });
    expect(mockResolveProjectCustomRolePermissions).toHaveBeenCalledWith(
      'tenant-1',
      'custom-role-1',
    );
  });

  it('conceals unsupported roles and logs a warning', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'editor', customRoleId: 'custom-role-1' });

    const result = await requireSdkProjectAccess(PROJECT_ID, makeUser(), 'read');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(404);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'SDK project access denied for unsupported project member role',
      expect.objectContaining({
        projectId: PROJECT_ID,
        userId: 'user-1',
        role: 'editor',
        customRoleId: 'custom-role-1',
        operation: 'read',
      }),
    );
  });
});
