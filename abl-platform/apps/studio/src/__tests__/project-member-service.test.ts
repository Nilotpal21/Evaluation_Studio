/**
 * Project member service — business rule tests
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  addProjectMember,
  assertCallerCanManageMembers,
  canActorManageMembers,
  listAvailableProjectMembers,
  listProjectMembers,
  removeProjectMember,
  updateProjectMember,
} from '../services/project-member-service';

const {
  mockFindProjectMember,
  mockFindProjectMembers,
  mockFindCustomRoleDefinition,
  mockCreateProjectMember,
  mockUpdateProjectMemberRecord,
  mockDeleteProjectMemberRecord,
  mockFindTenantMember,
  mockFindTenantMembers,
  mockLogAuditEvent,
} = vi.hoisted(() => ({
  mockFindProjectMember: vi.fn(),
  mockFindProjectMembers: vi.fn(),
  mockFindCustomRoleDefinition: vi.fn(),
  mockCreateProjectMember: vi.fn(),
  mockUpdateProjectMemberRecord: vi.fn(),
  mockDeleteProjectMemberRecord: vi.fn(),
  mockFindTenantMember: vi.fn(),
  mockFindTenantMembers: vi.fn(),
  mockLogAuditEvent: vi.fn(),
}));

vi.mock('@/repos/project-member-repo', () => ({
  findProjectMember: mockFindProjectMember,
  findProjectMembers: mockFindProjectMembers,
  findCustomRoleDefinition: mockFindCustomRoleDefinition,
  createProjectMember: mockCreateProjectMember,
  updateProjectMember: mockUpdateProjectMemberRecord,
  deleteProjectMember: mockDeleteProjectMemberRecord,
}));

vi.mock('@/repos/workspace-repo', () => ({
  findTenantMember: mockFindTenantMember,
  findTenantMembers: mockFindTenantMembers,
}));

vi.mock('@/services/audit-service', () => ({
  logAuditEvent: mockLogAuditEvent,
  AuditActions: {
    PROJECT_MEMBER_ADDED: 'project_member_added',
    PROJECT_MEMBER_REMOVED: 'project_member_removed',
    PROJECT_MEMBER_ROLE_CHANGED: 'project_member_role_changed',
  },
}));

const PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  slug: 'test-project',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
};

function ownerActor() {
  return {
    userId: 'owner-1',
    role: 'OWNER',
    permissions: ['*:*'],
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

function tenantAdminActor() {
  return {
    userId: 'admin-1',
    role: 'ADMIN',
    permissions: ['project:*'],
  };
}

function projectAdminActor() {
  return {
    userId: 'project-admin-1',
    role: 'VIEWER',
    permissions: ['agent:read'],
  };
}

function viewerActor() {
  return {
    userId: 'viewer-1',
    role: 'VIEWER',
    permissions: ['agent:read'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockFindProjectMembers.mockResolvedValue([]);
  mockFindProjectMember.mockResolvedValue(null);
  mockFindCustomRoleDefinition.mockResolvedValue({
    id: 'role-1',
    tenantId: 'tenant-1',
    isSystem: false,
  });
  mockCreateProjectMember.mockImplementation(async (data: Record<string, unknown>) => ({
    id: 'pm-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...data,
  }));
  mockUpdateProjectMemberRecord.mockImplementation(
    async (_projectId: string, userId: string, data: Record<string, unknown>) => ({
      id: 'pm-1',
      userId,
      role: data.role ?? 'developer',
      customRoleId: data.customRoleId ?? null,
    }),
  );
  mockDeleteProjectMemberRecord.mockResolvedValue(true);
  mockFindTenantMember.mockResolvedValue({
    id: 'tm-1',
    tenantId: 'tenant-1',
    userId: 'dev-1',
    role: 'MEMBER',
  });
  mockFindTenantMembers.mockResolvedValue([]);
  mockLogAuditEvent.mockResolvedValue(undefined);
});

describe('assertCallerCanManageMembers', () => {
  test('allows the project owner without a membership lookup', async () => {
    await expect(assertCallerCanManageMembers(PROJECT, ownerActor())).resolves.toBeUndefined();
    expect(mockFindProjectMember).not.toHaveBeenCalled();
  });

  test('allows a tenant admin via tenant-level authority', async () => {
    await expect(
      assertCallerCanManageMembers(PROJECT, tenantAdminActor()),
    ).resolves.toBeUndefined();
    expect(mockFindProjectMember).not.toHaveBeenCalled();
  });

  test('allows a project admin membership', async () => {
    mockFindProjectMember.mockResolvedValue({ id: 'pm-admin', role: 'admin', customRoleId: null });

    await expect(
      assertCallerCanManageMembers(PROJECT, projectAdminActor()),
    ).resolves.toBeUndefined();
    expect(mockFindProjectMember).toHaveBeenCalledWith('proj-1', 'project-admin-1');
  });

  test('throws 403 for same-tenant callers without admin rights', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-viewer',
      role: 'viewer',
      customRoleId: null,
    });

    await expect(assertCallerCanManageMembers(PROJECT, viewerActor())).rejects.toMatchObject({
      name: 'ProjectMemberServiceError',
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });
});

describe('canActorManageMembers', () => {
  test('returns true for a project admin membership', async () => {
    mockFindProjectMember.mockResolvedValue({ id: 'pm-admin', role: 'admin', customRoleId: null });

    await expect(canActorManageMembers(PROJECT, projectAdminActor())).resolves.toBe(true);
    expect(mockFindProjectMember).toHaveBeenCalledWith('proj-1', 'project-admin-1');
  });

  test('returns false for a non-admin project member', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-viewer',
      role: 'viewer',
      customRoleId: null,
    });

    await expect(canActorManageMembers(PROJECT, viewerActor())).resolves.toBe(false);
  });
});

describe('addProjectMember', () => {
  test('treats unknown user IDs as not being workspace members', async () => {
    mockFindTenantMember.mockResolvedValue(null);

    await expect(
      addProjectMember(PROJECT, ownerActor(), { userId: 'ghost', role: 'developer' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(mockCreateProjectMember).not.toHaveBeenCalled();
  });

  test('returns 400 when the user is not a workspace member', async () => {
    mockFindTenantMember.mockResolvedValue(null);

    await expect(
      addProjectMember(PROJECT, ownerActor(), { userId: 'dev-1', role: 'developer' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(mockCreateProjectMember).not.toHaveBeenCalled();
  });

  test('returns 409 when the user is already a project member', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-existing',
      role: 'developer',
      customRoleId: null,
    });

    await expect(
      addProjectMember(PROJECT, ownerActor(), { userId: 'dev-1', role: 'viewer' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'NAME_CONFLICT',
    });
    expect(mockCreateProjectMember).not.toHaveBeenCalled();
  });

  test('maps duplicate-key create races to 409', async () => {
    mockCreateProjectMember.mockRejectedValue({ code: 11000 });

    await expect(
      addProjectMember(PROJECT, ownerActor(), { userId: 'dev-1', role: 'viewer' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'NAME_CONFLICT',
    });
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  test('rejects built-in roles carrying a customRoleId', async () => {
    await expect(
      addProjectMember(PROJECT, ownerActor(), {
        userId: 'dev-1',
        role: 'developer',
        customRoleId: 'role-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });

    expect(mockCreateProjectMember).not.toHaveBeenCalled();
  });

  test('rejects unknown customRoleId values', async () => {
    mockFindCustomRoleDefinition.mockResolvedValue(null);

    await expect(
      addProjectMember(PROJECT, ownerActor(), {
        userId: 'dev-1',
        role: 'custom',
        customRoleId: 'missing-role',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });

    expect(mockCreateProjectMember).not.toHaveBeenCalled();
  });

  test('creates the membership and writes a project-member audit event', async () => {
    const member = await addProjectMember(PROJECT, ownerActor(), {
      userId: 'dev-1',
      role: 'developer',
    });

    expect(member).toMatchObject({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
    });
    expect(mockCreateProjectMember).toHaveBeenCalledWith({
      projectId: 'proj-1',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        tenantId: 'tenant-1',
        action: 'project_member_added',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'project_member',
          resourceId: 'proj-1:dev-1',
          targetUserId: 'dev-1',
          role: 'developer',
          customRoleId: null,
        }),
      }),
    );
  });

  test('creates the membership with a validated custom role', async () => {
    const member = await addProjectMember(PROJECT, ownerActor(), {
      userId: 'dev-1',
      role: 'custom',
      customRoleId: 'role-1',
    });

    expect(member).toMatchObject({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'custom',
      customRoleId: 'role-1',
    });
    expect(mockFindCustomRoleDefinition).toHaveBeenCalledWith('tenant-1', 'role-1');
    expect(mockCreateProjectMember).toHaveBeenCalledWith({
      projectId: 'proj-1',
      userId: 'dev-1',
      role: 'custom',
      customRoleId: 'role-1',
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project_member_added',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          resourceType: 'project_member',
          resourceId: 'proj-1:dev-1',
          targetUserId: 'dev-1',
          role: 'custom',
          customRoleId: 'role-1',
        }),
      }),
    );
  });
});

describe('listProjectMembers', () => {
  test('delegates to the repo with includeUser:true and returns raw results', async () => {
    const members = [
      {
        id: 'pm-1',
        userId: 'dev-1',
        role: 'developer',
        customRoleId: null,
        user: { id: 'dev-1', email: 'dev@test.com', name: 'Developer' },
      },
    ];
    mockFindProjectMembers.mockResolvedValue(members);

    const result = await listProjectMembers(PROJECT);

    expect(mockFindProjectMembers).toHaveBeenCalledWith('proj-1', { includeUser: true });
    expect(result).toBe(members);
  });
});

describe('listAvailableProjectMembers', () => {
  test('lists active workspace members who are not already assigned to the project', async () => {
    mockFindTenantMembers.mockResolvedValue([
      {
        id: 'tm-owner',
        tenantId: 'tenant-1',
        userId: 'owner-1',
        role: 'OWNER',
        status: 'active',
        user: { id: 'owner-1', email: 'owner@test.com', name: 'Owner User' },
      },
      {
        id: 'tm-existing',
        tenantId: 'tenant-1',
        userId: 'existing-1',
        role: 'MEMBER',
        status: 'active',
        user: { id: 'existing-1', email: 'existing@test.com', name: 'Existing User' },
      },
      {
        id: 'tm-inactive',
        tenantId: 'tenant-1',
        userId: 'inactive-1',
        role: 'MEMBER',
        status: 'invited',
        user: { id: 'inactive-1', email: 'inactive@test.com', name: 'Inactive User' },
      },
      {
        id: 'tm-missing-user',
        tenantId: 'tenant-1',
        userId: 'missing-user',
        role: 'MEMBER',
        status: 'active',
        user: null,
      },
      {
        id: 'tm-zeta',
        tenantId: 'tenant-1',
        userId: 'zeta-1',
        role: 'OPERATOR',
        status: 'active',
        user: { id: 'zeta-1', email: 'zeta@test.com', name: 'Zeta User' },
      },
      {
        id: 'tm-alpha',
        tenantId: 'tenant-1',
        userId: 'alpha-1',
        role: 'MEMBER',
        user: { id: 'alpha-1', email: 'alpha@test.com', name: 'Alpha User' },
      },
    ]);
    mockFindProjectMembers.mockResolvedValue([{ id: 'pm-existing', userId: 'existing-1' }]);

    const result = await listAvailableProjectMembers(PROJECT, ownerActor());

    expect(mockFindTenantMembers).toHaveBeenCalledWith('tenant-1', { includeUser: true });
    expect(mockFindProjectMembers).toHaveBeenCalledWith('proj-1');
    expect(result.map((member: { userId: string }) => member.userId)).toEqual([
      'alpha-1',
      'zeta-1',
    ]);
  });

  test('rejects callers who cannot manage project members', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-viewer',
      role: 'viewer',
      customRoleId: null,
    });

    await expect(listAvailableProjectMembers(PROJECT, viewerActor())).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });

    expect(mockFindTenantMembers).not.toHaveBeenCalled();
  });
});

describe('updateProjectMember', () => {
  test("prevents changing the project owner's role", async () => {
    await expect(
      updateProjectMember(PROJECT, ownerActor(), 'owner-1', { role: 'viewer' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });

    expect(mockUpdateProjectMemberRecord).not.toHaveBeenCalled();
  });

  test('returns 404 when the target user is not a project member', async () => {
    mockFindProjectMember.mockResolvedValue(null);

    await expect(
      updateProjectMember(PROJECT, ownerActor(), 'ghost', { role: 'viewer' }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });

    expect(mockUpdateProjectMemberRecord).not.toHaveBeenCalled();
  });

  test('rejects customRoleId updates for non-custom memberships', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
    });

    await expect(
      updateProjectMember(PROJECT, ownerActor(), 'dev-1', { customRoleId: 'role-2' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });

    expect(mockUpdateProjectMemberRecord).not.toHaveBeenCalled();
  });

  test('returns the existing member for built-in no-op customRoleId clears', async () => {
    const existing = {
      id: 'pm-1',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
    };
    mockFindProjectMember.mockResolvedValue(existing);

    const result = await updateProjectMember(PROJECT, ownerActor(), 'dev-1', {
      customRoleId: null,
    });

    expect(result).toBe(existing);
    expect(mockUpdateProjectMemberRecord).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  test('clears stale customRoleId values when changing back to a built-in role', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'custom',
      customRoleId: 'role-1',
    });
    mockUpdateProjectMemberRecord.mockResolvedValue({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'viewer',
      customRoleId: null,
    });

    const member = await updateProjectMember(PROJECT, ownerActor(), 'dev-1', { role: 'viewer' });

    expect(member).toMatchObject({ role: 'viewer', customRoleId: null });
    expect(mockUpdateProjectMemberRecord).toHaveBeenCalledWith('proj-1', 'dev-1', {
      role: 'viewer',
      customRoleId: null,
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project_member_role_changed',
        metadata: expect.objectContaining({
          targetUserId: 'dev-1',
          previousRole: 'custom',
          newRole: 'viewer',
          previousCustomRoleId: 'role-1',
          newCustomRoleId: null,
        }),
      }),
    );
  });

  test('assigns a custom role when upgrading a member from a built-in role', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
    });
    mockUpdateProjectMemberRecord.mockResolvedValue({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'custom',
      customRoleId: 'role-1',
    });

    const member = await updateProjectMember(PROJECT, ownerActor(), 'dev-1', {
      role: 'custom',
      customRoleId: 'role-1',
    });

    expect(member).toMatchObject({ role: 'custom', customRoleId: 'role-1' });
    expect(mockFindCustomRoleDefinition).toHaveBeenCalledWith('tenant-1', 'role-1');
    expect(mockUpdateProjectMemberRecord).toHaveBeenCalledWith('proj-1', 'dev-1', {
      role: 'custom',
      customRoleId: 'role-1',
    });
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project_member_role_changed',
        metadata: expect.objectContaining({
          targetUserId: 'dev-1',
          previousRole: 'developer',
          newRole: 'custom',
          previousCustomRoleId: null,
          newCustomRoleId: 'role-1',
        }),
      }),
    );
  });
});

describe('removeProjectMember', () => {
  test('protects the project owner from removal', async () => {
    await expect(removeProjectMember(PROJECT, ownerActor(), 'owner-1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  test('returns 404 when the target user is not a project member', async () => {
    mockFindProjectMember.mockResolvedValue(null);

    await expect(removeProjectMember(PROJECT, ownerActor(), 'ghost')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    expect(mockDeleteProjectMemberRecord).not.toHaveBeenCalled();
  });

  test('removes the membership and writes a project-member audit event', async () => {
    mockFindProjectMember.mockResolvedValue({
      id: 'pm-1',
      userId: 'dev-1',
      role: 'developer',
      customRoleId: null,
    });

    await expect(removeProjectMember(PROJECT, ownerActor(), 'dev-1')).resolves.toBeUndefined();
    expect(mockDeleteProjectMemberRecord).toHaveBeenCalledWith('proj-1', 'dev-1');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project_member_removed',
        metadata: expect.objectContaining({
          projectId: 'proj-1',
          targetUserId: 'dev-1',
          role: 'developer',
          customRoleId: null,
        }),
      }),
    );
  });
});
