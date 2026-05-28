/**
 * Tests for checkAgentPermission helper.
 *
 * Covers: project owner, agent owner, admin role, developer role, viewer role,
 * no membership, DB errors (fail-open), and explicit permission grants.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockLogWarn, mockLogError, mockResolveProjectCustomRolePermissions } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockResolveProjectCustomRolePermissions: vi.fn(),
}));
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
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

const mockAgentOwnershipFindOne = vi.fn();
const mockProjectMemberFindOne = vi.fn();
const mockTeamFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AgentOwnership: {
    findOne: (...args: unknown[]) => ({ lean: () => mockAgentOwnershipFindOne(...args) }),
  },
  ProjectMember: {
    findOne: (...args: unknown[]) => ({ lean: () => mockProjectMemberFindOne(...args) }),
  },
  Team: {
    find: (...args: unknown[]) => ({ lean: () => mockTeamFind(...args) }),
  },
}));

// ─── Import under test ───────────────────────────────────────────────────────

import { checkAgentPermission } from '@/lib/agent-permission';
import type { AuthenticatedUser } from '@/lib/auth';
import type { ProjectAccessResult } from '@/lib/project-access';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const AGENT_ID = 'agent-1';

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'user-1',
    email: 'user@test.com',
    name: 'Test User',
    permissions: [],
    ...overrides,
  };
}

function makeProject(
  overrides: Partial<ProjectAccessResult['project']> = {},
): ProjectAccessResult['project'] {
  return {
    id: PROJECT_ID,
    name: 'Test Project',
    slug: 'test-project',
    ownerId: 'owner-1',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('checkAgentPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentOwnershipFindOne.mockResolvedValue(null);
    mockProjectMemberFindOne.mockResolvedValue(null);
    mockTeamFind.mockResolvedValue([]);
    mockResolveProjectCustomRolePermissions.mockResolvedValue([]);
  });

  // 0. Tenant-level role bypass (OWNER / ADMIN skip DB checks entirely)
  it('allows tenant OWNER any operation without DB lookups', async () => {
    const user = makeUser({ id: 'nobody', role: 'OWNER' });
    const project = makeProject({ ownerId: 'someone-else' });

    for (const op of ['view', 'edit', 'deploy', 'delete', 'transfer_ownership'] as const) {
      const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, op);
      expect(result.allowed).toBe(true);
    }

    // DB should never be queried — bypass is before ensureDb()
    expect(mockAgentOwnershipFindOne).not.toHaveBeenCalled();
    expect(mockProjectMemberFindOne).not.toHaveBeenCalled();
    expect(mockTeamFind).not.toHaveBeenCalled();
  });

  it('allows tenant ADMIN any operation without DB lookups', async () => {
    const user = makeUser({ id: 'nobody', role: 'ADMIN' });
    const project = makeProject({ ownerId: 'someone-else' });

    const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'deploy');
    expect(result.allowed).toBe(true);
    expect(mockAgentOwnershipFindOne).not.toHaveBeenCalled();
  });

  it('does NOT bypass for non-elevated tenant roles (OPERATOR, VIEWER)', async () => {
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      const user = makeUser({ id: 'nobody', role });
      const project = makeProject({ ownerId: 'someone-else' });

      const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'edit');
      expect(result.allowed).toBe(false);
    }
  });

  // 1. Project owner gets full access
  it('allows project owner any operation', async () => {
    const user = makeUser({ id: 'owner-1' });
    const project = makeProject({ ownerId: 'owner-1' });

    for (const op of ['view', 'edit', 'deploy', 'delete', 'transfer_ownership'] as const) {
      const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, op);
      expect(result.allowed).toBe(true);
    }
  });

  // 2. Agent owner gets full access
  it('allows agent owner any operation', async () => {
    const user = makeUser({ id: 'user-2' });
    const project = makeProject();
    mockAgentOwnershipFindOne.mockResolvedValue({
      ownerId: 'user-2',
      ownerTeamId: null,
      permissions: [],
    });

    for (const op of ['view', 'edit', 'deploy', 'delete', 'transfer_ownership'] as const) {
      const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, op);
      expect(result.allowed).toBe(true);
    }
  });

  // 3. Project admin gets full access via member role
  it('allows project admin any operation', async () => {
    const user = makeUser({ id: 'admin-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'admin' });

    for (const op of ['view', 'edit', 'deploy', 'delete', 'transfer_ownership'] as const) {
      const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, op);
      expect(result.allowed).toBe(true);
    }
  });

  // 4. Developer gets canonical project-role access
  it('allows developer view, edit, and delete', async () => {
    const user = makeUser({ id: 'dev-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'developer' });

    const viewResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'view');
    expect(viewResult.allowed).toBe(true);

    const editResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'edit');
    expect(editResult.allowed).toBe(true);

    const deleteResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'delete');
    expect(deleteResult.allowed).toBe(true);
  });

  it('denies developer deploy', async () => {
    const user = makeUser({ id: 'dev-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'developer' });

    const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'deploy');
    expect(result.allowed).toBe(false);
    expect(result.response).toBeInstanceOf(NextResponse);
    expect(result.response?.status).toBe(403);
  });

  // 5. Viewer gets only view
  it('allows viewer view only', async () => {
    const user = makeUser({ id: 'viewer-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'viewer' });

    const viewResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'view');
    expect(viewResult.allowed).toBe(true);

    const editResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'edit');
    expect(editResult.allowed).toBe(false);
    expect(editResult.response?.status).toBe(403);
  });

  it('allows tester view only', async () => {
    const user = makeUser({ id: 'tester-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'tester' });

    const viewResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'view');
    expect(viewResult.allowed).toBe(true);

    const editResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'edit');
    expect(editResult.allowed).toBe(false);
    expect(editResult.response?.status).toBe(403);

    const deployResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'deploy');
    expect(deployResult.allowed).toBe(false);
    expect(deployResult.response?.status).toBe(403);
  });

  it('allows custom project roles through resolved custom permissions', async () => {
    const user = makeUser({ id: 'custom-role-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'custom', customRoleId: 'custom-role-1' });
    mockResolveProjectCustomRolePermissions.mockResolvedValue(['agent:read', 'agent:update']);

    const viewResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'view');
    const editResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'edit');
    const deleteResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'delete');

    expect(viewResult.allowed).toBe(true);
    expect(editResult.allowed).toBe(true);
    expect(deleteResult.allowed).toBe(false);
    expect(mockResolveProjectCustomRolePermissions).toHaveBeenCalledWith(
      'tenant-1',
      'custom-role-1',
    );
  });

  it('denies unsupported project member roles and logs a warning', async () => {
    const user = makeUser({ id: 'legacy-role-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'editor', customRoleId: 'custom-role-1' });

    const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'view');

    expect(result.allowed).toBe(false);
    expect(result.response?.status).toBe(403);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Agent permission check denied unsupported project member role',
      expect.objectContaining({
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        userId: 'legacy-role-user',
        role: 'editor',
        customRoleId: 'custom-role-1',
      }),
    );
  });

  // 6. No ownership + no membership = denied
  it('denies user with no ownership and no membership', async () => {
    const user = makeUser({ id: 'nobody' });
    const project = makeProject();

    const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'view');
    expect(result.allowed).toBe(false);
    expect(result.response).toBeInstanceOf(NextResponse);
    expect(result.response?.status).toBe(403);
  });

  // 7. DB error = fail closed
  it('fails closed when database throws', async () => {
    const user = makeUser();
    const project = makeProject();
    mockAgentOwnershipFindOne.mockRejectedValue(new Error('DB connection lost'));

    const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'deploy');
    expect(result.allowed).toBe(false);
    expect(result.response).toBeInstanceOf(NextResponse);
    expect(result.response?.status).toBe(403);
    expect(mockLogError).toHaveBeenCalledWith(
      'Agent permission check failed, denying access',
      expect.objectContaining({
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        error: 'DB connection lost',
      }),
    );
  });

  it('fails closed when DB error is not an Error instance', async () => {
    const user = makeUser();
    const project = makeProject();
    mockAgentOwnershipFindOne.mockRejectedValue('unexpected string error');

    const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'view');
    expect(result.allowed).toBe(false);
    expect(result.response).toBeInstanceOf(NextResponse);
    expect(result.response?.status).toBe(403);
    expect(mockLogError).toHaveBeenCalledWith(
      'Agent permission check failed, denying access',
      expect.objectContaining({ error: 'unexpected string error' }),
    );
  });

  // 8. Explicit permission grants respected
  it('allows operation via explicit user permission', async () => {
    const user = makeUser({ id: 'grant-user' });
    const project = makeProject();
    mockAgentOwnershipFindOne.mockResolvedValue({
      ownerId: 'someone-else',
      ownerTeamId: null,
      permissions: [
        {
          principalType: 'user',
          principalId: 'grant-user',
          operations: ['deploy'],
          grantedBy: 'owner-1',
          expiresAt: null,
        },
      ],
    });

    const deployResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'deploy');
    expect(deployResult.allowed).toBe(true);

    // The grant only covers deploy, not delete
    const deleteResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'delete');
    expect(deleteResult.allowed).toBe(false);
  });

  it('allows operation via explicit team permission', async () => {
    const user = makeUser({ id: 'team-user' });
    const project = makeProject();
    mockAgentOwnershipFindOne.mockResolvedValue({
      ownerId: 'someone-else',
      ownerTeamId: null,
      permissions: [
        {
          principalType: 'team',
          principalId: 'team-A',
          operations: ['view', 'edit', 'deploy'],
          grantedBy: 'owner-1',
          expiresAt: null,
        },
      ],
    });
    mockTeamFind.mockResolvedValue([
      {
        _id: 'team-A',
        members: [{ userId: 'team-user', role: 'member' }],
      },
    ]);

    const deployResult = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'deploy');
    expect(deployResult.allowed).toBe(true);
  });

  it('ignores expired explicit permissions', async () => {
    const user = makeUser({ id: 'expired-user' });
    const project = makeProject();
    mockAgentOwnershipFindOne.mockResolvedValue({
      ownerId: 'someone-else',
      ownerTeamId: null,
      permissions: [
        {
          principalType: 'user',
          principalId: 'expired-user',
          operations: ['deploy'],
          grantedBy: 'owner-1',
          expiresAt: new Date('2020-01-01'),
        },
      ],
    });

    const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, 'deploy');
    expect(result.allowed).toBe(false);
  });

  // 9. AgentOwnership lookup uses $or for agentId/agentName
  it('queries ownership by both agentId and agentName', async () => {
    const user = makeUser({ id: 'dev-user' });
    const project = makeProject();
    mockProjectMemberFindOne.mockResolvedValue({ role: 'developer' });

    await checkAgentPermission(PROJECT_ID, 'My_Agent_Name', user, project, 'view');

    expect(mockAgentOwnershipFindOne).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      $or: [{ agentId: 'My_Agent_Name' }, { agentName: 'My_Agent_Name' }],
    });
  });

  it('allows team owner lead full operations', async () => {
    const user = makeUser({ id: 'team-lead' });
    const project = makeProject();
    mockAgentOwnershipFindOne.mockResolvedValue({
      ownerId: null,
      ownerTeamId: 'team-B',
      permissions: [],
    });
    mockTeamFind.mockResolvedValue([
      {
        _id: 'team-B',
        members: [{ userId: 'team-lead', role: 'lead' }],
      },
    ]);

    for (const op of ['view', 'edit', 'deploy', 'delete'] as const) {
      const result = await checkAgentPermission(PROJECT_ID, AGENT_ID, user, project, op);
      expect(result.allowed).toBe(true);
    }

    // Team leads do not get transfer_ownership
    const transferResult = await checkAgentPermission(
      PROJECT_ID,
      AGENT_ID,
      user,
      project,
      'transfer_ownership',
    );
    expect(transferResult.allowed).toBe(false);
  });
});
