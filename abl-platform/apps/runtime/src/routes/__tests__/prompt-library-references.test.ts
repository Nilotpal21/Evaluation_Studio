/**
 * INT-11: Prompt Library References Tests
 *
 * Tests the getReferences() service method that searches AgentVersion
 * irContent for prompt library references.
 * Uses MongoMemoryServer for real MongoDB queries.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AgentVersion,
  ProjectAgent,
  ProjectRuntimeConfig,
  PromptLibraryItem,
} from '@agent-platform/database/models';
import { PromptLibraryService } from '../../services/prompt-library/prompt-library-service.js';

let mongod: MongoMemoryServer;
let service: PromptLibraryService;

const TENANT_ID = 'test-tenant-refs';
const PROJECT_ID = 'test-project-refs';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
  service = new PromptLibraryService();
});

afterEach(async () => {
  await AgentVersion.deleteMany({});
  await ProjectAgent.deleteMany({});
  await ProjectRuntimeConfig.deleteMany({});
  await PromptLibraryItem.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('INT-11: getReferences', () => {
  async function seedProjectAgent(agentId: string, name = agentId) {
    await ProjectAgent.create({
      _id: agentId,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name,
      agentPath: `${PROJECT_ID}/${name}`,
      dslContent: 'AGENT: test',
    });
  }

  test('finds agent versions referencing a prompt', async () => {
    const promptId = 'pl_test-prompt-id';

    // Create an AgentVersion with irContent containing a libraryRef
    const irContent = JSON.stringify({
      identity: {
        system_prompt: {
          libraryRef: {
            promptId: promptId,
            versionId: 'plv_test-version-id',
            resolvedHash: 'abc123def456',
          },
        },
      },
    });

    const agentId = 'test-agent';
    await seedProjectAgent(agentId, 'TestAgent');
    await AgentVersion.create({
      agentId,
      version: '1.0.0',
      status: 'active',
      dslContent: 'AGENT: test',
      irContent,
      sourceHash: 'hash123',
      createdBy: 'user-001',
    });

    const refs = await service.getReferences(promptId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(refs.count).toBe(1);
    expect(refs.agents).toHaveLength(1);
    expect(refs.agents[0].resolvedHash).toBe('abc123def456');
    expect(refs.agents[0].versionId).toBeDefined();
  });

  test('returns empty result when no references exist', async () => {
    const refs = await service.getReferences('pl_nonexistent', {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(refs.count).toBe(0);
    expect(refs.agents).toHaveLength(0);
  });

  test('ignores agent versions with invalid irContent JSON', async () => {
    // Create an AgentVersion with text that matches the regex but is not valid JSON
    await AgentVersion.create({
      agentId: 'broken-agent',
      version: '1.0.0',
      status: 'active',
      dslContent: 'AGENT: broken',
      irContent: 'not-json-but-contains-pl_test-ref-id',
      sourceHash: 'hash456',
      createdBy: 'user-001',
    });
    await seedProjectAgent('broken-agent', 'BrokenAgent');

    const refs = await service.getReferences('pl_test-ref-id', {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    // Should not crash, just return empty
    expect(refs.count).toBe(0);
    expect(refs.agents).toHaveLength(0);
  });

  test('filters out agent versions where promptId does not match after parsing', async () => {
    const targetPromptId = 'pl_target';
    const otherPromptId = 'pl_target_extended'; // Contains targetPromptId as substring

    // Create version with the other prompt that matches regex but not exact
    const irContent = JSON.stringify({
      identity: {
        system_prompt: {
          libraryRef: {
            promptId: otherPromptId,
            versionId: 'plv_other',
            resolvedHash: 'hash789',
          },
        },
      },
    });

    const agentId = 'other-agent';
    await seedProjectAgent(agentId, 'OtherAgent');
    await AgentVersion.create({
      agentId,
      version: '1.0.0',
      status: 'active',
      dslContent: 'AGENT: other',
      irContent,
      sourceHash: 'hash789',
      createdBy: 'user-001',
    });

    const refs = await service.getReferences(targetPromptId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    // Regex matches substring, but exact comparison in app code filters it out
    expect(refs.count).toBe(0);
  });

  test('includes working-copy project agent drafts that reference the prompt', async () => {
    const promptId = 'pl_draft_prompt';
    const versionId = 'plv_draft_version';

    await seedProjectAgent('draft-agent', 'DraftAgent');
    await ProjectAgent.updateOne(
      { _id: 'draft-agent', tenantId: TENANT_ID, projectId: PROJECT_ID },
      {
        $set: {
          systemPromptLibraryRef: {
            promptId,
            versionId,
            resolvedHash: 'draft-hash-1',
          },
        },
      },
    );

    const refs = await service.getReferences(promptId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(refs.count).toBe(1);
    expect(refs.agents).toHaveLength(0);
    expect(refs.draftAgents).toEqual([
      {
        agentName: 'DraftAgent',
        versionId,
        resolvedHash: 'draft-hash-1',
      },
    ]);
  });

  test('includes runtime-config prompt refs that reference the prompt', async () => {
    const promptId = 'pl_runtime_prompt';
    const versionId = 'plv_runtime_version';

    await ProjectRuntimeConfig.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      filler: {
        enabled: true,
        chatEnabled: true,
        voiceEnabled: true,
        chatDelayMs: 1200,
        voiceDelayMs: 500,
        cooldownMs: 3000,
        maxPerTurn: 5,
        piggybackEnabled: true,
        pipelineGenerationEnabled: true,
        modelSource: 'system',
        promptRef: {
          promptId,
          versionId,
        },
      },
    });

    const refs = await service.getReferences(promptId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(refs.count).toBe(1);
    expect(refs.runtimeConfigRefs).toEqual([
      {
        section: 'filler.promptRef',
        versionId,
      },
    ]);
  });
});
