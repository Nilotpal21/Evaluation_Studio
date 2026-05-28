/**
 * Project Services Tests
 *
 * Tests for:
 * - project-service (project CRUD, agent management, session functions)
 * - audit-service (audit logging and querying)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCKS - project-service dependencies
// =============================================================================

const mockFindProjectBySlug = vi.fn();
const mockFindProjects = vi.fn();
const mockCreateProjectRepo = vi.fn();
const mockUpdateProjectRepo = vi.fn();
const mockDeleteProjectRepo = vi.fn();
const mockFindProjectByIdAndTenant = vi.fn();
const mockFindProjectAgents = vi.fn();
const mockFindProjectMembershipsByUserId = vi.fn();
const mockCreateProjectAgent = vi.fn();
const mockCreateProjectMember = vi.fn();
const mockFindProjectAgentByIdAndTenant = vi.fn();
const mockUpdateProjectAgent = vi.fn();
const mockDeleteProjectAgent = vi.fn();

vi.mock('@/repos/project-repo', () => ({
  findProjectBySlug: (...args: unknown[]) => mockFindProjectBySlug(...args),
  findProjects: (...args: unknown[]) => mockFindProjects(...args),
  createProject: (...args: unknown[]) => mockCreateProjectRepo(...args),
  updateProject: (...args: unknown[]) => mockUpdateProjectRepo(...args),
  deleteProject: (...args: unknown[]) => mockDeleteProjectRepo(...args),
  findProjectByIdAndTenant: (...args: unknown[]) => mockFindProjectByIdAndTenant(...args),
  findProjectAgents: (...args: unknown[]) => mockFindProjectAgents(...args),
  findProjectMembershipsByUserId: (...args: unknown[]) =>
    mockFindProjectMembershipsByUserId(...args),
  createProjectAgent: (...args: unknown[]) => mockCreateProjectAgent(...args),
  createProjectMember: (...args: unknown[]) => mockCreateProjectMember(...args),
  findProjectAgentByIdAndTenant: (...args: unknown[]) => mockFindProjectAgentByIdAndTenant(...args),
  updateProjectAgent: (...args: unknown[]) => mockUpdateProjectAgent(...args),
  deleteProjectAgent: (...args: unknown[]) => mockDeleteProjectAgent(...args),
}));

const mockFindTenantMembershipsByUserId = vi.fn();
const mockResolveStudioPermissions = vi.fn();
const mockHasPermission = vi.fn();
const mockRewriteProjectAgentDraftDeclaredName = vi.fn();

vi.mock('@/repos/workspace-repo', () => ({
  findTenantMembershipsByUserId: (...args: unknown[]) => mockFindTenantMembershipsByUserId(...args),
}));

vi.mock('@/lib/permission-resolver', () => ({
  resolveStudioPermissions: (...args: unknown[]) => mockResolveStudioPermissions(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

vi.mock('@agent-platform/project-io/project-agent-draft-metadata', () => ({
  rewriteProjectAgentDraftDeclaredName: (...args: unknown[]) =>
    mockRewriteProjectAgentDraftDeclaredName(...args),
}));

vi.mock('@agent-platform/shared', () => ({
  buildProjectAgentPath: (projectId: string, agentName: string) =>
    `${projectId.trim()}/${agentName.trim()}`,
  slugify: (str: string) =>
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, ''),
}));

// Mock database models for session operations
const mockSessionCreate = vi.fn();
const mockSessionFind = vi.fn();
const mockSessionFindOneAndUpdate = vi.fn();
const mockVariableNamespaceCreate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Session: {
    create: (...args: unknown[]) => mockSessionCreate(...args),
    find: (...args: unknown[]) => mockSessionFind(...args),
    findOneAndUpdate: (...args: unknown[]) => mockSessionFindOneAndUpdate(...args),
  },
  VariableNamespace: {
    create: (...args: unknown[]) => mockVariableNamespaceCreate(...args),
  },
}));

// =============================================================================
// MOCKS - audit-service dependencies
// =============================================================================

const mockPublishStudioAuditPipelineEvent = vi.fn();
const mockQueryStudioAuditLogsFromClickHouse = vi.fn();

vi.mock('@/lib/studio-audit-pipeline-writer', () => ({
  publishStudioAuditPipelineEvent: (...args: unknown[]) =>
    mockPublishStudioAuditPipelineEvent(...args),
}));

vi.mock('@/lib/studio-clickhouse-audit-reader', () => ({
  queryStudioAuditLogsFromClickHouse: (...args: unknown[]) =>
    mockQueryStudioAuditLogsFromClickHouse(...args),
}));

// =============================================================================
// PROJECT SERVICE TESTS
// =============================================================================

describe('Project Service', () => {
  let projectService: typeof import('../services/project-service');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockVariableNamespaceCreate.mockResolvedValue(undefined);
    mockCreateProjectMember.mockResolvedValue(undefined);
    mockResolveStudioPermissions.mockResolvedValue([]);
    mockHasPermission.mockImplementation(
      (permissions: unknown, permission: unknown) =>
        Array.isArray(permissions) &&
        typeof permission === 'string' &&
        permissions.includes(permission),
    );
    mockRewriteProjectAgentDraftDeclaredName.mockImplementation(
      (input: { recordName: string; dslContent?: string | null }) => ({
        ok: true,
        recordName: input.recordName,
        dslContent: input.dslContent ?? null,
      }),
    );
    projectService = await import('../services/project-service');
  });

  // ---------------------------------------------------------------------------
  // Project CRUD
  // ---------------------------------------------------------------------------

  describe('createProject', () => {
    test('creates project with generated slug', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);
      mockCreateProjectRepo.mockResolvedValue({
        id: 'proj-1',
        name: 'My Project',
        slug: 'my-project',
        ownerId: 'user-1',
      });

      const result = await projectService.createProject({
        name: 'My Project',
        ownerId: 'user-1',
        tenantId: 'tenant-1',
      });

      expect(result.id).toBe('proj-1');
      expect(mockCreateProjectRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Project',
          slug: 'my-project',
          ownerId: 'user-1',
        }),
      );
    });

    test('uses provided slug', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);
      mockCreateProjectRepo.mockResolvedValue({
        id: 'proj-2',
        name: 'Custom',
        slug: 'custom-slug',
      });

      await projectService.createProject({
        name: 'Custom',
        slug: 'custom-slug',
        ownerId: 'user-1',
        tenantId: 'tenant-1',
      });

      expect(mockCreateProjectRepo).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'custom-slug' }),
      );
    });

    test('resolves slug collision by appending suffix', async () => {
      // First call returns existing, second call returns null (unique slug found)
      mockFindProjectBySlug.mockResolvedValueOnce({ id: 'existing-1' }).mockResolvedValueOnce(null);
      mockCreateProjectRepo.mockResolvedValue({
        id: 'proj-3',
        name: 'Dup',
        slug: 'dup-1',
      });

      await projectService.createProject({
        name: 'Dup',
        ownerId: 'user-1',
        tenantId: 'tenant-1',
      });

      expect(mockCreateProjectRepo).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'dup-1' }),
      );
    });

    test('includes tenantId when provided', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);
      mockCreateProjectRepo.mockResolvedValue({
        id: 'proj-4',
        name: 'Tenant Project',
        slug: 'tenant-project',
        tenantId: 'tenant-1',
      });

      await projectService.createProject({
        name: 'Tenant Project',
        ownerId: 'user-1',
        tenantId: 'tenant-1',
      });

      expect(mockCreateProjectRepo).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    test('includes description when provided', async () => {
      mockFindProjectBySlug.mockResolvedValue(null);
      mockCreateProjectRepo.mockResolvedValue({
        id: 'proj-5',
        name: 'Described',
        description: 'A test project',
      });

      await projectService.createProject({
        name: 'Described',
        description: 'A test project',
        ownerId: 'user-1',
        tenantId: 'tenant-1',
      });

      expect(mockCreateProjectRepo).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'A test project' }),
      );
    });
  });

  describe('getProjectById', () => {
    test('returns project when found', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', name: 'Test' });
      const result = await projectService.getProjectById('proj-1', 'tenant-1');
      expect(result).toEqual({ id: 'proj-1', name: 'Test' });
      expect(mockFindProjectByIdAndTenant).toHaveBeenCalledWith('proj-1', 'tenant-1');
    });

    test('returns null when not found', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue(null);
      const result = await projectService.getProjectById('nonexistent', 'tenant-1');
      expect(result).toBeNull();
    });
  });

  describe('getProjectBySlug', () => {
    test('delegates to findProjectBySlug with tenantId', async () => {
      mockFindProjectBySlug.mockResolvedValue({ id: 'proj-1', slug: 'test' });
      const result = await projectService.getProjectBySlug('test', 'tenant-1');
      expect(result).toEqual({ id: 'proj-1', slug: 'test' });
      expect(mockFindProjectBySlug).toHaveBeenCalledWith('test', 'tenant-1');
    });
  });

  describe('getUserProjects', () => {
    test('returns user projects ordered by updatedAt desc', async () => {
      mockFindProjects.mockResolvedValue([
        { id: 'proj-1', name: 'A' },
        { id: 'proj-2', name: 'B' },
      ]);

      const result = await projectService.getUserProjects('user-1');

      expect(result).toHaveLength(2);
      expect(mockFindProjects).toHaveBeenCalledWith(
        { ownerId: 'user-1' },
        { orderBy: { updatedAt: 'desc' } },
      );
    });
  });

  describe('updateProject', () => {
    test('delegates to updateProjectRepo with tenantId', async () => {
      mockUpdateProjectRepo.mockResolvedValue({ id: 'proj-1', name: 'Updated' });

      const result = await projectService.updateProject('proj-1', { name: 'Updated' }, 'tenant-1');
      expect(result.name).toBe('Updated');
      expect(mockUpdateProjectRepo).toHaveBeenCalledWith('proj-1', { name: 'Updated' }, 'tenant-1');
    });

    test('supports setting entryAgentName to null', async () => {
      mockUpdateProjectRepo.mockResolvedValue({ id: 'proj-1', entryAgentName: null });

      await projectService.updateProject('proj-1', { entryAgentName: null }, 'tenant-1');
      expect(mockUpdateProjectRepo).toHaveBeenCalledWith(
        'proj-1',
        { entryAgentName: null },
        'tenant-1',
      );
    });
  });

  describe('deleteProject', () => {
    test('delegates to deleteProjectRepo with tenantId', async () => {
      mockDeleteProjectRepo.mockResolvedValue(undefined);

      await projectService.deleteProject('proj-1', 'tenant-1');
      expect(mockDeleteProjectRepo).toHaveBeenCalledWith('proj-1', 'tenant-1');
    });
  });

  describe('getProjectWithCounts', () => {
    test('returns project with counts', async () => {
      mockFindProjects.mockResolvedValue([{ id: 'proj-1', name: 'Test', _count: { agents: 3 } }]);

      const result = await projectService.getProjectWithCounts('proj-1', 'tenant-1');
      expect(result).toEqual({ id: 'proj-1', name: 'Test', _count: { agents: 3 } });
    });

    test('returns null when project not found', async () => {
      mockFindProjects.mockResolvedValue([]);

      const result = await projectService.getProjectWithCounts('nonexistent', 'tenant-1');
      expect(result).toBeNull();
    });
  });

  describe('getUserProjectsWithCounts', () => {
    test('returns admin-tenant projects and explicitly shared member projects', async () => {
      mockFindTenantMembershipsByUserId.mockResolvedValue([
        { tenantId: 'tenant-admin', role: 'ADMIN' },
        { tenantId: 'tenant-member', role: 'MEMBER' },
      ]);
      mockFindProjectMembershipsByUserId.mockResolvedValue([{ projectId: 'proj-shared' }]);
      mockFindProjects.mockResolvedValue([
        { id: 'proj-1', name: 'Own' },
        { id: 'proj-2', name: 'Admin tenant project' },
        { id: 'proj-3', name: 'Shared' },
      ]);

      const result = await projectService.getUserProjectsWithCounts('user-1');

      expect(result).toHaveLength(3);
      expect(mockFindProjectMembershipsByUserId).toHaveBeenCalledWith('user-1');
      expect(mockFindProjects).toHaveBeenCalledWith(
        expect.objectContaining({
          OR: expect.arrayContaining([
            { ownerId: 'user-1' },
            { tenantId: { in: ['tenant-admin'] } },
            { tenantId: { in: ['tenant-member'] }, id: { in: ['proj-shared'] } },
          ]),
        }),
        expect.objectContaining({
          include: expect.any(Object),
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    test('returns all tenant projects for tenant admins when a tenant is requested', async () => {
      mockFindTenantMembershipsByUserId.mockResolvedValue([
        { tenantId: 'tenant-1', role: 'MEMBER' },
        { tenantId: 'tenant-2', role: 'ADMIN' },
      ]);
      mockFindProjects.mockResolvedValue([{ id: 'proj-2', name: 'Scoped' }]);

      const result = await projectService.getUserProjectsWithCounts('user-1', 'tenant-2');

      expect(result).toEqual([{ id: 'proj-2', name: 'Scoped' }]);
      expect(mockFindProjectMembershipsByUserId).not.toHaveBeenCalled();
      expect(mockFindProjects).toHaveBeenCalledWith(
        { tenantId: 'tenant-2' },
        expect.objectContaining({
          include: expect.any(Object),
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    test('treats custom tenant roles with project wildcard access as tenant-wide access', async () => {
      mockFindTenantMembershipsByUserId.mockResolvedValue([
        { tenantId: 'tenant-2', role: 'custom', customRoleId: 'role-1' },
      ]);
      mockResolveStudioPermissions.mockResolvedValue(['project:*']);
      mockFindProjects.mockResolvedValue([{ id: 'proj-2', name: 'Scoped' }]);

      const result = await projectService.getUserProjectsWithCounts('user-1', 'tenant-2');

      expect(result).toEqual([{ id: 'proj-2', name: 'Scoped' }]);
      expect(mockResolveStudioPermissions).toHaveBeenCalledWith(
        'tenant-2',
        'user-1',
        'custom',
        'role-1',
      );
      expect(mockFindProjectMembershipsByUserId).not.toHaveBeenCalled();
      expect(mockFindProjects).toHaveBeenCalledWith(
        { tenantId: 'tenant-2' },
        expect.objectContaining({
          include: expect.any(Object),
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    test('scopes member results to owned and explicitly shared tenant projects', async () => {
      mockFindTenantMembershipsByUserId.mockResolvedValue([
        { tenantId: 'tenant-2', role: 'MEMBER' },
      ]);
      mockFindProjectMembershipsByUserId.mockResolvedValue([
        { projectId: 'proj-shared' },
        { projectId: 'proj-other-tenant' },
      ]);
      mockFindProjects.mockResolvedValue([{ id: 'proj-shared', name: 'Scoped shared project' }]);

      const result = await projectService.getUserProjectsWithCounts('user-1', 'tenant-2');

      expect(result).toEqual([{ id: 'proj-shared', name: 'Scoped shared project' }]);
      expect(mockFindProjectMembershipsByUserId).toHaveBeenCalledWith('user-1');
      expect(mockFindProjects).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-2',
          OR: [{ ownerId: 'user-1' }, { id: { in: ['proj-shared', 'proj-other-tenant'] } }],
        },
        expect.objectContaining({
          include: expect.any(Object),
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    test('returns no projects when the requested tenant is not accessible', async () => {
      mockFindTenantMembershipsByUserId.mockResolvedValue([
        { tenantId: 'tenant-1', role: 'MEMBER' },
      ]);

      const result = await projectService.getUserProjectsWithCounts('user-1', 'tenant-2');

      expect(result).toEqual([]);
      expect(mockFindProjects).not.toHaveBeenCalled();
      expect(mockFindProjectMembershipsByUserId).not.toHaveBeenCalled();
    });

    test('falls back to owned tenant projects when a member has no explicit project shares', async () => {
      mockFindTenantMembershipsByUserId.mockResolvedValue([
        { tenantId: 'tenant-1', role: 'MEMBER' },
      ]);
      mockFindProjectMembershipsByUserId.mockResolvedValue([]);
      mockFindProjects.mockResolvedValue([{ id: 'proj-1', name: 'Own' }]);

      const result = await projectService.getUserProjectsWithCounts('user-1', 'tenant-1');

      expect(result).toEqual([{ id: 'proj-1', name: 'Own' }]);
      expect(mockFindProjects).toHaveBeenCalledWith(
        { tenantId: 'tenant-1', ownerId: 'user-1' },
        expect.objectContaining({
          include: expect.any(Object),
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    test('works when user has no tenant memberships', async () => {
      mockFindTenantMembershipsByUserId.mockResolvedValue([]);
      mockFindProjects.mockResolvedValue([{ id: 'proj-1', name: 'Own' }]);

      await projectService.getUserProjectsWithCounts('user-1');

      expect(mockFindProjects).toHaveBeenCalledWith(
        expect.objectContaining({
          OR: [{ ownerId: 'user-1' }],
        }),
        expect.any(Object),
      );
      expect(mockFindProjectMembershipsByUserId).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Agent CRUD
  // ---------------------------------------------------------------------------

  describe('addAgentToProject', () => {
    test('delegates to createProjectAgent with the canonical agentPath', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockCreateProjectAgent.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'booking_agent',
        agentPath: 'proj-1/booking_agent',
      });

      const result = await projectService.addAgentToProject({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
        name: 'booking_agent',
        agentPath: 'hotel-booking/booking_agent',
      });

      expect(result.id).toBe('agent-1');
      expect(mockCreateProjectAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          tenantId: 'tenant-1',
          name: 'booking_agent',
          agentPath: 'proj-1/booking_agent',
        }),
      );
    });
  });

  describe('getProjectAgents', () => {
    test('returns agents for project when tenant is verified', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgents.mockResolvedValue([
        { id: 'agent-1', name: 'agent_a' },
        { id: 'agent-2', name: 'agent_b' },
      ]);

      const result = await projectService.getProjectAgents('proj-1', 'tenant-1');
      expect(result).toHaveLength(2);
      expect(mockFindProjectByIdAndTenant).toHaveBeenCalledWith('proj-1', 'tenant-1');
      expect(mockFindProjectAgents).toHaveBeenCalledWith('proj-1', 'tenant-1');
    });

    test('returns empty array when project not found for tenant', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue(null);

      const result = await projectService.getProjectAgents('proj-1', 'tenant-1');
      expect(result).toEqual([]);
    });
  });

  describe('getAgentById', () => {
    test('returns agent when found', async () => {
      mockFindProjectAgentByIdAndTenant.mockResolvedValue({ id: 'agent-1', name: 'test' });
      const result = await projectService.getAgentById('agent-1', 'tenant-1');
      expect(result.name).toBe('test');
      expect(mockFindProjectAgentByIdAndTenant).toHaveBeenCalledWith('agent-1', 'tenant-1');
    });

    test('returns null when not found', async () => {
      mockFindProjectAgentByIdAndTenant.mockResolvedValue(null);
      const result = await projectService.getAgentById('nonexistent', 'tenant-1');
      expect(result).toBeNull();
    });
  });

  describe('updateAgent', () => {
    test('updates agent fields with tenantId', async () => {
      mockFindProjectAgentByIdAndTenant.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'old_name',
      });
      mockUpdateProjectAgent.mockResolvedValue({ id: 'agent-1', name: 'renamed' });

      const result = await projectService.updateAgent('agent-1', { name: 'renamed' }, 'tenant-1');
      expect(result.name).toBe('renamed');
      expect(mockUpdateProjectAgent).toHaveBeenCalledWith(
        'agent-1',
        { name: 'renamed', agentPath: 'proj-1/renamed' },
        'tenant-1',
      );
    });

    test('derives canonical agentPath from projectId when renaming an agent', async () => {
      mockFindProjectAgentByIdAndTenant.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'booking_agent',
      });
      mockUpdateProjectAgent.mockResolvedValue({
        id: 'agent-1',
        name: 'renamed_agent',
        agentPath: 'proj-1/renamed_agent',
      });

      const result = await projectService.updateAgent(
        'agent-1',
        { name: ' renamed_agent ' },
        'tenant-1',
      );

      expect(result.agentPath).toBe('proj-1/renamed_agent');
      expect(mockUpdateProjectAgent).toHaveBeenCalledWith(
        'agent-1',
        {
          name: 'renamed_agent',
          agentPath: 'proj-1/renamed_agent',
        },
        'tenant-1',
      );
    });

    test('rewrites the persisted DSL header when renaming an agent', async () => {
      mockFindProjectAgentByIdAndTenant.mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        name: 'booking_agent',
        dslContent: 'AGENT: booking_agent\nGOAL: "Handle booking"\n',
      });
      mockRewriteProjectAgentDraftDeclaredName.mockReturnValue({
        ok: true,
        recordName: 'booking_agent',
        declaredName: 'booking_agent',
        dslContent: 'AGENT: renamed_agent\nGOAL: "Handle booking"\n',
      });
      mockUpdateProjectAgent.mockResolvedValue({
        id: 'agent-1',
        name: 'renamed_agent',
        agentPath: 'proj-1/renamed_agent',
        dslContent: 'AGENT: renamed_agent\nGOAL: "Handle booking"\n',
      });

      const result = await projectService.updateAgent(
        'agent-1',
        { name: ' renamed_agent ' },
        'tenant-1',
      );

      expect(result.dslContent).toBe('AGENT: renamed_agent\nGOAL: "Handle booking"\n');
      expect(mockRewriteProjectAgentDraftDeclaredName).toHaveBeenCalledWith({
        recordName: 'booking_agent',
        nextName: 'renamed_agent',
        dslContent: 'AGENT: booking_agent\nGOAL: "Handle booking"\n',
      });
      expect(mockUpdateProjectAgent).toHaveBeenCalledWith(
        'agent-1',
        {
          name: 'renamed_agent',
          agentPath: 'proj-1/renamed_agent',
          dslContent: 'AGENT: renamed_agent\nGOAL: "Handle booking"\n',
        },
        'tenant-1',
      );
    });
  });

  describe('removeAgentFromProject', () => {
    test('delegates to deleteProjectAgent with tenantId', async () => {
      mockDeleteProjectAgent.mockResolvedValue(undefined);
      await projectService.removeAgentFromProject('agent-1', 'tenant-1');
      expect(mockDeleteProjectAgent).toHaveBeenCalledWith('agent-1', 'tenant-1');
    });
  });

  // ---------------------------------------------------------------------------
  // Session Functions
  // ---------------------------------------------------------------------------

  describe('createSession', () => {
    test('creates session with tenant and project', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockSessionCreate.mockResolvedValue({
        toObject: () => ({
          _id: 'session-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          currentAgent: 'booking_agent',
        }),
      });

      const result = await projectService.createSession(
        'proj-1',
        'booking_agent',
        'user-1',
        'tenant-1',
      );

      expect(result.id).toBe('session-1');
      expect(result.tenantId).toBe('tenant-1');
      expect(mockFindProjectByIdAndTenant).toHaveBeenCalledWith('proj-1', 'tenant-1');
      expect(mockSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          initiatedById: 'user-1',
          currentAgent: 'booking_agent',
          channel: 'web_chat',
        }),
      );
    });

    test('throws when project not found for tenant', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue(null);

      await expect(
        projectService.createSession('proj-1', 'agent', 'user-1', 'tenant-1'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('not found for tenant'),
      });
    });

    test('throws when project not found (nonexistent id)', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue(null);

      await expect(
        projectService.createSession('nonexistent', 'agent', 'user-1', 'tenant-1'),
      ).rejects.toMatchObject({
        message: expect.stringContaining('not found for tenant'),
      });
    });
  });

  describe('getProjectSessions', () => {
    test('returns sessions with default pagination', async () => {
      const mockChain = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([
          { _id: 's-1', projectId: 'proj-1' },
          { _id: 's-2', projectId: 'proj-1' },
        ]),
      };
      mockSessionFind.mockReturnValue(mockChain);

      const result = await projectService.getProjectSessions('proj-1');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('s-1');
      expect(mockChain.sort).toHaveBeenCalledWith({ lastActivityAt: -1 });
      expect(mockChain.skip).toHaveBeenCalledWith(0);
      expect(mockChain.limit).toHaveBeenCalledWith(50);
    });

    test('applies custom pagination and tenantId filter', async () => {
      const mockChain = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
      mockSessionFind.mockReturnValue(mockChain);

      await projectService.getProjectSessions('proj-1', {
        limit: 10,
        offset: 20,
        tenantId: 'tenant-1',
      });

      expect(mockSessionFind).toHaveBeenCalledWith({ projectId: 'proj-1', tenantId: 'tenant-1' });
      expect(mockChain.skip).toHaveBeenCalledWith(20);
      expect(mockChain.limit).toHaveBeenCalledWith(10);
    });
  });

  describe('getUserSessions', () => {
    test('returns sessions filtered by initiatedById', async () => {
      const mockChain = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([{ _id: 's-1' }]),
      };
      mockSessionFind.mockReturnValue(mockChain);

      const result = await projectService.getUserSessions('user-1');

      expect(result).toHaveLength(1);
      expect(mockSessionFind).toHaveBeenCalledWith({ initiatedById: 'user-1' });
    });

    test('applies tenantId filter', async () => {
      const mockChain = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue([]),
      };
      mockSessionFind.mockReturnValue(mockChain);

      await projectService.getUserSessions('user-1', { tenantId: 'tenant-1' });

      expect(mockSessionFind).toHaveBeenCalledWith({
        initiatedById: 'user-1',
        tenantId: 'tenant-1',
      });
    });
  });

  describe('updateSessionActivity', () => {
    test('updates lastActivityAt with current date (tenant-scoped)', async () => {
      mockSessionFindOneAndUpdate.mockResolvedValue({});

      await projectService.updateSessionActivity('session-1', 'tenant-1');

      expect(mockSessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'session-1', tenantId: 'tenant-1' },
        { $set: { lastActivityAt: expect.any(Date) } },
      );
    });
  });
});

// =============================================================================
// AUDIT SERVICE TESTS
// =============================================================================

describe('Audit Service', () => {
  let auditService: typeof import('../services/audit-service');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({ logs: [], total: 0 });
    auditService = await import('../services/audit-service');
  });

  describe('AuditActions', () => {
    test('defines authentication actions', () => {
      expect(auditService.AuditActions.LOGIN).toBe('login');
      expect(auditService.AuditActions.LOGOUT).toBe('logout');
      expect(auditService.AuditActions.LOGIN_FAILED).toBe('login_failed');
    });

    test('defines project actions', () => {
      expect(auditService.AuditActions.PROJECT_CREATED).toBe('project_created');
      expect(auditService.AuditActions.PROJECT_UPDATED).toBe('project_updated');
      expect(auditService.AuditActions.PROJECT_DELETED).toBe('project_deleted');
    });

    test('defines MFA actions', () => {
      expect(auditService.AuditActions.MFA_SETUP_CONFIRMED).toBe('mfa_setup_confirmed');
      expect(auditService.AuditActions.MFA_VERIFIED).toBe('mfa_verified');
      expect(auditService.AuditActions.MFA_FAILED).toBe('mfa_failed');
      expect(auditService.AuditActions.MFA_LOCKED).toBe('mfa_locked');
    });

    test('defines SSO actions', () => {
      expect(auditService.AuditActions.SSO_LOGIN).toBe('sso_login');
      expect(auditService.AuditActions.SSO_LOGIN_FAILED).toBe('sso_login_failed');
    });

    test('defines GDPR actions', () => {
      expect(auditService.AuditActions.GDPR_DELETION_COMPLETED).toBe('gdpr_deletion_completed');
      expect(auditService.AuditActions.GDPR_DELETION_FAILED).toBe('gdpr_deletion_failed');
    });

    test('defines device auth actions', () => {
      expect(auditService.AuditActions.DEVICE_AUTH_STARTED).toBe('device_auth_started');
      expect(auditService.AuditActions.DEVICE_AUTH_APPROVED).toBe('device_auth_approved');
      expect(auditService.AuditActions.DEVICE_AUTH_COMPLETED).toBe('device_auth_completed');
    });

    test('defines archive actions', () => {
      expect(auditService.AuditActions.ARCHIVE_CREATED).toBe('archive_created');
      expect(auditService.AuditActions.ARCHIVE_DOWNLOADED).toBe('archive_downloaded');
      expect(auditService.AuditActions.ARCHIVE_DELETED).toBe('archive_deleted');
    });
  });

  describe('logAuditEvent', () => {
    test('publishes audit log entries to the pipeline', async () => {
      await auditService.logAuditEvent({
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'login',
        ip: '192.168.1.1',
        userAgent: 'TestAgent/1.0',
      });

      expect(mockPublishStudioAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user-1',
          tenantId: 'tenant-1',
          action: 'login',
          ipAddress: '192.168.1.1',
          userAgent: 'TestAgent/1.0',
        }),
        'tenant-1',
      );
    });

    test('keeps metadata as an object payload', async () => {
      await auditService.logAuditEvent({
        action: 'project_created',
        metadata: { projectId: 'proj-1', projectName: 'Test' },
      });

      expect(mockPublishStudioAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            projectId: 'proj-1',
            projectName: 'Test',
          }),
        }),
        null,
      );
    });

    test('passes null metadata when no metadata provided', async () => {
      await auditService.logAuditEvent({
        action: 'logout',
      });

      expect(mockPublishStudioAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: null,
        }),
        null,
      );
    });

    test('does not throw when audit logging fails', async () => {
      mockPublishStudioAuditPipelineEvent.mockImplementation(() => {
        throw new Error('producer unavailable');
      });
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await auditService.logAuditEvent({
        action: 'login',
        userId: 'user-1',
      });

      // Should not throw, and should write fallback to stderr
      expect(stderrWrite).toHaveBeenCalled();
      stderrWrite.mockRestore();
    });

    test('writes fallback to stderr when audit fails', async () => {
      mockPublishStudioAuditPipelineEvent.mockImplementation(() => {
        throw new Error('producer unavailable');
      });
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await auditService.logAuditEvent({
        action: 'login_failed',
        userId: 'user-1',
      });

      const callArg = stderrWrite.mock.calls[0]?.[0] as string;
      expect(callArg).toContain('audit_fallback');
      expect(callArg).toContain('login_failed');
      stderrWrite.mockRestore();
    });
  });

  describe('getUserAuditLogs', () => {
    test('queries with userId, tenantId, and default pagination', async () => {
      mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({
        logs: [{ id: 'log-1' }],
        total: 1,
      });

      const result = await auditService.getUserAuditLogs('user-1', 'tenant-1');

      expect(result).toHaveLength(1);
      expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith({
        scope: 'personal',
        personalScopeMode: 'tenant-safe',
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: undefined,
        from: undefined,
        to: undefined,
        limit: 50,
        offset: 0,
      });
    });

    test('applies custom pagination and action filter', async () => {
      mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({ logs: [], total: 0 });

      await auditService.getUserAuditLogs('user-1', 'tenant-1', {
        limit: 10,
        offset: 5,
        action: 'login',
      });

      expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith({
        scope: 'personal',
        personalScopeMode: 'tenant-safe',
        userId: 'user-1',
        tenantId: 'tenant-1',
        action: 'login',
        from: undefined,
        to: undefined,
        limit: 10,
        offset: 5,
      });
    });
  });

  describe('getRecentAuditLogs', () => {
    test('queries recent logs for tenant with defaults', async () => {
      mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({ logs: [], total: 0 });

      await auditService.getRecentAuditLogs('tenant-1');

      expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith({
        scope: 'workspace',
        personalScopeMode: 'tenant-safe',
        userId: '',
        tenantId: 'tenant-1',
        action: undefined,
        from: null,
        to: null,
        limit: 100,
        offset: 0,
      });
    });

    test('applies action and since filters', async () => {
      mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({ logs: [], total: 0 });
      const since = new Date('2026-01-01');

      await auditService.getRecentAuditLogs('tenant-1', {
        limit: 25,
        action: 'login',
        since,
      });

      expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith({
        scope: 'workspace',
        personalScopeMode: 'tenant-safe',
        userId: '',
        tenantId: 'tenant-1',
        action: 'login',
        from: since.toISOString(),
        to: null,
        limit: 25,
        offset: 0,
      });
    });
  });
});
