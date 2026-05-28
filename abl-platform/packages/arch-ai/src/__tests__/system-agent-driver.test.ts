import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Project, ProjectAgent } from '@agent-platform/database/models';

import { ArchSessionModel } from '../models/index.js';
import { runArchSystemAgentInProcess } from '../system-agent-driver.js';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function createProject(params: {
  tenantId: string;
  projectId: string;
  ownerId: string;
  name: string;
}): Promise<void> {
  await Project.create({
    _id: params.projectId,
    tenantId: params.tenantId,
    ownerId: params.ownerId,
    name: params.name,
    slug: params.projectId,
    description: null,
    kind: 'application',
  });
}

describe('runArchSystemAgentInProcess', () => {
  it('runs INTERVIEW -> BLUEPRINT -> BUILD -> CREATE and persists agents in the scoped project', async () => {
    const tenantId = 'tenant-driver-1';
    const userId = 'user-driver-1';
    const projectId = 'project-target-1';
    const otherProjectId = 'project-other-1';
    const events: Array<{ type?: string }> = [];

    await createProject({
      tenantId,
      projectId,
      ownerId: userId,
      name: 'Target Project',
    });
    await createProject({
      tenantId,
      projectId: otherProjectId,
      ownerId: userId,
      name: 'Other Project',
    });

    const outcome = await runArchSystemAgentInProcess(
      {
        tenantId,
        userId,
        permissions: ['project:write'],
        projectId,
      },
      {
        projectName: 'Support Operations',
        description:
          'Create a customer support operation with intake routing, billing help, and escalation.',
        channels: ['web', 'slack'],
        language: 'English',
      },
      {
        correlationId: 'system-agent-driver-test',
        emit: (event) => events.push(event as { type?: string }),
      },
    );

    expect(outcome.success).toBe(true);
    if (!outcome.success) {
      return;
    }

    expect(outcome.data.projectId).toBe(projectId);
    expect(outcome.data.agents.length).toBeGreaterThan(0);
    expect(outcome.data.topology.agents).toHaveLength(outcome.data.agents.length);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'activity',
        'tool_call',
        'build_agent_start',
        'build_agent_compiled',
        'tool_result',
        'done',
      ]),
    );

    const persistedAgents = await ProjectAgent.find({ tenantId, projectId }).lean();
    expect(persistedAgents).toHaveLength(outcome.data.agents.length);
    expect(persistedAgents.map((agent) => agent.name).sort()).toEqual(
      outcome.data.agents.map((agent) => agent.name).sort(),
    );
    expect(persistedAgents.every((agent) => agent.projectId === projectId)).toBe(true);
    expect(persistedAgents.every((agent) => agent.tenantId === tenantId)).toBe(true);
    expect(
      persistedAgents.every((agent) => /^(AGENT|SUPERVISOR):/m.test(agent.dslContent ?? '')),
    ).toBe(true);

    const crossProjectAgents = await ProjectAgent.find({
      tenantId,
      projectId: otherProjectId,
    }).lean();
    expect(crossProjectAgents).toHaveLength(0);

    const targetProject = await Project.findOne({ _id: projectId, tenantId }).lean();
    expect(targetProject?.entryAgentName).toBe(outcome.data.topology.entryPoint);

    const archivedSession = await ArchSessionModel.findOne({
      _id: outcome.sessionId,
      tenantId,
      userId,
    }).lean();
    expect(archivedSession?.state).toBe('ARCHIVED');
    expect(archivedSession?.metadata.projectId).toBe(projectId);
    expect(archivedSession?.metadata.phase).toBe('CREATE');
  }, 60_000);
});
