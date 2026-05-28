import { describe, it, expect } from 'vitest';
import {
  canPerform,
  resolvePermissions,
  type PermissionContext,
} from '../ownership/permission-checker.js';

function makeContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    userId: 'user-1',
    projectOwnerId: 'owner-1',
    projectMemberRole: null,
    projectMemberCustomPermissions: null,
    agentOwnerId: null,
    agentOwnerTeamId: null,
    userTeamMemberships: [],
    explicitPermissions: [],
    ...overrides,
  };
}

describe('canPerform / resolvePermissions', () => {
  it('should grant full access to project owner', () => {
    const ctx = makeContext({ userId: 'owner-1', projectOwnerId: 'owner-1' });
    const perms = resolvePermissions(ctx);

    expect(perms).toContain('view');
    expect(perms).toContain('edit');
    expect(perms).toContain('deploy');
    expect(perms).toContain('delete');
    expect(perms).toContain('transfer_ownership');
  });

  it('should grant full access to agent owner', () => {
    const ctx = makeContext({ userId: 'user-1', agentOwnerId: 'user-1' });
    const perms = resolvePermissions(ctx);

    expect(perms).toContain('view');
    expect(perms).toContain('edit');
    expect(perms).toContain('deploy');
    expect(perms).toContain('delete');
    expect(perms).toContain('transfer_ownership');
  });

  it('should grant team lead permissions for team owner', () => {
    const ctx = makeContext({
      agentOwnerTeamId: 'team-1',
      userTeamMemberships: [{ teamId: 'team-1', role: 'lead' }],
    });

    expect(canPerform(ctx, 'view')).toBe(true);
    expect(canPerform(ctx, 'edit')).toBe(true);
    expect(canPerform(ctx, 'deploy')).toBe(true);
    expect(canPerform(ctx, 'delete')).toBe(true);
    expect(canPerform(ctx, 'transfer_ownership')).toBe(false);
  });

  it('should grant team member permissions (view+edit only)', () => {
    const ctx = makeContext({
      agentOwnerTeamId: 'team-1',
      userTeamMemberships: [{ teamId: 'team-1', role: 'member' }],
    });

    expect(canPerform(ctx, 'view')).toBe(true);
    expect(canPerform(ctx, 'edit')).toBe(true);
    expect(canPerform(ctx, 'deploy')).toBe(false);
    expect(canPerform(ctx, 'delete')).toBe(false);
  });

  it('should honor explicit permission grants', () => {
    const ctx = makeContext({
      explicitPermissions: [
        {
          principalType: 'user',
          principalId: 'user-1',
          operations: ['view', 'deploy'],
          expiresAt: null,
        },
      ],
    });

    expect(canPerform(ctx, 'view')).toBe(true);
    expect(canPerform(ctx, 'deploy')).toBe(true);
    expect(canPerform(ctx, 'edit')).toBe(false);
  });

  it('should ignore expired permissions', () => {
    const pastDate = new Date(Date.now() - 1000);
    const ctx = makeContext({
      explicitPermissions: [
        {
          principalType: 'user',
          principalId: 'user-1',
          operations: ['view', 'edit'],
          expiresAt: pastDate,
        },
      ],
    });

    expect(canPerform(ctx, 'view')).toBe(false);
  });

  it('should derive developer access from the canonical project-role permissions', () => {
    const devCtx = makeContext({ projectMemberRole: 'developer' });
    expect(canPerform(devCtx, 'view')).toBe(true);
    expect(canPerform(devCtx, 'edit')).toBe(true);
    expect(canPerform(devCtx, 'delete')).toBe(true);
    expect(canPerform(devCtx, 'deploy')).toBe(false);
    expect(canPerform(devCtx, 'transfer_ownership')).toBe(false);

    const viewerCtx = makeContext({ projectMemberRole: 'viewer' });
    expect(canPerform(viewerCtx, 'view')).toBe(true);
    expect(canPerform(viewerCtx, 'edit')).toBe(false);

    const adminCtx = makeContext({ projectMemberRole: 'admin' });
    expect(canPerform(adminCtx, 'deploy')).toBe(true);
    expect(canPerform(adminCtx, 'delete')).toBe(true);
  });

  it('should allow tester to view without granting edit or deploy operations', () => {
    const testerCtx = makeContext({ projectMemberRole: 'tester' });

    expect(canPerform(testerCtx, 'view')).toBe(true);
    expect(canPerform(testerCtx, 'edit')).toBe(false);
    expect(canPerform(testerCtx, 'deploy')).toBe(false);
    expect(canPerform(testerCtx, 'delete')).toBe(false);
    expect(canPerform(testerCtx, 'transfer_ownership')).toBe(false);
  });

  it('should derive custom-role access from explicit project permissions and ignore invalid grants', () => {
    const customCtx = makeContext({
      projectMemberRole: 'custom',
      projectMemberCustomPermissions: ['agent:read', 'agent:update', 'deployment:create', '*:*'],
    });

    expect(canPerform(customCtx, 'view')).toBe(true);
    expect(canPerform(customCtx, 'edit')).toBe(true);
    expect(canPerform(customCtx, 'deploy')).toBe(true);
    expect(canPerform(customCtx, 'delete')).toBe(false);
    expect(canPerform(customCtx, 'transfer_ownership')).toBe(false);
  });

  it('should deny everything when no permissions match', () => {
    const ctx = makeContext();
    const perms = resolvePermissions(ctx);
    expect(perms).toHaveLength(0);
  });

  it('should check cascading priority: project owner > agent owner > team', () => {
    // User is both project owner AND has team membership
    // Project owner should win and grant transfer_ownership
    const ctx = makeContext({
      userId: 'owner-1',
      projectOwnerId: 'owner-1',
      agentOwnerTeamId: 'team-1',
      userTeamMemberships: [{ teamId: 'team-1', role: 'member' }],
    });

    // Project owner gets transfer_ownership, team member would not
    expect(canPerform(ctx, 'transfer_ownership')).toBe(true);
  });
});

describe('multiple permission sources', () => {
  it('should merge user grant with team grant for broader access', () => {
    const ctx = makeContext({
      userId: 'user-a',
      explicitPermissions: [
        {
          principalType: 'user',
          principalId: 'user-a',
          operations: ['view', 'edit'],
          expiresAt: null,
        },
        {
          principalType: 'team',
          principalId: 'team-1',
          operations: ['deploy'],
          expiresAt: null,
        },
      ],
      userTeamMemberships: [{ teamId: 'team-1', role: 'member' }],
    });

    const perms = resolvePermissions(ctx);
    expect(perms).toContain('view');
    expect(perms).toContain('edit');
    expect(perms).toContain('deploy');
  });

  it('should exclude expired grants while keeping active ones', () => {
    const ctx = makeContext({
      userId: 'user-a',
      explicitPermissions: [
        {
          principalType: 'user',
          principalId: 'user-a',
          operations: ['view', 'edit', 'deploy'],
          expiresAt: new Date(Date.now() - 1000), // expired
        },
        {
          principalType: 'user',
          principalId: 'user-a',
          operations: ['view'],
          expiresAt: null, // permanent
        },
      ],
    });

    const perms = resolvePermissions(ctx);
    expect(perms).toContain('view');
    expect(perms).not.toContain('edit');
    expect(perms).not.toContain('deploy');
  });
});
