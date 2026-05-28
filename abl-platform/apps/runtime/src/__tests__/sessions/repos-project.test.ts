/**
 * Project Repository Integration Tests
 *
 * Tests project-repo.ts and deployment-repo.ts functions against a real
 * in-memory MongoDB. Covers project CRUD, agent resolution, version
 * management, deployment lifecycle, and channel configuration.
 *
 * IMPORTANT: All imports from @agent-platform/database/models and repo
 * modules MUST be dynamic (inside beforeAll) because the models barrel
 * triggers an auto-connect on import.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from '../helpers/setup-mongo.js';

// ─── Lazy-loaded references ─────────────────────────────────────────────────

let Project: any;
let ProjectAgent: any;
let AgentVersion: any;
let AgentModelConfig: any;
let Deployment: any;
let SDKChannel: any;

// Project repo functions
let findProjectByIdAndTenant: any;
let findProjectWithAgents: any;
let findProjectAgentByPath: any;
let findProjectAgentByName: any;
let findProjectAgentsForProject: any;
let findProjectAgentForProject: any;
let findProjectAgentsWithTenant: any;
let updateProjectAgentDsl: any;
let findAgentVersion: any;
let listAgentVersions: any;
let countAgentVersions: any;
let createAgentVersion: any;
let findLatestAgentVersion: any;
let getAllAgentVersionNumbers: any;
let promoteAgentVersion: any;
let updateProjectAgentActiveVersions: any;
let findAgentModelConfig: any;
let upsertAgentModelConfig: any;

// Deployment repo functions
let findActiveDeployment: any;
let findDeploymentById: any;
let findDeploymentBySlug: any;
let listDeployments: any;
let createDeployment: any;
let updateDeploymentStatus: any;
let countLinkedChannels: any;

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestMongo();

  const models = await import('@agent-platform/database/models');
  Project = models.Project;
  ProjectAgent = models.ProjectAgent;
  AgentVersion = models.AgentVersion;
  AgentModelConfig = models.AgentModelConfig;
  Deployment = models.Deployment;
  SDKChannel = models.SDKChannel;

  const projRepo = await import('../../repos/project-repo.js');
  findProjectByIdAndTenant = projRepo.findProjectByIdAndTenant;
  findProjectWithAgents = projRepo.findProjectWithAgents;
  findProjectAgentByPath = projRepo.findProjectAgentByPath;
  findProjectAgentByName = projRepo.findProjectAgentByName;
  findProjectAgentsForProject = projRepo.findProjectAgentsForProject;
  findProjectAgentForProject = projRepo.findProjectAgentForProject;
  findProjectAgentsWithTenant = projRepo.findProjectAgentsWithTenant;
  updateProjectAgentDsl = projRepo.updateProjectAgentDsl;
  findAgentVersion = projRepo.findAgentVersion;
  listAgentVersions = projRepo.listAgentVersions;
  countAgentVersions = projRepo.countAgentVersions;
  createAgentVersion = projRepo.createAgentVersion;
  findLatestAgentVersion = projRepo.findLatestAgentVersion;
  getAllAgentVersionNumbers = projRepo.getAllAgentVersionNumbers;
  promoteAgentVersion = projRepo.promoteAgentVersion;
  updateProjectAgentActiveVersions = projRepo.updateProjectAgentActiveVersions;
  findAgentModelConfig = projRepo.findAgentModelConfig;
  upsertAgentModelConfig = projRepo.upsertAgentModelConfig;

  const depRepo = await import('../../repos/deployment-repo.js');
  findActiveDeployment = depRepo.findActiveDeployment;
  findDeploymentById = depRepo.findDeploymentById;
  findDeploymentBySlug = depRepo.findDeploymentBySlug;
  listDeployments = depRepo.listDeployments;
  createDeployment = depRepo.createDeployment;
  updateDeploymentStatus = depRepo.updateDeploymentStatus;
  countLinkedChannels = depRepo.countLinkedChannels;
}, 30_000);

afterAll(async () => {
  await teardownTestMongo();
}, 15_000);

beforeEach(async () => {
  await clearCollections();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test Project',
    slug: `test-project-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ownerId: 'owner-1',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  const name = (overrides.name as string) || 'booking_agent';
  const projectId = (overrides.projectId as string) || 'proj-1';
  return {
    projectId,
    name,
    agentPath: `${projectId}/${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tenantId: (overrides.tenantId as string) || 'tenant-1',
    ...overrides,
  };
}

function makeVersion(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'agent-1',
    version: '1.0.0',
    status: 'draft',
    dslContent: 'agent booking_agent {}',
    irContent: '{}',
    sourceHash: 'abc123',
    createdBy: 'user-1',
    ...overrides,
  };
}

function makeDeployment(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    environment: 'dev',
    agentVersionManifest: { booking_agent: '1.0.0' },
    entryAgentName: 'booking_agent',
    endpointSlug: `slug-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    status: 'active',
    createdBy: 'user-1',
    ...overrides,
  };
}

// #############################################################################
// project-repo: findProjectByIdAndTenant
// #############################################################################

describe('project-repo: findProjectByIdAndTenant', () => {
  it('returns project when id and tenantId match', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-x' }));

    const result = await findProjectByIdAndTenant(project._id, 'tenant-x');

    expect(result).not.toBeNull();
  });

  it('returns null when tenantId does not match', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-a' }));

    const result = await findProjectByIdAndTenant(project._id, 'tenant-b');

    expect(result).toBeNull();
  });

  it('returns null when project does not exist', async () => {
    const result = await findProjectByIdAndTenant('nonexistent', 'tenant-1');
    expect(result).toBeNull();
  });
});

// #############################################################################
// project-repo: findProjectWithAgents
// #############################################################################

describe('project-repo: findProjectWithAgents', () => {
  it('returns project with its agents', async () => {
    const project = await Project.create(makeProject());
    await ProjectAgent.create(makeAgent({ projectId: project._id, name: 'agent_a' }));
    await ProjectAgent.create(makeAgent({ projectId: project._id, name: 'agent_b' }));

    const result = await findProjectWithAgents(project._id, 'tenant-1');

    expect(result).not.toBeNull();
    expect(result!.agents).toHaveLength(2);
  });

  it('does not include agents from another tenant with the same projectId', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-owned' }));
    await ProjectAgent.create(
      makeAgent({ projectId: project._id, tenantId: 'tenant-owned', name: 'owned_agent' }),
    );
    await ProjectAgent.create(
      makeAgent({ projectId: project._id, tenantId: 'tenant-other', name: 'intruder_agent' }),
    );

    const result = await findProjectWithAgents(project._id, 'tenant-owned');

    expect(result).not.toBeNull();
    expect(result!.agents.map((agent: any) => agent.name)).toEqual(['owned_agent']);
  });

  it('returns null when tenantId does not match', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-scoped' }));

    const result = await findProjectWithAgents(project._id, 'tenant-scoped');
    expect(result).not.toBeNull();

    const mismatch = await findProjectWithAgents(project._id, 'wrong-tenant');
    expect(mismatch).toBeNull();
  });

  it('returns null when project not found', async () => {
    const result = await findProjectWithAgents('nonexistent', 'tenant-1');
    expect(result).toBeNull();
  });
});

// #############################################################################
// project-repo: findProjectAgentByPath
// #############################################################################

describe('project-repo: findProjectAgentByPath', () => {
  it('returns agent when found by agentPath with tenantId', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-path' }));
    const agentPath = `${project._id}/search_agent`;
    await ProjectAgent.create(
      makeAgent({
        projectId: project._id,
        name: 'search_agent',
        tenantId: 'tenant-path',
      }),
    );

    const result = await findProjectAgentByPath(agentPath, 'tenant-path');

    expect(result).not.toBeNull();
    expect(result.name).toBe('search_agent');
  });

  it('returns null when called without tenantId', async () => {
    const project = await Project.create(makeProject());
    const agentPath = `${project._id}/search_agent`;
    await ProjectAgent.create(
      makeAgent({
        projectId: project._id,
        name: 'search_agent',
      }),
    );

    const result = await findProjectAgentByPath(agentPath);
    expect(result).toBeNull();
  });

  it('returns null when agent belongs to a different tenant', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-owner' }));
    const agentPath = `${project._id}/isolated_agent`;
    await ProjectAgent.create(
      makeAgent({
        projectId: project._id,
        name: 'isolated_agent',
      }),
    );

    const result = await findProjectAgentByPath(agentPath, 'tenant-attacker');
    expect(result).toBeNull();
  });

  it('returns null when path does not exist', async () => {
    const result = await findProjectAgentByPath('nonexistent/path', 'tenant-1');
    expect(result).toBeNull();
  });
});

// #############################################################################
// project-repo: findProjectAgentByName
// #############################################################################

describe('project-repo: findProjectAgentByName', () => {
  it('returns null when called without tenantId (cross-tenant guard)', async () => {
    const result = await findProjectAgentByName('booking_agent');
    expect(result).toBeNull();
  });

  it('scopes lookup to tenant projects when tenantId is provided', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-scope-test' }));
    await ProjectAgent.create(
      makeAgent({ projectId: project._id, name: 'my_agent', tenantId: 'tenant-scope-test' }),
    );

    const result = await findProjectAgentByName('my_agent', { tenantId: 'tenant-scope-test' });

    expect(result).not.toBeNull();
    expect(result.name).toBe('my_agent');
  });

  it('returns null when agent name does not exist for tenant', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-miss' }));
    await ProjectAgent.create(makeAgent({ projectId: project._id, name: 'existing_agent' }));

    const result = await findProjectAgentByName('nonexistent_agent', { tenantId: 'tenant-miss' });
    expect(result).toBeNull();
  });
});

// #############################################################################
// project-repo: findProjectAgentsForProject
// #############################################################################

describe('project-repo: findProjectAgentsForProject', () => {
  it('returns agents for a project sorted by name', async () => {
    const project = await Project.create(makeProject());
    await ProjectAgent.create(makeAgent({ projectId: project._id, name: 'zeta_agent' }));
    await ProjectAgent.create(makeAgent({ projectId: project._id, name: 'alpha_agent' }));

    const result = await findProjectAgentsForProject(project._id);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('alpha_agent');
    expect(result[1].name).toBe('zeta_agent');
  });

  it('returns empty array when project has no agents', async () => {
    const result = await findProjectAgentsForProject('empty-project');
    expect(result).toEqual([]);
  });

  it('includes version count when requested', async () => {
    const project = await Project.create(makeProject());
    const agent = await ProjectAgent.create(makeAgent({ projectId: project._id }));
    await AgentVersion.create(makeVersion({ agentId: agent._id, version: '1.0.0' }));
    await AgentVersion.create(makeVersion({ agentId: agent._id, version: '1.1.0' }));

    const result = await findProjectAgentsForProject(project._id, { includeVersionCount: true });

    expect(result).toHaveLength(1);
    expect(result[0]._count.versions).toBe(2);
  });
});

// #############################################################################
// project-repo: findProjectAgentForProject
// #############################################################################

describe('project-repo: findProjectAgentForProject', () => {
  it('returns a specific agent within a project by name', async () => {
    const project = await Project.create(makeProject());
    await ProjectAgent.create(makeAgent({ projectId: project._id, name: 'target_agent' }));

    const result = await findProjectAgentForProject(project._id, 'target_agent');

    expect(result).not.toBeNull();
    expect(result.name).toBe('target_agent');
  });

  it('does not return a cross-tenant agent when tenantId is supplied', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-owner' }));
    await ProjectAgent.create(
      makeAgent({ projectId: project._id, tenantId: 'tenant-other', name: 'target_agent' }),
    );

    const result = await findProjectAgentForProject(project._id, 'target_agent', 'tenant-owner');

    expect(result).toBeNull();
  });

  it('returns null when agent does not exist in project', async () => {
    const project = await Project.create(makeProject());

    const result = await findProjectAgentForProject(project._id, 'nonexistent_agent');
    expect(result).toBeNull();
  });

  it('includes tenantId when includeTenantId option is set', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-include' }));
    await ProjectAgent.create(makeAgent({ projectId: project._id, name: 'my_agent' }));

    const result = await findProjectAgentForProject(project._id, 'my_agent', undefined, {
      includeTenantId: true,
    });

    expect(result).not.toBeNull();
    expect(result.project).toBeDefined();
    expect(result.project.tenantId).toBe('tenant-include');
  });

  it('includes version count when includeVersionCount option is set', async () => {
    const project = await Project.create(makeProject());
    const agent = await ProjectAgent.create(
      makeAgent({ projectId: project._id, name: 'versioned_agent' }),
    );
    await AgentVersion.create(makeVersion({ agentId: agent._id, version: '1.0.0' }));
    await AgentVersion.create(makeVersion({ agentId: agent._id, version: '2.0.0' }));
    await AgentVersion.create(makeVersion({ agentId: agent._id, version: '3.0.0' }));

    const result = await findProjectAgentForProject(project._id, 'versioned_agent', undefined, {
      includeVersionCount: true,
    });

    expect(result._count.versions).toBe(3);
  });
});

// #############################################################################
// project-repo: findProjectAgentsWithTenant
// #############################################################################

describe('project-repo: findProjectAgentsWithTenant', () => {
  it('returns empty when tenantId is not provided', async () => {
    const result = await findProjectAgentsWithTenant({});
    expect(result).toEqual([]);
  });

  it('returns agents across all projects for a tenant', async () => {
    const proj1 = await Project.create(makeProject({ tenantId: 'tenant-multi', name: 'P1' }));
    const proj2 = await Project.create(makeProject({ tenantId: 'tenant-multi', name: 'P2' }));
    await ProjectAgent.create(
      makeAgent({ projectId: proj1._id, name: 'agent_a', tenantId: 'tenant-multi' }),
    );
    await ProjectAgent.create(
      makeAgent({ projectId: proj2._id, name: 'agent_b', tenantId: 'tenant-multi' }),
    );

    const result = await findProjectAgentsWithTenant({ tenantId: 'tenant-multi' });

    expect(result).toHaveLength(2);
    result.forEach((a: any) => {
      expect(a.project).toBeDefined();
      expect(a.project.name).toBeDefined();
    });
  });

  it('does not return agents from other tenants', async () => {
    const proj = await Project.create(makeProject({ tenantId: 'tenant-isolated' }));
    await ProjectAgent.create(makeAgent({ projectId: proj._id, name: 'isolated_agent' }));

    const result = await findProjectAgentsWithTenant({ tenantId: 'other-tenant' });
    expect(result).toEqual([]);
  });
});

// #############################################################################
// project-repo: updateProjectAgentDsl
// #############################################################################

describe('project-repo: updateProjectAgentDsl', () => {
  it('updates dslContent and refreshes the target draft metadata', async () => {
    const project = await Project.create(makeProject());
    const agent = await ProjectAgent.create(
      makeAgent({ projectId: project._id, dslContent: 'old dsl' }),
    );

    const result = await updateProjectAgentDsl(
      agent._id,
      `AGENT: agent_a
GOAL: "Handle requests"

HANDOFF:
  - TO: missing_agent
    WHEN: always
    CONTEXT:
      pass: []
`,
    );

    expect(result).not.toBeNull();
    expect(result.dslContent).toContain('missing_agent');
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.dslValidationStatus).toBe('error');
    expect(result.dslDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          source: 'runtime-dsl-save',
          message: expect.stringContaining(
            'Agent DSL declares "agent_a" but this record is "booking_agent"',
          ),
        }),
      ]),
    );
  });

  it('recomputes sibling readiness metadata when the updated DSL invalidates another agent', async () => {
    const tenantId = 'tenant-runtime-dsl';
    const project = await Project.create(makeProject({ tenantId }));
    const bookingAgent = await ProjectAgent.create(
      makeAgent({
        projectId: project._id,
        tenantId,
        name: 'booking_agent',
        dslContent: 'AGENT: booking_agent\nGOAL: "Handle bookings"\n',
      }),
    );
    await ProjectAgent.create(
      makeAgent({
        projectId: project._id,
        tenantId,
        name: 'billing_agent',
        dslContent: `AGENT: billing_agent
GOAL: "Handle billing questions"

HANDOFF:
  - TO: booking_agent
    WHEN: always
    CONTEXT:
      pass: []
`,
      }),
    );

    await updateProjectAgentDsl(
      bookingAgent._id,
      'AGENT: travel_agent\nGOAL: "Renamed working copy"\n',
      tenantId,
    );

    const updatedSibling = await ProjectAgent.findOne({
      projectId: project._id,
      tenantId,
      name: 'billing_agent',
    }).lean();

    expect(updatedSibling).not.toBeNull();
    expect(updatedSibling?.dslValidationStatus).toBe('error');
    expect(updatedSibling?.dslDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          source: 'runtime-dsl-save',
          message: expect.stringContaining('Handoff target "booking_agent" does not exist'),
        }),
      ]),
    );
  });

  it('returns null when agent does not exist', async () => {
    const result = await updateProjectAgentDsl('nonexistent-id', 'dsl');
    expect(result).toBeNull();
  });
});

// #############################################################################
// project-repo: Agent Version operations
// #############################################################################

describe('project-repo: Agent Version CRUD', () => {
  it('creates a version and returns it with an id', async () => {
    const version = await createAgentVersion({
      agentId: 'agent-v1',
      version: '1.0.0',
      dslContent: 'agent test {}',
      irContent: '{}',
      sourceHash: 'abc123',
      createdBy: 'user-1',
    });

    expect(version).toBeDefined();
    expect(version.version).toBe('1.0.0');
    expect(version.status).toBe('draft');
    expect(version.id ?? version._id).toBeDefined();
  });

  it('finds a version by agentId and version string', async () => {
    await AgentVersion.create(makeVersion({ agentId: 'agent-find', version: '2.0.0' }));

    const result = await findAgentVersion('agent-find', '2.0.0');

    expect(result).not.toBeNull();
    expect(result.version).toBe('2.0.0');
  });

  it('returns null when version does not exist', async () => {
    const result = await findAgentVersion('agent-missing', '99.0.0');
    expect(result).toBeNull();
  });

  it('lists versions with pagination, sorted by createdAt desc', async () => {
    for (let i = 1; i <= 5; i++) {
      await AgentVersion.create(
        makeVersion({
          agentId: 'agent-list',
          version: `${i}.0.0`,
        }),
      );
    }

    const page1 = await listAgentVersions('agent-list', { skip: 0, take: 3 });
    expect(page1).toHaveLength(3);

    const page2 = await listAgentVersions('agent-list', { skip: 3, take: 3 });
    expect(page2).toHaveLength(2);
  });

  it('counts versions for an agent', async () => {
    await AgentVersion.create(makeVersion({ agentId: 'agent-count', version: '1.0.0' }));
    await AgentVersion.create(makeVersion({ agentId: 'agent-count', version: '2.0.0' }));

    const count = await countAgentVersions('agent-count');
    expect(count).toBe(2);
  });

  it('finds the latest version by createdAt', async () => {
    await AgentVersion.create(makeVersion({ agentId: 'agent-latest', version: '1.0.0' }));
    await new Promise((r) => setTimeout(r, 20));
    await AgentVersion.create(makeVersion({ agentId: 'agent-latest', version: '2.0.0' }));

    const latest = await findLatestAgentVersion('agent-latest');

    expect(latest).not.toBeNull();
    expect(latest.version).toBe('2.0.0');
  });

  it('returns null for latest version when no versions exist', async () => {
    const result = await findLatestAgentVersion('nonexistent-agent');
    expect(result).toBeNull();
  });

  it('gets all version numbers for an agent', async () => {
    await AgentVersion.create(makeVersion({ agentId: 'agent-nums', version: '1.0.0' }));
    await AgentVersion.create(makeVersion({ agentId: 'agent-nums', version: '1.1.0' }));
    await AgentVersion.create(makeVersion({ agentId: 'agent-nums', version: '2.0.0' }));

    const versions = await getAllAgentVersionNumbers('agent-nums');

    expect(versions).toHaveLength(3);
    expect(versions).toContain('1.0.0');
    expect(versions).toContain('1.1.0');
    expect(versions).toContain('2.0.0');
  });
});

// #############################################################################
// project-repo: promoteAgentVersion
// #############################################################################

describe('project-repo: promoteAgentVersion', () => {
  it('promotes a version from draft to testing', async () => {
    const ver = await AgentVersion.create(
      makeVersion({ agentId: 'agent-promo', version: '1.0.0', status: 'draft' }),
    );

    const result = await promoteAgentVersion({
      id: ver._id,
      currentStatus: 'draft',
      newStatus: 'testing',
      promotedBy: 'user-1',
    });

    expect(result.count).toBe(1);

    const updated = await AgentVersion.findById(ver._id).lean();
    expect(updated!.status).toBe('testing');
    expect(updated!.promotedAt).toBeDefined();
    expect(updated!.promotedBy).toBe('user-1');
  });

  it('does not promote if current status does not match', async () => {
    const ver = await AgentVersion.create(
      makeVersion({ agentId: 'agent-promo2', version: '1.0.0', status: 'draft' }),
    );

    const result = await promoteAgentVersion({
      id: ver._id,
      currentStatus: 'testing',
      newStatus: 'active',
      promotedBy: 'user-1',
    });

    expect(result.count).toBe(0);

    const unchanged = await AgentVersion.findById(ver._id).lean();
    expect(unchanged!.status).toBe('draft');
  });
});

// #############################################################################
// project-repo: updateProjectAgentActiveVersions
// #############################################################################

describe('project-repo: updateProjectAgentActiveVersions', () => {
  it('sets activeVersions on the agent', async () => {
    const project = await Project.create(makeProject());
    const agent = await ProjectAgent.create(makeAgent({ projectId: project._id }));

    await updateProjectAgentActiveVersions(
      agent._id,
      { dev: '1.0.0', prod: '0.9.0' },
      'tenant-1',
      project._id,
    );

    const updated = await ProjectAgent.findById(agent._id).lean();
    expect((updated as any).activeVersions).toEqual({ dev: '1.0.0', prod: '0.9.0' });
  });

  it('returns null when project scope does not match', async () => {
    const project = await Project.create(makeProject());
    const agent = await ProjectAgent.create(makeAgent({ projectId: project._id }));

    const result = await updateProjectAgentActiveVersions(
      agent._id,
      { dev: '1.0.0' },
      'tenant-1',
      'other-project',
    );

    expect(result).toBeNull();
  });
});

// #############################################################################
// project-repo: tenant isolation on version operations
// #############################################################################

describe('project-repo: tenant isolation on version operations', () => {
  it('promoteAgentVersion returns count 0 for wrong tenant', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-A' }));
    const agent = await ProjectAgent.create(makeAgent({ projectId: project._id }));
    const ver = await AgentVersion.create(
      makeVersion({ agentId: agent._id, version: '1.0.0', status: 'draft' }),
    );

    const result = await promoteAgentVersion({
      id: ver._id,
      currentStatus: 'draft',
      newStatus: 'testing',
      promotedBy: 'user-1',
      tenantId: 'tenant-B',
    });

    expect(result.count).toBe(0);

    // Verify original is unchanged
    const unchanged = await AgentVersion.findById(ver._id).lean();
    expect(unchanged!.status).toBe('draft');
  });

  it('promoteAgentVersion succeeds for correct tenant', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-promote' }));
    const agent = await ProjectAgent.create(
      makeAgent({ projectId: project._id, tenantId: 'tenant-promote' }),
    );
    const ver = await AgentVersion.create(
      makeVersion({ agentId: agent._id, version: '1.0.0', status: 'draft' }),
    );

    const result = await promoteAgentVersion({
      id: ver._id,
      currentStatus: 'draft',
      newStatus: 'testing',
      promotedBy: 'user-1',
      tenantId: 'tenant-promote',
    });

    expect(result.count).toBe(1);
  });

  it('updateProjectAgentActiveVersions returns null for wrong tenant', async () => {
    const project = await Project.create(makeProject({ tenantId: 'tenant-A' }));
    const agent = await ProjectAgent.create(makeAgent({ projectId: project._id }));

    const result = await updateProjectAgentActiveVersions(
      agent._id,
      { dev: '1.0.0' },
      'tenant-B',
      project._id,
    );

    expect(result).toBeNull();
  });
});

// #############################################################################
// project-repo: AgentModelConfig
// #############################################################################

describe('project-repo: AgentModelConfig', () => {
  async function createModelConfigProject(projectId: string, tenantId: string) {
    await Project.create(
      makeProject({
        _id: projectId,
        tenantId,
        slug: `${projectId}-${tenantId}`,
      }),
    );
  }

  it('findAgentModelConfig returns null when not found', async () => {
    const result = await findAgentModelConfig('proj-x', 'agent-x');
    expect(result).toBeNull();
  });

  it('upsertAgentModelConfig creates and returns config', async () => {
    await createModelConfigProject('proj-mc', 'tenant-mc');

    const result = await upsertAgentModelConfig({
      tenantId: 'tenant-mc',
      projectId: 'proj-mc',
      agentName: 'mc_agent',
      defaultModel: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 4096,
    });

    expect(result).toBeDefined();
    expect(result.defaultModel).toBe('gpt-4o');
    expect(result.temperature).toBe(0.7);
  });

  it('upsertAgentModelConfig updates existing config', async () => {
    await createModelConfigProject('proj-mc2', 'tenant-mc2');

    await upsertAgentModelConfig({
      tenantId: 'tenant-mc2',
      projectId: 'proj-mc2',
      agentName: 'mc_agent2',
      defaultModel: 'gpt-4o',
    });

    const updated = await upsertAgentModelConfig({
      tenantId: 'tenant-mc2',
      projectId: 'proj-mc2',
      agentName: 'mc_agent2',
      defaultModel: 'claude-3-opus',
      temperature: 0.5,
    });

    expect(updated.defaultModel).toBe('claude-3-opus');
    expect(updated.temperature).toBe(0.5);

    const count = await AgentModelConfig.countDocuments({
      projectId: 'proj-mc2',
      tenantId: 'tenant-mc2',
      agentName: 'mc_agent2',
    });
    expect(count).toBe(1);
  });

  it('upsertAgentModelConfig preserves existing fields when a partial update omits them', async () => {
    await createModelConfigProject('proj-mc3', 'tenant-mc3');

    await upsertAgentModelConfig({
      tenantId: 'tenant-mc3',
      projectId: 'proj-mc3',
      agentName: 'mc_agent3',
      defaultModel: 'claude-sonnet-4-6',
      temperature: 0.4,
      maxTokens: 4096,
      useStreaming: true,
    });

    const updated = await upsertAgentModelConfig({
      tenantId: 'tenant-mc3',
      projectId: 'proj-mc3',
      agentName: 'mc_agent3',
      hyperParameters: { top_p: 0.9 },
    });

    expect(updated.defaultModel).toBe('claude-sonnet-4-6');
    expect(updated.temperature).toBe(0.4);
    expect(updated.maxTokens).toBe(4096);
    expect(updated.useStreaming).toBe(true);
    expect(updated.hyperParameters).toEqual({ top_p: 0.9 });
  });

  it('findAgentModelConfig returns existing config', async () => {
    await createModelConfigProject('proj-find-mc', 'tenant-find-mc');

    await AgentModelConfig.create({
      tenantId: 'tenant-find-mc',
      projectId: 'proj-find-mc',
      agentName: 'find_agent',
      defaultModel: 'gpt-4o-mini',
    });

    const result = await findAgentModelConfig('proj-find-mc', 'find_agent', 'tenant-find-mc');

    expect(result).not.toBeNull();
    expect(result.defaultModel).toBe('gpt-4o-mini');
  });
});

// #############################################################################
// deployment-repo: findActiveDeployment
// #############################################################################

describe('deployment-repo: findActiveDeployment', () => {
  it('finds the most recent active deployment for project and tenant', async () => {
    await Deployment.create(makeDeployment({ projectId: 'proj-d1', tenantId: 'tenant-d1' }));

    const result = await findActiveDeployment('proj-d1', 'tenant-d1');

    expect(result).not.toBeNull();
    expect(result.status).toBe('active');
    expect(result.id ?? result._id).toBeDefined();
  });

  it('filters by environment when provided', async () => {
    await Deployment.create(
      makeDeployment({
        projectId: 'proj-env',
        tenantId: 'tenant-env',
        environment: 'staging',
      }),
    );
    await Deployment.create(
      makeDeployment({
        projectId: 'proj-env',
        tenantId: 'tenant-env',
        environment: 'production',
      }),
    );

    const staging = await findActiveDeployment('proj-env', 'tenant-env', 'staging');
    expect(staging).not.toBeNull();
    expect(staging.environment).toBe('staging');
  });

  it('returns null when no active deployment exists', async () => {
    const result = await findActiveDeployment('nonexistent', 'nonexistent');
    expect(result).toBeNull();
  });
});

// #############################################################################
// deployment-repo: findDeploymentById
// #############################################################################

describe('deployment-repo: findDeploymentById', () => {
  it('finds deployment by id, projectId, and tenantId', async () => {
    const dep = await Deployment.create(
      makeDeployment({ projectId: 'proj-did', tenantId: 'tenant-did' }),
    );

    const result = await findDeploymentById(dep._id, 'proj-did', 'tenant-did');

    expect(result).not.toBeNull();
    expect(result.id ?? result._id).toBe(dep._id);
  });

  it('returns null when projectId does not match', async () => {
    const dep = await Deployment.create(
      makeDeployment({ projectId: 'proj-match', tenantId: 'tenant-match' }),
    );

    const result = await findDeploymentById(dep._id, 'wrong-project', 'tenant-match');
    expect(result).toBeNull();
  });
});

// #############################################################################
// deployment-repo: findDeploymentBySlug
// #############################################################################

describe('deployment-repo: findDeploymentBySlug', () => {
  it('finds deployment by endpointSlug', async () => {
    await Deployment.create(makeDeployment({ endpointSlug: 'my-unique-slug' }));

    const result = await findDeploymentBySlug('my-unique-slug');

    expect(result).not.toBeNull();
    expect(result.endpointSlug).toBe('my-unique-slug');
  });

  it('returns null when slug does not exist', async () => {
    const result = await findDeploymentBySlug('nonexistent-slug');
    expect(result).toBeNull();
  });
});

// #############################################################################
// deployment-repo: listDeployments
// #############################################################################

describe('deployment-repo: listDeployments', () => {
  it('lists deployments for project and tenant', async () => {
    await Deployment.create(makeDeployment({ projectId: 'proj-list', tenantId: 'tenant-list' }));
    await Deployment.create(
      makeDeployment({
        projectId: 'proj-list',
        tenantId: 'tenant-list',
        status: 'retired',
        retiredAt: new Date(),
      }),
    );
    await Deployment.create(makeDeployment({ projectId: 'proj-other', tenantId: 'tenant-list' }));

    const result = await listDeployments('proj-list', 'tenant-list');

    expect(result).toHaveLength(2);
  });

  it('applies environment and status filters', async () => {
    await Deployment.create(
      makeDeployment({
        projectId: 'proj-filter',
        tenantId: 'tenant-filter',
        environment: 'staging',
        status: 'active',
      }),
    );
    await Deployment.create(
      makeDeployment({
        projectId: 'proj-filter',
        tenantId: 'tenant-filter',
        environment: 'production',
        status: 'active',
      }),
    );

    const result = await listDeployments('proj-filter', 'tenant-filter', {
      environment: 'staging',
    });
    expect(result).toHaveLength(1);
    expect(result[0].environment).toBe('staging');
  });
});

// #############################################################################
// deployment-repo: createDeployment
// #############################################################################

describe('deployment-repo: createDeployment', () => {
  it('creates a deployment and returns it with id', async () => {
    const result = await createDeployment({
      projectId: 'proj-create',
      tenantId: 'tenant-create',
      environment: 'dev',
      agentVersionManifest: { agent_a: '1.0.0' },
      entryAgentName: 'agent_a',
      endpointSlug: 'create-test-slug',
      createdBy: 'user-1',
    });

    expect(result).toBeDefined();
    expect(result.id ?? result._id).toBeDefined();
    expect(result.status).toBe('active');
    expect(result.agentVersionManifest).toEqual({ agent_a: '1.0.0' });
  });

  it('sets optional fields to null when not provided', async () => {
    const result = await createDeployment({
      projectId: 'proj-optional',
      tenantId: 'tenant-optional',
      environment: 'dev',
      agentVersionManifest: {},
      entryAgentName: 'main_agent',
      endpointSlug: 'optional-slug',
      createdBy: 'user-1',
    });

    expect(result.label).toBeNull();
    expect(result.description).toBeNull();
    expect(result.compilationHash).toBeNull();
    expect(result.previousDeploymentId).toBeNull();
  });
});

// #############################################################################
// deployment-repo: updateDeploymentStatus
// #############################################################################

describe('deployment-repo: updateDeploymentStatus', () => {
  it('updates deployment status', async () => {
    const dep = await Deployment.create(makeDeployment());

    const result = await updateDeploymentStatus(dep._id, 'tenant-1', { status: 'draining' });

    expect(result).not.toBeNull();
    expect(result.status).toBe('draining');
  });

  it('returns null when deployment does not exist', async () => {
    const result = await updateDeploymentStatus('nonexistent', 'tenant-1', { status: 'retired' });
    expect(result).toBeNull();
  });
});

// #############################################################################
// deployment-repo: countLinkedChannels
// #############################################################################

describe('deployment-repo: countLinkedChannels', () => {
  it('counts SDK channels linked to a deployment', async () => {
    const dep = await Deployment.create(makeDeployment({ tenantId: 'tenant-ch' }));

    await SDKChannel.create({
      tenantId: 'tenant-ch',
      projectId: 'proj-1',
      deploymentId: dep._id,
      name: 'Channel 1',
      channelType: 'web',
      publicApiKeyId: 'key-1',
    });
    await SDKChannel.create({
      tenantId: 'tenant-ch',
      projectId: 'proj-1',
      deploymentId: dep._id,
      name: 'Channel 2',
      channelType: 'sdk',
      publicApiKeyId: 'key-2',
    });

    const count = await countLinkedChannels(dep._id, 'tenant-ch');
    expect(count).toBe(2);
  });

  it('returns 0 when no channels are linked', async () => {
    const count = await countLinkedChannels('nonexistent-dep', 'tenant-1');
    expect(count).toBe(0);
  });
});
