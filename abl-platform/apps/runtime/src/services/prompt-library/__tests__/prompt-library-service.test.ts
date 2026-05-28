/**
 * INT-1, INT-4, INT-6: Prompt Library Service Integration Tests
 *
 * Uses MongoMemoryServer for real MongoDB operations.
 * Tests: concurrent promote atomicity, archived version pinning,
 * and boundary validation at the service level.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ProjectAgent,
  ProjectRuntimeConfig,
  PromptLibraryItem,
  PromptLibraryVersion,
} from '@agent-platform/database/models';

const mockRefreshPersistedRuntimeProjectAgentDraftMetadata = vi.fn();

vi.mock('../../session/project-agent-draft-metadata.js', () => ({
  refreshPersistedRuntimeProjectAgentDraftMetadata: (...args: unknown[]) =>
    mockRefreshPersistedRuntimeProjectAgentDraftMetadata(...args),
}));

import { PromptLibraryService } from '../prompt-library-service.js';

// ---------------------------------------------------------------------------
// MongoMemoryServer lifecycle
// ---------------------------------------------------------------------------

let mongod: MongoMemoryServer;
let service: PromptLibraryService;

const TENANT_ID = 'test-tenant-001';
const PROJECT_ID = 'test-project-001';
const USER_ID = 'test-user-001';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
  service = new PromptLibraryService();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRefreshPersistedRuntimeProjectAgentDraftMetadata.mockResolvedValue(new Map());
});

afterEach(async () => {
  await ProjectAgent.deleteMany({});
  await ProjectRuntimeConfig.deleteMany({});
  await PromptLibraryItem.deleteMany({});
  await PromptLibraryVersion.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestPromptWithDraftVersions(count: number) {
  const item = await service.createPrompt({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: `test-prompt-${Date.now()}`,
    createdBy: USER_ID,
  });

  const versions = [];
  for (let i = 0; i < count; i++) {
    const v = await service.createVersion(String(item._id), {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      template: `Template version ${i}`,
      variables: ['var1'],
      createdBy: USER_ID,
    });
    versions.push(v);
  }

  return { item, versions };
}

async function createDraftAgentReference(input: {
  name: string;
  promptId: string;
  versionId: string;
}) {
  await ProjectAgent.create({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: input.name,
    agentPath: `${PROJECT_ID}/${input.name}`,
    description: null,
    dslContent: `AGENT: ${input.name}\nGOAL: "Reference prompt"\n`,
    systemPromptLibraryRef: {
      promptId: input.promptId,
      versionId: input.versionId,
    },
  });
}

async function upsertRuntimeConfigPromptReference(input: { promptId: string; versionId: string }) {
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
        promptId: input.promptId,
        versionId: input.versionId,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// INT-1: Concurrent Promote
// ---------------------------------------------------------------------------

describe('INT-1: concurrent promote atomicity', () => {
  test('exactly one of two concurrent promotes of the same version succeeds', async () => {
    // Test the atomic guarantee: two concurrent requests to promote the same draft
    // version — only one can win because step 1 is a filtered findOneAndUpdate
    // on {_id: versionId, status: 'draft'}. The loser finds status already 'active'
    // and receives PROMPT_LIBRARY_CONCURRENT_PROMOTE (409).
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    const results = await Promise.allSettled([
      service.promoteVersion(promptId, versionId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
      }),
      service.promoteVersion(promptId, versionId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one wins, one gets CONCURRENT_PROMOTE
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectedError?.code ?? rejectedError?.message).toMatch(
      /PROMPT_LIBRARY_CONCURRENT_PROMOTE/,
    );

    // Exactly one version is active
    const activeVersions = await PromptLibraryVersion.find({
      promptId,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      status: 'active',
    }).lean();

    expect(activeVersions.length).toBe(1);
  });

  test('promoting an already-active version is idempotent', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    // Promote once (should succeed)
    await service.promoteVersion(promptId, versionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    });

    // Promote again (already active) — should return the same active version
    const result = await service.promoteVersion(promptId, versionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    });

    expect(result.version.status).toBe('active');
    expect(String(result.version._id)).toBe(versionId);
    expect(result.previousActiveVersionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INT-4: Archived Version Pinning
// ---------------------------------------------------------------------------

describe('INT-4: archived version pinning', () => {
  test('archiveVersion changes status to archived', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    const archived = await service.archiveVersion(promptId, versionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(archived.status).toBe('archived');

    // Verify via getVersion
    const fetched = await service.getVersion(promptId, versionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(fetched?.status).toBe('archived');
  });

  test('archiving an already-archived version throws 404', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    await service.archiveVersion(promptId, versionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    await expect(
      service.archiveVersion(promptId, versionId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toThrow(/not found or already archived/);
  });
});

// ---------------------------------------------------------------------------
// INT-6: Boundary Conditions
// ---------------------------------------------------------------------------

describe('INT-6: boundary conditions', () => {
  test('rejects template exceeding 32KB', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `boundary-test-${Date.now()}`,
      createdBy: USER_ID,
    });

    const bigTemplate = 'x'.repeat(32769);

    await expect(
      service.createVersion(String(item._id), {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        template: bigTemplate,
        createdBy: USER_ID,
      }),
    ).rejects.toThrow(/Template exceeds 32KB limit/);
  });

  test('rejects more than 20 variables', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `boundary-vars-${Date.now()}`,
      createdBy: USER_ID,
    });

    const tooManyVars = Array.from({ length: 21 }, (_, i) => `var_${i}`);

    await expect(
      service.createVersion(String(item._id), {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        template: 'Hello',
        variables: tooManyVars,
        createdBy: USER_ID,
      }),
    ).rejects.toThrow(/Variables exceed limit/);
  });

  test('accepts template at exactly 32768 bytes', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `boundary-exact-${Date.now()}`,
      createdBy: USER_ID,
    });

    const template = 'x'.repeat(32768);

    const version = await service.createVersion(String(item._id), {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      template,
      createdBy: USER_ID,
    });

    expect(version.template).toBe(template);
  });
});

// ---------------------------------------------------------------------------
// Additional: CRUD operations
// ---------------------------------------------------------------------------

describe('CRUD operations', () => {
  test('createPrompt with initialVersion creates both', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `crud-test-${Date.now()}`,
      createdBy: USER_ID,
      initialVersion: {
        template: 'Hello {{name}}',
        variables: ['name'],
        description: 'Initial version',
      },
    });

    expect(item.name).toMatch(/^crud-test-/);

    const versions = await service.listVersions(String(item._id), {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(versions.length).toBe(1);
    expect(versions[0].template).toBe('Hello {{name}}');
    expect(versions[0].versionNumber).toBe(1);
  });

  test('updatePrompt changes name', async () => {
    const item = await service.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: `update-test-${Date.now()}`,
      createdBy: USER_ID,
    });

    const updated = await service.updatePrompt(
      String(item._id),
      { name: 'new-name' },
      { tenantId: TENANT_ID, projectId: PROJECT_ID },
    );

    expect(updated.name).toBe('new-name');
  });

  test('deletePrompt removes item and versions', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(2);
    const promptId = String(item._id);

    await service.deletePrompt(promptId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    const remainingItems = await PromptLibraryItem.countDocuments({ _id: promptId });
    const remainingVersions = await PromptLibraryVersion.countDocuments({ promptId });

    expect(remainingItems).toBe(0);
    expect(remainingVersions).toBe(0);
  });

  test('listPrompts returns paginated results', async () => {
    // Create 3 prompts
    for (let i = 0; i < 3; i++) {
      await service.createPrompt({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        name: `list-test-${i}-${Date.now()}`,
        createdBy: USER_ID,
      });
    }

    const result = await service.listPrompts({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      limit: 2,
      offset: 0,
    });

    expect(result.items.length).toBe(2);
    expect(result.total).toBe(3);
  });
});

describe('working-copy reference safety', () => {
  test('archiveVersion rejects when a project agent draft pins the target version', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    await createDraftAgentReference({
      name: 'booking_agent',
      promptId,
      versionId,
    });

    await expect(
      service.archiveVersion(promptId, versionId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({
      code: 'PROMPT_LIBRARY_VERSION_IN_USE',
      statusCode: 409,
    });
  });

  test('promoteVersion rejects when archiving the previous active version would break a draft agent', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(2);
    const promptId = String(item._id);
    const firstVersionId = String(versions[0]._id);
    const secondVersionId = String(versions[1]._id);

    await service.promoteVersion(promptId, firstVersionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    });
    await createDraftAgentReference({
      name: 'booking_agent',
      promptId,
      versionId: firstVersionId,
    });

    await expect(
      service.promoteVersion(promptId, secondVersionId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({
      code: 'PROMPT_LIBRARY_VERSION_IN_USE',
      statusCode: 409,
    });

    const firstVersion = await service.getVersion(promptId, firstVersionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });
    const secondVersion = await service.getVersion(promptId, secondVersionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(firstVersion?.status).toBe('active');
    expect(secondVersion?.status).toBe('draft');
  });

  test('deletePrompt rejects when a project agent draft references the prompt', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    await createDraftAgentReference({
      name: 'support_agent',
      promptId,
      versionId,
    });

    await expect(
      service.deletePrompt(promptId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({
      code: 'PROMPT_LIBRARY_HAS_REFERENCES',
      statusCode: 409,
    });
  });

  test('archiveVersion rejects when runtime config pins the target prompt version', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    await upsertRuntimeConfigPromptReference({ promptId, versionId });

    await expect(
      service.archiveVersion(promptId, versionId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({
      code: 'PROMPT_LIBRARY_VERSION_IN_USE',
      statusCode: 409,
    });
  });

  test('deletePrompt rejects when runtime config references the prompt', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    await upsertRuntimeConfigPromptReference({ promptId, versionId });

    await expect(
      service.deletePrompt(promptId, {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({
      code: 'PROMPT_LIBRARY_HAS_REFERENCES',
      statusCode: 409,
    });
  });

  test('refreshes persisted runtime draft metadata after prompt lifecycle mutations', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    await service.archiveVersion(promptId, versionId, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });

    expect(mockRefreshPersistedRuntimeProjectAgentDraftMetadata).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      diagnosticSource: 'runtime-prompt-library',
    });
  });

  test('refreshes persisted runtime draft metadata after draft prompt content changes', async () => {
    const { item, versions } = await createTestPromptWithDraftVersions(1);
    const promptId = String(item._id);
    const versionId = String(versions[0]._id);

    await service.updateVersion(
      promptId,
      versionId,
      {
        template: 'Updated prompt template for {{topic}}',
        variables: ['topic'],
      },
      {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
      },
    );

    expect(mockRefreshPersistedRuntimeProjectAgentDraftMetadata).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      diagnosticSource: 'runtime-prompt-library',
    });
  });
});
