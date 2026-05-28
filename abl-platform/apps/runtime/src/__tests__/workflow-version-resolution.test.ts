/**
 * Workflow Version Resolution — Integration Tests
 *
 * Tests resolveDefaultVersion() behavior end-to-end against MongoMemoryServer
 * with real Workflow/WorkflowVersion documents.
 *
 * Scenarios:
 * 1. Returns latest active published version when one exists
 * 2. Falls back to draft when no active version
 * 3. Falls back to draft when all versions are inactive
 * 4. Explicit version param returns that specific version
 * 5. Returns 404-equivalent for non-existent version
 *
 * No vi.mock() — uses real Mongoose models.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import {
  WorkflowVersionService,
  resetWorkflowVersionService,
} from '../services/workflow-version-service.js';

// ─── Constants ────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-resolve-1';
const PROJECT_ID = 'proj-resolve-1';
const USER_ID = 'user-resolve-1';

// ─── Setup / Teardown ─────────────────────────────────────────────────────

let svc: WorkflowVersionService;

beforeAll(async () => {
  await setupTestMongo();
  svc = new WorkflowVersionService();
});

afterAll(async () => {
  await teardownTestMongo();
});

afterEach(async () => {
  await clearCollections();
  resetWorkflowVersionService();
  svc = new WorkflowVersionService();
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function seedWorkflow(name?: string) {
  const { Workflow } = await import('@agent-platform/database/models');
  const doc = await Workflow.create({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: name ?? `resolve-wf-${Date.now()}`,
    description: null,
    nodes: [
      {
        id: 'n1',
        nodeType: 'start',
        name: 'Start',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'n2',
        nodeType: 'end',
        name: 'End',
        position: { x: 200, y: 0 },
        config: {},
      },
    ],
    edges: [{ id: 'e1', source: 'n1', sourceHandle: 'default', target: 'n2' }],
    envVars: {},
    inputSchema: null,
    outputSchema: null,
    status: 'draft',
    createdBy: USER_ID,
  });
  return doc.toObject();
}

/**
 * Create a published version and optionally modify its draft first
 * so it doesn't get deduplicated.
 */
async function createUniquePublishedVersion(workflowId: string) {
  const { WorkflowVersion } = await import('@agent-platform/database/models');

  // Modify draft sourceHash to avoid dedup
  await WorkflowVersion.findOneAndUpdate(
    { workflowId, version: 'draft', tenantId: TENANT_ID },
    {
      $set: {
        sourceHash: `unique-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        'definition.nodes': [
          {
            id: `n-${Date.now()}`,
            nodeType: 'start',
            name: 'Modified',
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
      },
    },
  );

  return svc.createVersion({
    workflowId,
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    createdBy: USER_ID,
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('resolveDefaultVersion — integration with MongoMemoryServer', () => {
  // ─── 1. Returns latest active published version ───────────────────────

  it('returns the latest active published version when one exists', async () => {
    const wf = await seedWorkflow();

    // Create draft first
    await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

    // Create first published version and activate
    const v1 = await svc.createVersion({
      workflowId: wf._id,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      createdBy: USER_ID,
    });
    await svc.activate({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: wf._id,
      version: v1.version,
      activatedBy: USER_ID,
    });

    // Create second published version and activate
    const v2 = await createUniquePublishedVersion(wf._id);
    await svc.activate({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: wf._id,
      version: v2.version,
      activatedBy: USER_ID,
    });

    const resolved = await svc.resolveDefaultVersion(TENANT_ID, PROJECT_ID, wf._id);

    expect(resolved.resolution).toBe('published');
    // Should be the latest active (v2)
    expect(resolved.version.version).toBe(v2.version);
  });

  // ─── 2. Falls back to draft when no active version ────────────────────

  it('falls back to draft when no published version exists', async () => {
    const wf = await seedWorkflow();

    const resolved = await svc.resolveDefaultVersion(TENANT_ID, PROJECT_ID, wf._id);

    expect(resolved.resolution).toBe('draft-fallback');
    expect(resolved.version.version).toBe('draft');
    expect(resolved.version.workflowId).toBe(wf._id);
  });

  // ─── 3. Falls back to draft when all versions are inactive ────────────

  it('falls back to draft when all published versions are inactive', async () => {
    const wf = await seedWorkflow();
    await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

    // Create a published version (starts inactive)
    const v1 = await svc.createVersion({
      workflowId: wf._id,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      createdBy: USER_ID,
    });

    // v1 starts as 'inactive', so it should not be returned
    // Verify it's inactive
    const detail = await svc.getVersion(wf._id, v1.version, TENANT_ID, PROJECT_ID);
    expect((detail as Record<string, unknown>).state).toBe('inactive');

    // Resolve should fall back to draft
    const resolved = await svc.resolveDefaultVersion(TENANT_ID, PROJECT_ID, wf._id);

    expect(resolved.resolution).toBe('draft-fallback');
    expect(resolved.version.version).toBe('draft');
  });

  it('falls back to draft when published version is activated then deactivated', async () => {
    const wf = await seedWorkflow();
    await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

    const v1 = await svc.createVersion({
      workflowId: wf._id,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      createdBy: USER_ID,
    });

    // Activate then deactivate
    await svc.activate({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: wf._id,
      version: v1.version,
      activatedBy: USER_ID,
    });
    await svc.deactivate({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: wf._id,
      version: v1.version,
    });

    const resolved = await svc.resolveDefaultVersion(TENANT_ID, PROJECT_ID, wf._id);

    expect(resolved.resolution).toBe('draft-fallback');
    expect(resolved.version.version).toBe('draft');
  });

  // ─── 4. Explicit version returns that specific version ────────────────

  it('getVersion returns a specific version when it exists', async () => {
    const wf = await seedWorkflow();
    await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

    const v1 = await svc.createVersion({
      workflowId: wf._id,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      createdBy: USER_ID,
    });

    const specific = await svc.getVersion(wf._id, v1.version, TENANT_ID, PROJECT_ID);

    expect(specific).not.toBeNull();
    expect((specific as Record<string, unknown>).version).toBe(v1.version);
    expect((specific as Record<string, unknown>).workflowId).toBe(wf._id);
    expect((specific as Record<string, unknown>).definition).toBeDefined();
  });

  // ─── 5. Returns null for non-existent version (404 equivalent) ────────

  it('getVersion returns null for non-existent version', async () => {
    const wf = await seedWorkflow();

    const result = await svc.getVersion(wf._id, 'v99.99.99', TENANT_ID, PROJECT_ID);

    expect(result).toBeNull();
  });

  it('getVersion returns null for non-existent workflow', async () => {
    const result = await svc.getVersion('non-existent-wf-id', 'v0.1.0', TENANT_ID, PROJECT_ID);

    expect(result).toBeNull();
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  it('resolveDefaultVersion picks most recently published active version', async () => {
    const wf = await seedWorkflow();
    await svc.getOrCreateDraft(wf._id, TENANT_ID, PROJECT_ID, USER_ID);

    // Create first version and activate
    const v1 = await svc.createVersion({
      workflowId: wf._id,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      createdBy: USER_ID,
    });
    await svc.activate({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: wf._id,
      version: v1.version,
      activatedBy: USER_ID,
    });

    // Create second version and activate
    const v2 = await createUniquePublishedVersion(wf._id);
    await svc.activate({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: wf._id,
      version: v2.version,
      activatedBy: USER_ID,
    });

    // Deactivate v2 — now v1 should be resolved
    await svc.deactivate({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      workflowId: wf._id,
      version: v2.version,
    });

    const resolved = await svc.resolveDefaultVersion(TENANT_ID, PROJECT_ID, wf._id);

    expect(resolved.resolution).toBe('published');
    expect(resolved.version.version).toBe(v1.version);
  });
});
