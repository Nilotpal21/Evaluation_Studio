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

vi.mock('@agent-platform/shared-auth/rbac', () => {
  const hasExactPermission = (granted: readonly string[], required: string) =>
    granted.includes(required);
  const hasPermission = (granted: readonly string[], required: string) => {
    if (granted.includes(required) || granted.includes('*') || granted.includes('*:*')) {
      return true;
    }
    const [resource] = required.split(':');
    return Boolean(resource && granted.includes(`${resource}:*`));
  };
  const evaluateProjectPermission = (
    role: string,
    permission: string,
    customRolePermissions: readonly string[] = [],
  ) => {
    if (role === 'custom') return customRolePermissions.includes(permission);
    if (role === 'viewer') return permission === 'agent:read' || permission.endsWith(':read');
    if (role === 'tester') return permission === 'session:create' || permission.endsWith(':read');
    if (role === 'developer') return permission !== 'project:delete';
    if (role === 'admin') return true;
    return false;
  };
  return {
    PROJECT_ROLE_PERMISSIONS: {
      admin: ['*:*'],
      developer: ['agent:*', 'session:*', 'tool:*'],
      tester: [
        'agent:read',
        'session:read',
        'session:create',
        'channel_connection:read',
        'credential:read',
      ],
      viewer: ['agent:read', 'session:read', 'channel_connection:read', 'credential:read'],
    },
    PROJECT_ROLE_NAMES: ['viewer', 'tester', 'developer', 'admin'],
    evaluateProjectPermission,
    hasExactPermission,
    hasPermission,
    isSensitiveExactPermission: (permission: string) => permission === 'pii:reveal',
  };
});

const mockRequireProjectAccess = vi.fn();
vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (r: unknown) => r instanceof NextResponse,
}));

const mockProjectMemberFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  ProjectMember: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectMemberFindOne(...args) }),
  },
}));

import {
  isProjectPermissionError,
  requireProjectPermission,
  resolveEffectiveProjectScopedPermissions,
  resolveStudioProjectPermissionAliases,
} from '@/lib/project-permission';
import { StudioPermission } from '@/lib/permissions';
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

describe('project-permission helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({ project: PROJECT });
    mockProjectMemberFindOne.mockResolvedValue(null);
    mockResolveProjectCustomRolePermissions.mockResolvedValue([]);
  });

  it('allows project owners without reading membership rows', async () => {
    const result = await requireProjectPermission(
      PROJECT_ID,
      makeUser({ id: 'owner-1' }),
      'project:delete',
    );

    expect(isProjectPermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      project: PROJECT,
      accessLevel: 'project_owner',
    });
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('allows tenant-wide project authority without reading membership rows', async () => {
    const result = await requireProjectPermission(
      PROJECT_ID,
      makeUser({ permissions: ['project:*'] }),
      'project:delete',
    );

    expect(isProjectPermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      project: PROJECT,
      accessLevel: 'tenant_rbac',
    });
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('allows viewer read access for agents', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'viewer' });

    const result = await requireProjectPermission(PROJECT_ID, makeUser(), 'agent:read');

    expect(isProjectPermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      project: PROJECT,
      accessLevel: 'project_member',
      role: 'viewer',
    });
  });

  it('includes project role session permissions for Arch trace tools', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'viewer' });

    const result = await requireProjectPermission(PROJECT_ID, makeUser(), 'agent:read');

    expect(isProjectPermissionError(result)).toBe(false);
    expect(resolveEffectiveProjectScopedPermissions(result)).toEqual(
      expect.arrayContaining([
        'agent:read',
        'session:read',
        'connection:read',
        'auth-profile:read',
        'auth_profile:read',
      ]),
    );
  });

  it('adds project-wide authority for tenant project admins', async () => {
    const result = await requireProjectPermission(
      PROJECT_ID,
      makeUser({ permissions: ['project:*'] }),
      'agent:read',
    );

    expect(isProjectPermissionError(result)).toBe(false);
    expect(resolveEffectiveProjectScopedPermissions(result)).toEqual(
      expect.arrayContaining(['project:*', '*:*', 'connection:read', 'auth_profile:read']),
    );
  });

  it('denies viewer agent creation', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'viewer' });

    const result = await requireProjectPermission(PROJECT_ID, makeUser(), 'agent:create');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it('allows tester session creation', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'tester' });

    const result = await requireProjectPermission(PROJECT_ID, makeUser(), 'session:create');

    expect(isProjectPermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      role: 'tester',
    });
  });

  it('denies developer project deletion', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'developer' });

    const result = await requireProjectPermission(PROJECT_ID, makeUser(), 'project:delete');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it('allows custom roles through resolved custom permissions', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'custom', customRoleId: 'custom-role-1' });
    mockResolveProjectCustomRolePermissions.mockResolvedValue(['agent:create']);

    const result = await requireProjectPermission(PROJECT_ID, makeUser(), 'agent:create');

    expect(isProjectPermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      role: 'custom',
    });
    expect(mockResolveProjectCustomRolePermissions).toHaveBeenCalledWith(
      'tenant-1',
      'custom-role-1',
    );
  });

  it('does not let project ownership imply pii reveal', async () => {
    const result = await requireProjectPermission(
      PROJECT_ID,
      makeUser({ id: 'owner-1' }),
      StudioPermission.PII_REVEAL,
    );

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('does not let tenant project wildcards imply pii reveal', async () => {
    const result = await requireProjectPermission(
      PROJECT_ID,
      makeUser({ permissions: ['project:*'] }),
      StudioPermission.PII_REVEAL,
    );

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('allows tenant project admins to reveal pii only with exact permission', async () => {
    const result = await requireProjectPermission(
      PROJECT_ID,
      makeUser({ permissions: ['project:*', 'pii:reveal'] }),
      StudioPermission.PII_REVEAL,
    );

    expect(isProjectPermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      accessLevel: 'tenant_rbac',
    });
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
  });

  it('allows custom privacy roles to reveal pii through exact permission', async () => {
    mockProjectMemberFindOne.mockResolvedValue({
      role: 'custom',
      customRoleId: 'custom-privacy-role',
    });
    mockResolveProjectCustomRolePermissions.mockResolvedValue(['pii:reveal']);

    const result = await requireProjectPermission(
      PROJECT_ID,
      makeUser(),
      StudioPermission.PII_REVEAL,
    );

    expect(isProjectPermissionError(result)).toBe(false);
    expect(result).toMatchObject({
      role: 'custom',
    });
    expect(mockResolveProjectCustomRolePermissions).toHaveBeenCalledWith(
      'tenant-1',
      'custom-privacy-role',
    );
  });

  it('maps auth profile project permissions to canonical and legacy aliases', () => {
    expect(resolveStudioProjectPermissionAliases(StudioPermission.AUTH_PROFILE_READ)).toEqual([
      'auth-profile:read',
      'credential:read',
    ]);
    expect(resolveStudioProjectPermissionAliases(StudioPermission.AUTH_PROFILE_WRITE)).toEqual([
      'auth-profile:create',
      'auth-profile:write',
      'credential:write',
      'credential:manage',
    ]);
    expect(resolveStudioProjectPermissionAliases(StudioPermission.AUTH_PROFILE_DELETE)).toEqual([
      'auth-profile:delete',
      'credential:delete',
      'credential:manage',
    ]);
  });

  it('fails closed for unsupported project member roles', async () => {
    mockProjectMemberFindOne.mockResolvedValue({ role: 'editor', customRoleId: 'custom-role-1' });

    const result = await requireProjectPermission(PROJECT_ID, makeUser(), 'agent:read');

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Project permission denied for unsupported project member role',
      expect.objectContaining({
        projectId: PROJECT_ID,
        userId: 'user-1',
        role: 'editor',
        customRoleId: 'custom-role-1',
      }),
    );
  });

  it('maps only the Studio permissions that have canonical project-role aliases', () => {
    expect(resolveStudioProjectPermissionAliases(StudioPermission.TOOL_WRITE)).toEqual([
      'tool:write',
    ]);
    expect(resolveStudioProjectPermissionAliases(StudioPermission.CONNECTION_WRITE)).toEqual([
      'channel_connection:create',
      'channel_connection:update',
    ]);
    expect(resolveStudioProjectPermissionAliases(StudioPermission.PROJECT_GIT)).toEqual([
      'project:git',
    ]);
    expect(resolveStudioProjectPermissionAliases(StudioPermission.PII_REVEAL)).toEqual([
      'pii:reveal',
    ]);
    expect(resolveStudioProjectPermissionAliases(StudioPermission.PROJECT_READ)).toBeNull();
  });
});
