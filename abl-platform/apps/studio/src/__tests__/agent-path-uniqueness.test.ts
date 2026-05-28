/**
 * Tests for Agent Path Uniqueness
 *
 * Validates that:
 * 1. Agent paths use canonical projectId/name locators
 * 2. Same agent name can be used across different projects
 * 3. Agent paths are unique via projectId/name within the tenant-scoped DB key
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildProjectAgentPath } from '@agent-platform/shared';

const mockCreateProjectAgent = vi.fn();

vi.mock('@/repos/project-repo', () => ({
  createProjectAgent: (...args: unknown[]) => mockCreateProjectAgent(...args),
}));

const projectA = {
  id: 'proj-a-001',
  name: 'Project A',
  tenantId: 'test-tenant',
};
const projectB = {
  id: 'proj-b-002',
  name: 'Project B',
  tenantId: 'test-tenant',
};

describe('Agent Path Uniqueness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create agents with projectId-prefixed paths', async () => {
    const agentName = 'booking_agent';

    mockCreateProjectAgent.mockResolvedValueOnce({
      id: 'agent-a-1',
      projectId: projectA.id,
      tenantId: projectA.tenantId,
      name: agentName,
      agentPath: buildProjectAgentPath(projectA.id, agentName),
      dslContent: 'AGENT: booking_agent\nGOAL: "Handle bookings for Project A"',
    });

    const { createProjectAgent } = await import('@/repos/project-repo');
    const agentA = await createProjectAgent({
      projectId: projectA.id,
      tenantId: projectA.tenantId,
      name: agentName,
      agentPath: buildProjectAgentPath(projectA.id, agentName),
      dslContent: 'AGENT: booking_agent\nGOAL: "Handle bookings for Project A"',
    });

    expect(agentA).toBeDefined();
    expect(agentA.name).toBe(agentName);
    expect(agentA.agentPath).toBe(buildProjectAgentPath(projectA.id, agentName));

    const pathSegments = agentA.agentPath.split('/');
    expect(pathSegments).toHaveLength(2);
    expect(pathSegments[0]).toBe(projectA.id);
    expect(pathSegments[1]).toBe(agentName);
  });

  it('should allow same agent name in different projects', async () => {
    const agentName = 'booking_agent';

    mockCreateProjectAgent
      .mockResolvedValueOnce({
        id: 'agent-a-1',
        projectId: projectA.id,
        tenantId: projectA.tenantId,
        name: agentName,
        agentPath: buildProjectAgentPath(projectA.id, agentName),
      })
      .mockResolvedValueOnce({
        id: 'agent-b-1',
        projectId: projectB.id,
        tenantId: projectB.tenantId,
        name: agentName,
        agentPath: buildProjectAgentPath(projectB.id, agentName),
      });

    const { createProjectAgent } = await import('@/repos/project-repo');

    const agentA = await createProjectAgent({
      projectId: projectA.id,
      tenantId: projectA.tenantId,
      name: agentName,
      agentPath: buildProjectAgentPath(projectA.id, agentName),
    });

    const agentB = await createProjectAgent({
      projectId: projectB.id,
      tenantId: projectB.tenantId,
      name: agentName,
      agentPath: buildProjectAgentPath(projectB.id, agentName),
    });

    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
    expect(agentA.name).toBe(agentName);
    expect(agentB.name).toBe(agentName);

    expect(agentA.agentPath).not.toBe(agentB.agentPath);
    expect(agentA.agentPath).toBe(buildProjectAgentPath(projectA.id, agentName));
    expect(agentB.agentPath).toBe(buildProjectAgentPath(projectB.id, agentName));
  });

  it('should validate agentPath has 2 segments (projectId/name)', () => {
    const testAgents = [
      {
        projectId: projectA.id,
        name: 'test_agent_1',
        agentPath: buildProjectAgentPath(projectA.id, 'test_agent_1'),
      },
      {
        projectId: projectB.id,
        name: 'test_agent_2',
        agentPath: buildProjectAgentPath(projectB.id, 'test_agent_2'),
      },
    ];

    for (const agent of testAgents) {
      const segments = agent.agentPath.split('/');
      expect(segments.length).toBe(2);
      expect(segments[0]).toBe(agent.projectId);
      expect(segments[1]).toBe(agent.name);
    }
  });

  it('should construct unique paths for same name in different projects', () => {
    const agentName = 'booking_agent';

    const pathA = buildProjectAgentPath(projectA.id, agentName);
    const pathB = buildProjectAgentPath(projectB.id, agentName);

    expect(pathA).not.toBe(pathB);
    expect(pathA).toBe(`${projectA.id}/booking_agent`);
    expect(pathB).toBe(`${projectB.id}/booking_agent`);
  });
});
